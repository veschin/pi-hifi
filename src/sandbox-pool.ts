// Admission control over the sandbox. Many work-units want to run cells at once;
// the Scheduler is the gate that stops oversubscription:
//   - cellSem    : at most N cells run concurrently (CPU contention bound);
//   - ramReserve : Σ(running cells' memMax) <= a fraction of host RAM (no OOM storm
//                  on the HOST from too many cells, distinct from each cell's own cap);
//   - gpuSem     : only `gpu` cells take a GPU ticket -> a burst cannot all land on
//                  the GPU.
// Capacity is detected host-agnostically (os.cpus / os.totalmem + an nvidia-smi probe),
// never hardcoded to one machine.

import { spawn } from "node:child_process";
import * as os from "node:os";
import { runCell, type CellEvidence, type CellSpec } from "./sandbox.ts";

/** Counting semaphore: a released permit is handed directly to the next waiter. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(0, Math.floor(permits));
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

export interface SchedulerConfig {
  /** Max concurrent cells. Default: cores - 1 (min 1). */
  maxConcurrent?: number;
  /** Total RAM the running cells may reserve. Default: 0.6 * free host RAM. */
  ramBudgetBytes?: number;
  /** Concurrent GPU cells. Default: 1 if a GPU is detected, else 0. */
  gpuSlots?: number;
}

export interface PoolCapacity {
  cores: number;
  ramBudgetBytes: number;
  gpuSlots: number;
  gpuDetected: boolean;
}

async function probeGpu(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const child = spawn("nvidia-smi", ["-L"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
      });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0 && /GPU \d+:/.test(out)));
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(false);
      }, 4_000).unref();
    } catch {
      finish(false);
    }
  });
}

export async function detectCapacity(): Promise<PoolCapacity> {
  const cores = Math.max(1, os.cpus().length);
  const ramBudgetBytes = Math.floor(os.freemem() * 0.6);
  const gpuDetected = await probeGpu();
  return { cores, ramBudgetBytes, gpuSlots: gpuDetected ? 1 : 0, gpuDetected };
}

export type ScheduledSpec = CellSpec & { gpu?: boolean };

export interface SchedulerStats {
  active: number;
  activeGpu: number;
  ramUsedBytes: number;
  peakActive: number;
  peakGpu: number;
  peakRamBytes: number;
  config: { maxConcurrent: number; ramBudgetBytes: number; gpuSlots: number };
}

export class Scheduler {
  private readonly cellSem: Semaphore;
  private readonly gpuSem: Semaphore;
  private readonly maxConcurrent: number;
  private readonly ramBudget: number;
  private readonly gpuSlots: number;

  private ramUsed = 0;
  private active = 0;
  private activeGpu = 0;
  private peakActive = 0;
  private peakGpu = 0;
  private peakRam = 0;
  private readonly ramWaiters: Array<{ need: number; resolve: () => void }> = [];

  constructor(cap: PoolCapacity, cfg: SchedulerConfig = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(cfg.maxConcurrent ?? cap.cores - 1));
    this.ramBudget = Math.max(1, Math.floor(cfg.ramBudgetBytes ?? cap.ramBudgetBytes));
    this.gpuSlots = Math.max(0, Math.floor(cfg.gpuSlots ?? cap.gpuSlots));
    this.cellSem = new Semaphore(this.maxConcurrent);
    this.gpuSem = new Semaphore(this.gpuSlots);
  }

  stats(): SchedulerStats {
    return {
      active: this.active,
      activeGpu: this.activeGpu,
      ramUsedBytes: this.ramUsed,
      peakActive: this.peakActive,
      peakGpu: this.peakGpu,
      peakRamBytes: this.peakRam,
      config: { maxConcurrent: this.maxConcurrent, ramBudgetBytes: this.ramBudget, gpuSlots: this.gpuSlots },
    };
  }

  private acquireRam(need: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.ramWaiters.push({ need, resolve });
      this.pumpRam();
    });
  }

  /** FIFO: grant head waiters while they fit. Head-of-line blocking is acceptable v1. */
  private pumpRam(): void {
    while (this.ramWaiters.length > 0) {
      const head = this.ramWaiters[0];
      if (head === undefined) break;
      if (this.ramUsed + head.need > this.ramBudget && this.ramUsed > 0) break;
      this.ramWaiters.shift();
      this.ramUsed += head.need;
      if (this.ramUsed > this.peakRam) this.peakRam = this.ramUsed;
      head.resolve();
    }
  }

  private releaseRam(n: number): void {
    this.ramUsed = Math.max(0, this.ramUsed - n);
    this.pumpRam();
  }

  /** Admit and run a cell. Rejects (ran:false) when a request can never fit. */
  async schedule(spec: ScheduledSpec): Promise<CellEvidence> {
    const reject = (reason: string): CellEvidence => ({
      ran: false,
      tier: null,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      oomKilled: false,
      durationMs: 0,
      skippedReason: reason,
    });

    if (spec.gpu && this.gpuSlots === 0) return reject("no GPU available on this host");
    if (spec.limits.memMaxBytes > this.ramBudget) {
      return reject(`cell memMax (${spec.limits.memMaxBytes}) exceeds pool RAM budget (${this.ramBudget})`);
    }

    await this.cellSem.acquire();
    if (spec.gpu) await this.gpuSem.acquire();
    await this.acquireRam(spec.limits.memMaxBytes);

    this.active += 1;
    if (this.active > this.peakActive) this.peakActive = this.active;
    if (spec.gpu) {
      this.activeGpu += 1;
      if (this.activeGpu > this.peakGpu) this.peakGpu = this.activeGpu;
    }
    try {
      return await runCell(spec);
    } finally {
      this.active -= 1;
      if (spec.gpu) this.activeGpu -= 1;
      this.releaseRam(spec.limits.memMaxBytes);
      if (spec.gpu) this.gpuSem.release();
      this.cellSem.release();
    }
  }
}
