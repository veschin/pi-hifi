// Smoke: stack-agnostic generation end-to-end (3.5). A PYTHON task, with polyglot
// on (default), must produce a `python` solution block AND have its python
// selftest EXECUTED in the sandbox - proving the generator is no longer forced to
// JS and the runner runs the emitted language. Cheap: flash, rounds=1,
// candidates=1, triage/brief/context/delivery off. Needs the rootless tier (else
// exec is admission-gated off and the "ran" assertion cannot hold).
//
// Usage: npx tsx eval/smoke-polyglot.ts

import { loadConfig } from "../src/config.ts";
import { runHifi } from "../src/pipeline.ts";
import { detectSandbox } from "../src/sandbox.ts";
import { createStandaloneRegistry } from "./standalone.ts";

const TASK =
  "Write a Python function `is_palindrome(s)` that returns True iff the string s " +
  "reads the same forwards and backwards, ignoring case and all non-alphanumeric " +
  "characters. Provide a `python solution` block and a `python selftest` block " +
  "that imports solution and exits non-zero on any failed check.";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

async function main(): Promise<void> {
  if ((await detectSandbox()) !== "rootless") {
    console.log("SKIP: smoke-polyglot needs the rootless sandbox tier to execute the python selftest.");
    console.log("SMOKE-POLYGLOT SKIPPED");
    return;
  }

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
    APODEX_MAX_SUBCALLS: "15",
    APODEX_MAX_COST_USD: "0.5",
    APODEX_MAX_WALL_TIME_MS: "180000",
  };
  const { config, warnings } = loadConfig({ cwd: process.cwd(), env, overrides: { rounds: 1, candidates: 1 } });
  console.log(`[polyglot] config.polyglot = ${config.polyglot}`);

  const registry = createStandaloneRegistry();
  const result = await runHifi({
    config,
    configWarnings: warnings,
    registry,
    task: TASK,
    mode: "code",
    cwd: process.cwd(),
    onProgress: (m) => console.error(`[polyglot] ${m}`),
  });

  const results: boolean[] = [];
  results.push(line("python solution block generated", /```python\s+solution/.test(result.finalAnswer), result.finalAnswer.match(/```(\w+)\s+solution/)?.[0] ?? "(no solution block)"));
  const ev = result.gvr?.best.execEvidence ?? null;
  results.push(line("python selftest EXECUTED in the sandbox", ev?.ran === true, `ran=${ev?.ran ?? "n/a"} exit=${ev?.exitCode ?? "n/a"}`));
  results.push(line("selftest passed (exit 0)", ev?.ran === true && ev.exitCode === 0, `exit=${ev?.exitCode ?? "n/a"}`));
  console.log(`[polyglot] spent ${result.budget.subCalls} calls, $${result.budget.costUsd.toFixed(4)}`);

  // Hard requirement: generation + execution of a non-JS language. The "passed"
  // line is informative (the model's selftest may have a bug); ran===true is the
  // load-bearing proof that the pipeline is stack-agnostic.
  const ok = results[0] === true && results[1] === true;
  console.log(`\n${ok ? "SMOKE-POLYGLOT PASSED" : "SMOKE-POLYGLOT FAILED"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("smoke-polyglot crashed:", err);
  process.exit(1);
});
