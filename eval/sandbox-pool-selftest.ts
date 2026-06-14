// Verifies the Scheduler's admission control by OBSERVING peaks under load:
//   1. concurrency never exceeds maxConcurrent;
//   2. GPU cells never exceed gpuSlots (and are rejected when no GPU);
//   3. RAM reservation never exceeds the budget (a burst of fat cells serializes).
// Needs the rootless sandbox tier (cells actually run); skips otherwise.
//
// Run: npx tsx eval/sandbox-pool-selftest.ts

import { detectSandbox } from "../src/sandbox.ts";
import { Scheduler, detectCapacity, type ScheduledSpec } from "../src/sandbox-pool.ts";

const MB = 1024 * 1024;

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

const sleepCell = (sec: number, mem: number, gpu = false): ScheduledSpec => ({
  argv: ["/bin/sh", "-c", `sleep ${sec}`],
  limits: { memMaxBytes: mem, wallMs: Math.ceil(sec * 1000) + 8_000 },
  ...(gpu ? { gpu: true } : {}),
});

async function main(): Promise<void> {
  if ((await detectSandbox()) !== "rootless") {
    console.log("SKIP: pool selftest needs the rootless sandbox tier.");
    console.log("SANDBOX-POOL-SELFTEST SKIPPED");
    return;
  }
  const cap = await detectCapacity();
  console.log(`[pool] capacity: cores=${cap.cores} ramBudget=${(cap.ramBudgetBytes / MB).toFixed(0)}MB gpu=${cap.gpuDetected}`);
  const results: boolean[] = [];

  // 1. concurrency cap = 2 over 6 cells.
  {
    const sched = new Scheduler(cap, { maxConcurrent: 2, ramBudgetBytes: 4096 * MB, gpuSlots: 0 });
    const runs = Array.from({ length: 6 }, () => sched.schedule(sleepCell(0.4, 32 * MB)));
    await Promise.all(runs);
    const s = sched.stats();
    results.push(line("concurrency <= maxConcurrent(2)", s.peakActive <= 2 && s.peakActive >= 1, `peakActive=${s.peakActive}`));
  }

  // 2. RAM admission: budget 150MB, four 100MB cells -> at most one runs at a time.
  {
    const sched = new Scheduler(cap, { maxConcurrent: 8, ramBudgetBytes: 150 * MB, gpuSlots: 0 });
    const runs = Array.from({ length: 4 }, () => sched.schedule(sleepCell(0.4, 100 * MB)));
    await Promise.all(runs);
    const s = sched.stats();
    results.push(
      line(
        "RAM reservation <= budget",
        s.peakActive <= 1 && s.peakRamBytes <= 150 * MB,
        `peakActive=${s.peakActive} peakRam=${(s.peakRamBytes / MB).toFixed(0)}MB`,
      ),
    );
  }

  // 3a. cell larger than the whole budget is rejected (never runs).
  {
    const sched = new Scheduler(cap, { maxConcurrent: 2, ramBudgetBytes: 64 * MB, gpuSlots: 0 });
    const ev = await sched.schedule(sleepCell(0.1, 128 * MB));
    results.push(line("oversized cell rejected", !ev.ran && /exceeds pool RAM budget/.test(ev.skippedReason ?? ""), ev.skippedReason ?? "(ran - BAD)"));
  }

  // 3b. GPU admission: gpuSlots=1 over 3 gpu cells -> gpu concurrency <= 1.
  {
    const sched = new Scheduler(cap, { maxConcurrent: 8, ramBudgetBytes: 4096 * MB, gpuSlots: 1 });
    const runs = Array.from({ length: 3 }, () => sched.schedule(sleepCell(0.3, 32 * MB, true)));
    await Promise.all(runs);
    const s = sched.stats();
    results.push(line("GPU concurrency <= gpuSlots(1)", s.peakGpu <= 1, `peakGpu=${s.peakGpu}`));
  }

  // 3c. gpu cell rejected when host has no GPU slots.
  {
    const sched = new Scheduler(cap, { maxConcurrent: 2, ramBudgetBytes: 4096 * MB, gpuSlots: 0 });
    const ev = await sched.schedule(sleepCell(0.1, 32 * MB, true));
    results.push(line("gpu cell rejected without GPU", !ev.ran && /no GPU/.test(ev.skippedReason ?? ""), ev.skippedReason ?? "(ran - BAD)"));
  }

  const passed = results.every(Boolean);
  console.log(passed ? "SANDBOX-POOL-SELFTEST PASSED: admission control holds" : "SANDBOX-POOL-SELFTEST FAILED");
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("pool selftest crashed:", err);
  process.exitCode = 1;
});
