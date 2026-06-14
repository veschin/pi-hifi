// Parity measurement: the COMPOSER path (runComposerHifi) vs the LINEAR path
// (runHifi) on the SAME objective tasks with the SAME pinned config + models, so
// the only variable is the execution path. Scores both with each task's own
// programmatic check. The question: does the cheaper, gate-grounded composer
// MATCH the expensive linear pipeline (select + GVR rounds + verify + assemble)?
//
// Paid. Defaults to the objective code tasks (deterministic hidden tests).
// Usage:
//   npx tsx eval/compare-composer.ts                 # all code tasks
//   npx tsx eval/compare-composer.ts --only intervals
//   npx tsx eval/compare-composer.ts --candidates 2 --rounds 2

import * as fs from "node:fs";
import * as path from "node:path";
import { Budget } from "../src/budget.ts";
import { runComposerHifi } from "../src/composer-pipeline.ts";
import { loadConfig } from "../src/config.ts";
import { SubCallClient } from "../src/llm.ts";
import { runHifi } from "../src/pipeline.ts";
import { RoleResolver } from "../src/roles.ts";
import { RunStore } from "../src/store.ts";
import type { HifiConfig } from "../src/types.ts";
import { createStandaloneRegistry } from "./standalone.ts";
import { codeTasks } from "./tasks/code.ts";
import type { EvalTask, TaskScore } from "./types.ts";

interface ArmRun {
  answer: string;
  score: TaskScore;
  subCalls: number;
  costUsd: number;
  wallMs: number;
  error?: string;
}

/** Both arms share this config: every comparability knob pinned identically, so
 *  the only difference is runHifi (linear) vs runComposerHifi (composer). */
function sharedConfig(rounds: number, candidates: number): { config: HifiConfig; warnings: string[] } {
  const heavy = "deepseek/deepseek-v4-pro";
  const { config, warnings } = loadConfig({
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIFI_GENERATOR: process.env.HIFI_GENERATOR ?? heavy,
      HIFI_GRADER: process.env.HIFI_GRADER ?? heavy,
      HIFI_VERIFIER: process.env.HIFI_VERIFIER ?? heavy,
      HIFI_ANALYST: process.env.HIFI_ANALYST ?? heavy,
      HIFI_JUDGE: process.env.HIFI_JUDGE ?? heavy,
      HIFI_WORKER: process.env.HIFI_WORKER ?? "deepseek/deepseek-v4-flash",
    },
    overrides: { rounds, candidates },
  });
  // Front pins identical for both arms (isolate the execution path). Triage OFF:
  // the composer falls back to a default composition; the linear path ignores it.
  config.triage.enabled = false;
  config.brief.enabled = false;
  config.context.enabled = false;
  config.delivery.planEnabled = false;
  config.polyglot = false;
  config.budget.maxWallTimeMs = Math.min(config.budget.maxWallTimeMs, 20 * 60_000);
  config.budget.maxCostUsd = Math.min(config.budget.maxCostUsd, 3);
  return { config, warnings };
}

async function scoreAnswer(task: EvalTask, answer: string, config: HifiConfig, registry: ReturnType<typeof createStandaloneRegistry>, runsDir: string, arm: string): Promise<TaskScore> {
  if (answer.trim() === "") return { score: 0, detail: "empty answer (arm failed)" };
  const store = new RunStore(runsDir, RunStore.newRunId(`score-${arm}-${task.id}`), () => {});
  const budget = new Budget({ ...config.budget, maxSubCalls: 30, maxCostUsd: 0.5 });
  const resolver = new RoleResolver({ config, registry });
  const client = new SubCallClient({ resolver, budget, store, timeoutMs: 120_000, maxRetries: 2 });
  return task.score(answer, { client, execTimeoutMs: 30_000 });
}

