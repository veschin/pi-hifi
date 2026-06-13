// Stack-agnostic execution cell: wrap ANY argv in a resource-limited,
// fs-confined, no-net sandbox. The cell is language-blind - node / python / go /
// browser / `sh -c "<cmd>"` all run identically; nothing is special about node.
//
// In the `rootless` (and future `docker`) tier the containment is KERNEL-enforced:
// a runaway cannot grep the host (no host FS mount), exhaust RAM (cgroup
// MemoryMax -> OOM-kill), fill the host disk (/work and /tmp are size-bounded
// tmpfs, RAM-backed and counted against MemoryMax), fork-bomb (TasksMax), reach
// the network (namespace unshared), or run forever (wall timeout).
//
// The `degraded` tier has NO boundary (prlimit only). runCell REFUSES to run
// `untrusted` work in degraded - it never pretends to contain what it cannot.
//
// Backends, by detected capability (preference order):
//   rootless  - systemd-run --user --scope (cgroup) + bwrap (namespaces). Rootless.
//   docker    - native --memory/--cpus/--pids-limit/--network. Warm pool. SLICE 2.
//   degraded  - prlimit + timeout only. Refuses untrusted work.
//
// Capability is DETECTED by actually running a probe cell, never assumed.
// eval/sandbox-selftest.ts codifies the OOM-kill / confinement / disk / net tests.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_OUTPUT_CAP = 64 * 1024;
const DEFAULT_DISK_MAX = 256 * 1024 * 1024;
const SIGKILL_GRACE_MS = 2_000;

export type SandboxTier = "rootless" | "docker" | "degraded";

export interface CellLimits {
  /** Hard memory cap; the cgroup OOM-kills the cell past it. tmpfs counts here. */
  memMaxBytes: number;
  /** Writable /work tmpfs size cap (RAM-backed; also bounded by memMaxBytes). */
  diskMaxBytes?: number;
  /** CPU quota as a percentage of one core (100 = one full core). */
  cpuQuotaPct?: number;
  /** Max processes/threads (fork-bomb guard). */
  pidsMax?: number;
  /** Wall-clock kill. */
  wallMs: number;
  /** stdout/stderr byte cap (each). */
  outputCapBytes?: number;
}

export interface CellSpec {
  /** Any command. The cell does not care what language it is. */
  argv: string[];
  /** Files materialized into the cell's writable workdir (/work) before run. */
  files?: Record<string, string>;
  limits: CellLimits;
  /** Network access; defaults to "none". */
  net?: "none" | "host";
  /** Extra host directories exposed read-only (absolute, non-secret; validated). */
  roBinds?: string[];
  /**
   * Whether the argv is untrusted (model-authored). DEFAULT true. Untrusted work
   * runs ONLY in a tier with a real boundary; in `degraded` it is refused.
   */
  untrusted?: boolean;
}

export interface CellEvidence {
  ran: boolean;
  tier: SandboxTier | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * HEURISTIC, trustworthy only for non-adversarial payloads: an adversarial
   * argv can `exit 137` to forge this. For adversarial evidence read the cell's
   * cgroup memory.events oom_kill (TODO, next slice). Not load-bearing yet.
   */
  oomKilled: boolean;
  durationMs: number;
  /** Set when the cell did not run (no boundary, bad input, write/spawn failure). */
  skippedReason?: string;
}

interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Run a command with a hard wall timeout (SIGTERM then SIGKILL) and capped output. */
function spawnCapped(cmd: string, args: string[], wallMs: number, cap: number): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, SIGKILL_GRACE_MS);
      sigkillTimer.unref();
    }, wallMs);

    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < cap * 2) stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < cap * 2) stderr += c.toString();
    });

    const settle = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve(r);
    };

    child.on("error", (err) => {
      settle({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on("close", (code, signal) => {
      settle({ exitCode: code, signal: signal ?? null, stdout, stderr, timedOut });
    });
  });
}

function capStr(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}\n...[truncated at ${cap}B]`;
}

/** Reject read-only binds that would leak host secrets into the cell. */
const ROBIND_DENY = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", ".npmrc", "shadow", ".git-credentials"];

function validateRoBinds(roBinds: string[]): string | null {
  const home = os.homedir();
  for (const b of roBinds) {
    if (!path.isAbsolute(b)) return `roBind must be absolute: ${b}`;
    const norm = path.normalize(b);
    if (norm === "/" || norm === home) return `roBind too broad (host root / home): ${b}`;
    if (norm.startsWith(`${home}${path.sep}`)) return `roBind under $HOME (likely secrets): ${b}`;
    if (ROBIND_DENY.some((d) => norm.includes(d))) return `roBind hits a denied secret path: ${b}`;
  }
  return null;
}

/** bwrap isolation: ro minimal runtime, SIZE-BOUNDED tmpfs /work + /tmp, namespaced. */
function bwrapArgs(stagingDir: string, diskMaxBytes: number, net: "none" | "host", roBinds: string[]): string[] {
  const a = [
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // Writable scratch is a SIZE-BOUNDED tmpfs (RAM-backed, also under MemoryMax),
    // so a cell cannot fill the host disk. --size applies to the next --tmpfs.
    "--size", String(Math.floor(diskMaxBytes)), "--tmpfs", "/work",
    // Inputs arrive read-only and get copied into /work by the run wrapper.
    "--ro-bind", stagingDir, "/staging",
    "--chdir", "/work",
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
  ];
  if (net === "none") a.push("--unshare-net");
  for (const b of roBinds) a.push("--ro-bind", b, b);
  return a;
}

function scopeArgs(limits: CellLimits): string[] {
  const a = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "-p", `MemoryMax=${Math.floor(limits.memMaxBytes)}`,
    "-p", "MemorySwapMax=0",
  ];
  if (limits.cpuQuotaPct !== undefined) a.push("-p", `CPUQuota=${Math.floor(limits.cpuQuotaPct)}%`);
  if (limits.pidsMax !== undefined) a.push("-p", `TasksMax=${Math.floor(limits.pidsMax)}`);
  return a;
}

let cachedTier: SandboxTier | null = null;

/** Test hook: force the detected tier (and bypass the probe). */
export function __setSandboxTier(t: SandboxTier | null): void {
  cachedTier = t;
}

/**
 * Detect the strongest available backend by actually running a probe cell -
 * never assume. Cached for the process lifetime.
 */
export async function detectSandbox(force = false): Promise<SandboxTier> {
  if (cachedTier !== null && !force) return cachedTier;

  const hasBwrap = (await spawnCapped("bwrap", ["--version"], 5_000, 1_024)).exitCode === 0;
  if (hasBwrap) {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "apodex-detect-"));
    try {
      const probe = await spawnCapped(
        "systemd-run",
        [
          ...scopeArgs({ memMaxBytes: 64 * 1024 * 1024, wallMs: 5_000 }),
          "--",
          "bwrap",
          ...bwrapArgs(wd, 16 * 1024 * 1024, "none", []),
          "--",
          "/bin/true",
        ],
        8_000,
        1_024,
      );
      if (probe.exitCode === 0) {
        cachedTier = "rootless";
        return cachedTier;
      }
    } finally {
      try {
        fs.rmSync(wd, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  cachedTier = "degraded";
  return cachedTier;
}

function writeFiles(dir: string, files: Record<string, string>): string | null {
  for (const name of Object.keys(files)) {
    if (name.includes("..") || path.isAbsolute(name)) return `unsafe file name: ${name}`;
  }
  for (const [name, contents] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents, "utf8");
  }
  return null;
}

// Copy staged inputs into the writable /work tmpfs, then exec the real argv
// (passed as positional params so no quoting/injection through the shell).
const COPY_THEN_EXEC = 'cp -a /staging/. /work/ 2>/dev/null || true; exec "$@"';

/**
 * Run an argv inside a resource-limited, isolated cell. Never throws on a cell
 * fault - returns CellEvidence with ran:false + skippedReason. Untrusted work is
 * REFUSED on the degraded tier (no boundary) rather than run with false safety.
 */
export async function runCell(spec: CellSpec): Promise<CellEvidence> {
  const cap = spec.limits.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  const diskMax = spec.limits.diskMaxBytes ?? DEFAULT_DISK_MAX;
  const net = spec.net ?? "none";
  const untrusted = spec.untrusted ?? true;
  const tier = await detectSandbox();

  const base: Omit<CellEvidence, "tier"> = {
    ran: false,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    oomKilled: false,
    durationMs: 0,
  };
  if (spec.argv.length === 0) return { ...base, tier, skippedReason: "empty argv" };

  // No boundary available: refuse untrusted work instead of faking containment.
  if (tier === "degraded" && untrusted) {
    return {
      ...base,
      tier,
      skippedReason: "degraded tier has no isolation boundary; refusing untrusted work (set untrusted:false to force)",
    };
  }

  const roErr = validateRoBinds(spec.roBinds ?? []);
  if (roErr) return { ...base, tier, skippedReason: roErr };

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "apodex-cell-"));
  } catch (err) {
    return { ...base, tier, skippedReason: `workdir creation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const t0 = Date.now();
  try {
    const writeErr = writeFiles(dir, spec.files ?? {});
    if (writeErr) return { ...base, tier, durationMs: Date.now() - t0, skippedReason: writeErr };

    let cmd: string;
    let args: string[];
    if (tier === "rootless") {
      cmd = "systemd-run";
      args = [
        ...scopeArgs(spec.limits),
        "--",
        "bwrap",
        ...bwrapArgs(dir, diskMax, net, spec.roBinds ?? []),
        "--",
        "/bin/sh",
        "-c",
        COPY_THEN_EXEC,
        "apodex-cell",
        ...spec.argv,
      ];
    } else {
      // degraded (trusted only): address-space cap, files in the host workdir.
      cmd = "prlimit";
      args = [`--as=${Math.floor(spec.limits.memMaxBytes)}`, "--", "/bin/sh", "-c", 'cd "$1"; shift; exec "$@"', "_", dir, ...spec.argv];
    }

    const r = await spawnCapped(cmd, args, spec.limits.wallMs, cap);
    const durationMs = Date.now() - t0;
    if (r.spawnError) return { ...base, tier, durationMs, skippedReason: `spawn failed: ${r.spawnError}` };

    const oomKilled = !r.timedOut && (r.exitCode === 137 || r.signal === "SIGKILL");
    return {
      ran: true,
      tier,
      exitCode: r.exitCode,
      signal: r.signal,
      stdout: capStr(r.stdout, cap),
      stderr: capStr(r.stderr, cap),
      timedOut: r.timedOut,
      oomKilled,
      durationMs,
    };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
