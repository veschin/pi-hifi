// Smoke: the sandbox admission gate in the LIVE pipeline. The tier is forced to
// "degraded" (via the __setSandboxTier test hook, so no tier-less host is
// needed). Two arms:
//   allowUnsandboxed=false -> self-tests DISABLED (warning, answer still ships);
//   allowUnsandboxed=true  -> candidate code runs on the BARE HOST (loud
//                             SECURITY warning).
// The candidate code here is a trusted one-liner (sum), so the bare-host arm is
// safe to run. Cheap: flash, rounds=1, candidates=1, triage/brief/context off.
//
// Usage: npx tsx eval/exec-gate-smoke.ts

import { loadConfig } from "../src/config.ts";
import { runApodex } from "../src/pipeline.ts";
import { __setSandboxTier } from "../src/sandbox.ts";
import { createStandaloneRegistry } from "./standalone.ts";

const TASK =
  "Write a JavaScript (ESM) function `sum(a, b)` that returns a + b. Provide a " +
  "`js solution` block and a `js selftest` block that imports ./solution.mjs and " +
  "exits non-zero on failure.";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

async function arm(allowUnsandboxed: boolean): Promise<{ warnings: string[]; answerLen: number }> {
  const env = {
    ...process.env,
    APODEX_GENERATOR: "deepseek/deepseek-v4-flash",
    APODEX_GRADER: "deepseek/deepseek-v4-flash",
    APODEX_VERIFIER: "deepseek/deepseek-v4-flash",
    APODEX_WORKER: "deepseek/deepseek-v4-flash",
    APODEX_JUDGE: "deepseek/deepseek-v4-flash",
    APODEX_TRIAGE_ENABLED: "0",
    APODEX_BRIEF_ENABLED: "0",
    APODEX_CONTEXT_ENABLED: "0",
    APODEX_DELIVERY_PLAN: "0",
    APODEX_EXEC_ALLOW_UNSANDBOXED: allowUnsandboxed ? "1" : "0",
    APODEX_MAX_SUBCALLS: "15",
    APODEX_MAX_COST_USD: "0.5",
    APODEX_MAX_WALL_TIME_MS: "180000",
  };
  const { config, warnings } = loadConfig({ cwd: process.cwd(), env, overrides: { rounds: 1, candidates: 1 } });
  const registry = createStandaloneRegistry();
  __setSandboxTier("degraded"); // force the no-tier path for this arm
  try {
    const r = await runApodex({
      config,
      configWarnings: warnings,
      registry,
      task: TASK,
      mode: "code", // explicit -> skip the mode classifier call
      cwd: process.cwd(),
      onProgress: (m) => console.error(`[allow=${allowUnsandboxed}] ${m}`),
    });
    return { warnings: r.warnings, answerLen: r.finalAnswer.length };
  } finally {
    __setSandboxTier(null); // reset so a later detect re-probes the real host
  }
}

async function main(): Promise<void> {
  // __setSandboxTier is a guarded test-only hook; authorize it for this smoke.
  process.env.APODEX_TEST_HOOKS = "1";
  const results: boolean[] = [];

  console.log("== arm: allowUnsandboxed=false (must DISABLE exec) ==");
  const off = await arm(false);
  results.push(
    line(
      "gate off: self-tests disabled + warned",
      off.warnings.some((w) => /DISABLED/.test(w) && /no sandbox tier/.test(w)),
      off.warnings.find((w) => /DISABLED/.test(w)) ?? "(no DISABLED warning)",
    ),
  );
  results.push(line("gate off: answer still ships", off.answerLen > 0, `answerLen=${off.answerLen}`));

  console.log("== arm: allowUnsandboxed=true (must WARN, run bare-host) ==");
  const on = await arm(true);
  results.push(
    line(
      "gate on: loud unsandboxed warning",
      on.warnings.some((w) => /UNSANDBOXED/.test(w)),
      on.warnings.find((w) => /UNSANDBOXED/.test(w)) ?? "(no UNSANDBOXED warning)",
    ),
  );
  results.push(line("gate on: answer produced", on.answerLen > 0, `answerLen=${on.answerLen}`));

  const ok = results.every(Boolean);
  console.log(`\n${ok ? "EXEC-GATE-SMOKE PASSED" : "EXEC-GATE-SMOKE FAILED"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("exec-gate-smoke crashed:", err);
  process.exit(1);
});
