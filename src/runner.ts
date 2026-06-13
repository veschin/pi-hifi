// Stack-agnostic experiment runner: turn a language-tagged solution+selftest into
// an observed pass/fail by running it in the sandbox. node is NOT special - it is
// one entry in LANG_RUNNERS; adding a language = adding a row (file names + argv),
// no other code changes. This is what stops "stuck with node": the generator may
// emit python / go / whatever, and the runner picks the matching cell command.
//
// Convention (generalizes the legacy ```js solution``` / ```js selftest```):
//   ```<lang> solution     <- the artifact
//   ```<lang> selftest      <- exits 0 on pass, non-zero on fail; imports the solution
// The selftest's exit code is the hard-to-fake evidence the experiment primitive needs.

import type { Scheduler } from "./sandbox-pool.ts";
import type { CellEvidence, CellLimits } from "./sandbox.ts";

interface LangRunner {
  solutionFile: string;
  selftestFile: string;
  argv: string[];
  /** How the selftest imports the solution (for the prompt / docs). */
  importHint: string;
}

const CANON: Record<string, string> = {
  js: "node",
  javascript: "node",
  mjs: "node",
  node: "node",
  py: "python",
  python: "python",
  python3: "python",
};

const LANG_RUNNERS: Record<string, LangRunner> = {
  node: {
    solutionFile: "solution.mjs",
    selftestFile: "selftest.mjs",
    argv: ["node", "selftest.mjs"],
    importHint: 'import { ... } from "./solution.mjs"',
  },
  python: {
    solutionFile: "solution.py",
    selftestFile: "selftest.py",
    argv: ["python3", "selftest.py"],
    importHint: "import solution",
  },
};

export function supportedLanguages(): string[] {
  return Object.keys(LANG_RUNNERS);
}

/**
 * Per-language guidance for the generator prompt, DERIVED from LANG_RUNNERS so
 * the prompt can never drift from the actual runners (adding a row below is the
 * only change needed - the prompt updates itself).
 */
export function runnerHints(): string {
  return Object.entries(LANG_RUNNERS)
    .map(([lang, r]) => `${lang} (selftest: ${r.importHint}; runs \`${r.argv.join(" ")}\`)`)
    .join("; ");
}

export interface ParsedExperiment {
  lang: string;
  runner: LangRunner;
  solution: string;
  selftest: string;
}

function blockRe(kind: "solution" | "selftest"): RegExp {
  return new RegExp("```([a-zA-Z0-9+]+)\\s+" + kind + "\\s*\\n([\\s\\S]*?)```");
}

/**
 * Parse a language-tagged solution+selftest pair. Returns a reason string when
 * the answer does not carry a runnable experiment (no blocks, mismatched or
 * unsupported language) - the caller surfaces it as "not executed".
 */
export function parseExperiment(answer: string): ParsedExperiment | { error: string } {
  const sol = blockRe("solution").exec(answer);
  const sel = blockRe("selftest").exec(answer);
  if (!sol) return { error: "no `<lang> solution` block" };
  if (!sel) return { error: "no `<lang> selftest` block" };
  const solLang = CANON[sol[1]!.toLowerCase()];
  const selLang = CANON[sel[1]!.toLowerCase()];
  if (!solLang) return { error: `unsupported solution language: ${sol[1]}` };
  if (solLang !== selLang) return { error: `solution/selftest language mismatch: ${sol[1]} vs ${sel[1]}` };
  const runner = LANG_RUNNERS[solLang]!;
  return { lang: solLang, runner, solution: sol[2]!, selftest: sel[2]! };
}

export interface ExperimentResult {
  /** Parsed language, or null when no runnable experiment was found. */
  lang: string | null;
  /** True only when the cell ran AND the selftest exited 0 (and did not time out). */
  passed: boolean;
  evidence: CellEvidence | null;
  /** Why no experiment ran (parse failure, sandbox refusal, ...). */
  skippedReason?: string;
}

const DEFAULT_LIMITS: CellLimits = { memMaxBytes: 512 * 1024 * 1024, wallMs: 20_000 };

/**
 * Run a candidate's selftest in the sandbox and report observed pass/fail. The
 * deliverable (code) is NEVER gated on this: a parse failure or an
 * unsupported/absent runner returns passed:false with a reason, so the caller
 * can still ship the artifact flagged "not executed".
 */
export async function runExperiment(
  answer: string,
  scheduler: Scheduler,
  limits: Partial<CellLimits> = {},
): Promise<ExperimentResult> {
  const parsed = parseExperiment(answer);
  if ("error" in parsed) return { lang: null, passed: false, evidence: null, skippedReason: parsed.error };

  const files: Record<string, string> = {
    [parsed.runner.solutionFile]: parsed.solution,
    [parsed.runner.selftestFile]: parsed.selftest,
  };
  const evidence = await scheduler.schedule({
    argv: parsed.runner.argv,
    files,
    limits: { ...DEFAULT_LIMITS, ...limits },
  });
  const passed = evidence.ran && !evidence.timedOut && evidence.exitCode === 0;
  return {
    lang: parsed.lang,
    passed,
    evidence,
    ...(evidence.ran ? {} : { skippedReason: evidence.skippedReason ?? "cell did not run" }),
  };
}
