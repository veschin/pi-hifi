// Free (no-LLM) check that the product exec path - runCandidateSelfTest, used by
// selector/gvr/pipeline - is stack-agnostic and produces correct ExecEvidence
// through the sandbox. Pairs with selfcheck (which exercises runNodeScript via
// the scorer) to verify the whole exec integration without spending on a model.
//
// Run: npx tsx eval/exec-selftest.ts

import { runCandidateSelfTest } from "../src/exec.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

const nodePass = '```js solution\nexport const f = (a, b) => a + b;\n```\n```js selftest\nimport { f } from "./solution.mjs";\nif (f(2, 3) !== 5) process.exit(1);\nconsole.log("ok");\n```';
const nodeFail = nodePass.replace("a + b", "a + b + 1");
const pyPass = '```python solution\ndef f(a, b):\n    return a + b\n```\n```python selftest\nimport solution\nassert solution.f(2, 3) == 5\nprint("ok")\n```';
const noBlocks = "Here is a Three.js scene in a single HTML file: <html>...</html> (no selftest block)";

async function main(): Promise<void> {
  const results: boolean[] = [];

  const np = await runCandidateSelfTest(nodePass, 15_000);
  results.push(line("node selftest PASS -> ran, exit 0", np.ran && np.exitCode === 0, `ran=${np.ran} exit=${np.exitCode}`));

  const nf = await runCandidateSelfTest(nodeFail, 15_000);
  results.push(line("node selftest FAIL -> ran, exit != 0", nf.ran && nf.exitCode !== 0 && !nf.timedOut, `ran=${nf.ran} exit=${nf.exitCode}`));

  const pp = await runCandidateSelfTest(pyPass, 15_000);
  results.push(line("python selftest PASS -> ran, exit 0", pp.ran && pp.exitCode === 0, `ran=${pp.ran} exit=${pp.exitCode}`));

  const nb = await runCandidateSelfTest(noBlocks, 15_000);
  results.push(line("no selftest block -> not run, reason given", !nb.ran && (nb.skippedReason ?? "") !== "", nb.skippedReason ?? "(no reason)"));

  const passed = results.every(Boolean);
  console.log(passed ? "EXEC-SELFTEST PASSED: product exec path is sandboxed + stack-agnostic" : "EXEC-SELFTEST FAILED");
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("exec-selftest crashed:", err);
  process.exitCode = 1;
});
