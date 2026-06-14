// Proves the stack-agnostic runner end-to-end through the sandbox: a node AND a
// python experiment, each in a PASS and a FAIL variant, produce the correct
// observed verdict. This is the "not stuck with node" claim, demonstrated.
//
// Run: npx tsx eval/runner-selftest.ts

import { detectSandbox } from "../src/sandbox.ts";
import { Scheduler, detectCapacity } from "../src/sandbox-pool.ts";
import { runExperiment, supportedLanguages } from "../src/runner.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

const nodePass = [
  "```js solution",
  "export function add(a, b) { return a + b; }",
  "```",
  "```js selftest",
  'import { add } from "./solution.mjs";',
  'if (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }',
  'console.log("ok");',
  "```",
].join("\n");

const nodeFail = nodePass.replace("return a + b;", "return a + b + 1;"); // off-by-one -> selftest fails

const pyPass = [
  "```python solution",
  "def add(a, b):",
  "    return a + b",
  "```",
  "```python selftest",
  "import solution",
  "assert solution.add(2, 3) == 5",
  'print("ok")',
  "```",
].join("\n");

const pyFail = pyPass.replace("return a + b", "return a + b + 1");

async function main(): Promise<void> {
  if ((await detectSandbox()) !== "rootless") {
    console.log("SKIP: runner selftest needs the rootless sandbox tier.");
    console.log("RUNNER-SELFTEST SKIPPED");
    return;
  }
  console.log(`[runner] supported languages: ${supportedLanguages().join(", ")}`);
  const sched = new Scheduler(await detectCapacity());
  const results: boolean[] = [];

  const cases: Array<[string, string, boolean]> = [
    ["node PASS -> passed", nodePass, true],
    ["node FAIL -> not passed", nodeFail, false],
    ["python PASS -> passed", pyPass, true],
    ["python FAIL -> not passed", pyFail, false],
  ];
  for (const [label, answer, expectPass] of cases) {
    const r = await runExperiment(answer, sched);
    results.push(
      line(label, r.passed === expectPass, `lang=${r.lang} passed=${r.passed} exit=${r.evidence?.exitCode ?? "n/a"}`),
    );
  }

  // unsupported language -> graceful skip, never a crash, never a false pass.
  const goAnswer = "```go solution\npackage main\n```\n```go selftest\npackage main\n```";
  const goRes = await runExperiment(goAnswer, sched);
  results.push(
    line("unsupported lang -> skip not pass", !goRes.passed && /unsupported/.test(goRes.skippedReason ?? ""), goRes.skippedReason ?? "?"),
  );

  const passed = results.every(Boolean);
  console.log(passed ? "RUNNER-SELFTEST PASSED: stack-agnostic execution holds" : "RUNNER-SELFTEST FAILED");
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("runner selftest crashed:", err);
  process.exitCode = 1;
});
