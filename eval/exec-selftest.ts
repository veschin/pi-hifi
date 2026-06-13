// Free (no-LLM) check that the product exec path - runCandidateSelfTest, used by
// selector/gvr/pipeline - is stack-agnostic and produces correct ExecEvidence
// through the sandbox. Pairs with selfcheck (which exercises runNodeScript via
// the scorer) to verify the whole exec integration without spending on a model.
//
// Run: npx tsx eval/exec-selftest.ts

import { runCandidateSelfTest } from "../src/exec.ts";
import { execAdmission, __setSandboxTier } from "../src/sandbox.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";

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

  // --- Pure security gate (execAdmission): no host tier needed. ---
  results.push(
    line(
      "admission rootless/docker -> sandbox",
      execAdmission("rootless", true) === "sandbox" &&
        execAdmission("rootless", false) === "sandbox" &&
        execAdmission("docker", false) === "sandbox",
      "a real tier ignores the opt-in",
    ),
  );
  results.push(
    line("admission degraded + opt-in -> bare-host", execAdmission("degraded", true) === "bare-host", "explicit opt-in runs unsandboxed"),
  );
  results.push(
    line("admission degraded - opt-in -> disabled", execAdmission("degraded", false) === "disabled", "no opt-in refuses untrusted code"),
  );

  // --- config.exec.allowUnsandboxed: default OFF (fail-closed), env toggles. ---
  {
    const def = defaultConfig().exec.allowUnsandboxed;
    const off = loadConfig({ cwd: process.cwd(), env: { APODEX_EXEC_ALLOW_UNSANDBOXED: "0" } }).config.exec.allowUnsandboxed;
    const on = loadConfig({ cwd: process.cwd(), env: { APODEX_EXEC_ALLOW_UNSANDBOXED: "1" } }).config.exec.allowUnsandboxed;
    results.push(
      line("config.exec.allowUnsandboxed default off / env toggles", def === false && off === false && on === true, `default=${def} off=${off} on=${on}`),
    );
  }

  const np = await runCandidateSelfTest(nodePass, 15_000);
  results.push(line("node selftest PASS -> ran, exit 0", np.ran && np.exitCode === 0, `ran=${np.ran} exit=${np.exitCode}`));

  const nf = await runCandidateSelfTest(nodeFail, 15_000);
  results.push(line("node selftest FAIL -> ran, exit != 0", nf.ran && nf.exitCode !== 0 && !nf.timedOut, `ran=${nf.ran} exit=${nf.exitCode}`));

  const pp = await runCandidateSelfTest(pyPass, 15_000);
  results.push(line("python selftest PASS -> ran, exit 0", pp.ran && pp.exitCode === 0, `ran=${pp.ran} exit=${pp.exitCode}`));

  const nb = await runCandidateSelfTest(noBlocks, 15_000);
  results.push(line("no selftest block -> not run, reason given", !nb.ran && (nb.skippedReason ?? "") !== "", nb.skippedReason ?? "(no reason)"));

  // __setSandboxTier is a guarded test-only hook: it must REFUSE without the env
  // opt-in (so it cannot flip the security boundary in a normal embed) and work
  // with it. Run LAST so its cache mutation cannot affect the exec checks above.
  {
    let threwWithout = false;
    try {
      __setSandboxTier(null);
    } catch {
      threwWithout = true;
    }
    process.env.APODEX_TEST_HOOKS = "1";
    let workedWith = true;
    try {
      __setSandboxTier(null);
    } catch {
      workedWith = false;
    }
    delete process.env.APODEX_TEST_HOOKS;
    results.push(
      line(
        "__setSandboxTier guarded (throws without APODEX_TEST_HOOKS)",
        threwWithout && workedWith,
        `without=${threwWithout ? "threw" : "RAN(bad)"} with=${workedWith ? "ran" : "threw(bad)"}`,
      ),
    );
  }

  const passed = results.every(Boolean);
  console.log(passed ? "EXEC-SELFTEST PASSED: product exec path is sandboxed + stack-agnostic" : "EXEC-SELFTEST FAILED");
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("exec-selftest crashed:", err);
  process.exitCode = 1;
});