async function runArm(
  which: "linear" | "composer",
  task: EvalTask,
  config: HifiConfig,
  warnings: string[],
  registry: ReturnType<typeof createStandaloneRegistry>,
  runsDir: string,
): Promise<ArmRun> {
  const t0 = Date.now();
  const armConfig: HifiConfig = { ...config, runsDir, composer: { enabled: which === "composer" } };
  const run = which === "composer" ? runComposerHifi : runHifi;
  try {
    const result = await run({ config: armConfig, configWarnings: warnings, registry, task: task.prompt, mode: "code", cwd: process.cwd(), onProgress: (m) => console.error(`    [${which}:${task.id}] ${m}`) });
    const score = await scoreAnswer(task, result.finalAnswer, config, registry, runsDir, which);
    return { answer: result.finalAnswer, score, subCalls: result.budget.subCalls, costUsd: result.budget.costUsd, wallMs: Date.now() - t0 };
  } catch (err) {
    return { answer: "", score: { score: 0, detail: "arm threw" }, subCalls: 0, costUsd: 0, wallMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let only: string | null = null;
  let rounds = 2;
  let candidates = 2;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = argv[++i] ?? null;
    else if (argv[i] === "--rounds") rounds = Number(argv[++i]);
    else if (argv[i] === "--candidates") candidates = Number(argv[++i]);
  }
  let tasks: EvalTask[] = [...codeTasks];
  if (only) tasks = tasks.filter((t) => t.id.includes(only));
  if (tasks.length === 0) { console.error(`--only ${only} matched no tasks`); process.exit(2); }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const runsDir = path.resolve(process.cwd(), "eval/results", `compare-${stamp}`, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const { config, warnings } = sharedConfig(rounds, candidates);
  const registry = createStandaloneRegistry();
  console.error(`comparing ${tasks.length} task(s); linear(runHifi) vs composer(runComposerHifi); rounds=${rounds} candidates=${candidates}`);

  const rows: Array<{ id: string; linear: ArmRun; composer: ArmRun }> = [];
  for (const task of tasks) {
    console.error(`\n=== ${task.id} ===`);
    const linear = await runArm("linear", task, config, warnings, registry, runsDir);
    console.error(`  linear:   score=${linear.score.score.toFixed(2)} ${linear.subCalls} calls $${linear.costUsd.toFixed(4)} ${Math.round(linear.wallMs / 1000)}s ${linear.error ?? ""}`);
    const composer = await runArm("composer", task, config, warnings, registry, runsDir);
    console.error(`  composer: score=${composer.score.score.toFixed(2)} ${composer.subCalls} calls $${composer.costUsd.toFixed(4)} ${Math.round(composer.wallMs / 1000)}s ${composer.error ?? ""}`);
    rows.push({ id: task.id, linear, composer });
  }

  const pad = (s: string, w: number) => s.padEnd(w);
  console.log("\n=== COMPOSER vs LINEAR (parity) ===");
  console.log(`${pad("task", 18)}${pad("linear", 9)}${pad("composer", 10)}${pad("delta", 8)}${pad("lin$", 9)}${pad("comp$", 9)}calls(l/c)`);
  console.log("-".repeat(80));
  let lin = 0, comp = 0, linCost = 0, compCost = 0;
  for (const r of rows) {
    const d = r.composer.score.score - r.linear.score.score;
    console.log(`${pad(r.id, 18)}${pad(r.linear.score.score.toFixed(2), 9)}${pad(r.composer.score.score.toFixed(2), 10)}${pad((d >= 0 ? "+" : "") + d.toFixed(2), 8)}${pad("$" + r.linear.costUsd.toFixed(4), 9)}${pad("$" + r.composer.costUsd.toFixed(4), 9)}${r.linear.subCalls}/${r.composer.subCalls}`);
    lin += r.linear.score.score; comp += r.composer.score.score; linCost += r.linear.costUsd; compCost += r.composer.costUsd;
  }
  console.log("-".repeat(80));
  const n = Math.max(1, rows.length);
  console.log(`${pad("MEAN", 18)}${pad((lin / n).toFixed(2), 9)}${pad((comp / n).toFixed(2), 10)}${pad((((comp - lin) / n) >= 0 ? "+" : "") + ((comp - lin) / n).toFixed(2), 8)}${pad("$" + linCost.toFixed(4), 9)}${pad("$" + compCost.toFixed(4), 9)}`);
  console.log(`\nparity: composer mean ${(comp / n).toFixed(2)} vs linear ${(lin / n).toFixed(2)} (delta ${(((comp - lin) / n) >= 0 ? "+" : "") + ((comp - lin) / n).toFixed(2)}); composer cost $${compCost.toFixed(4)} vs linear $${linCost.toFixed(4)}`);
  for (const r of rows) {
    console.log(`  ${r.id}: linear=${r.linear.score.detail}${r.linear.error ? ` [${r.linear.error}]` : ""}`);
    console.log(`  ${r.id}: composer=${r.composer.score.detail}${r.composer.error ? ` [${r.composer.error}]` : ""}`);
  }
}

main().catch((err) => { console.error("compare failed:", err); process.exit(1); });
