// Smoke: the triage stage wired into the live pipeline. A MEGA task must
// early-return the slice roadmap WITHOUT running the solve pipeline (the budget
// guard - the full candidate/GVR/verify chain never fires on a whole system); a
// non-mega task must proceed past triage to a real answer. Cheap: the mega arm
// is one triage call, the micro arm is a minimal flash pipeline.
//
// Usage: npx tsx eval/smoke-triage.ts

import { loadConfig } from "../src/config.ts";
import { runHifi } from "../src/pipeline.ts";
import { createStandaloneRegistry } from "./standalone.ts";

const MEGA_TASK =
  "Build Minecraft from scratch: a voxel sandbox game with procedural terrain " +
  "generation, block placement/destruction, dynamic lighting, an inventory " +
  "system, mob AI, and online multiplayer.";
const MICRO_TASK =
  "In this JS function `function add(a, b) { return a + b + 1; }` there is an " +
  "off-by-one bug; it should return a + b. Provide the corrected function.";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

async function main(): Promise<void> {
  const registry = createStandaloneRegistry();
  // Cheap: every role on flash, minimal knobs, brief/context/delivery off (the
  // mega arm early-returns before them; the micro arm stays small). Spend capped.
  const env = {
    ...process.env,
    APODEX_ANALYST: "deepseek/deepseek-v4-flash",
    APODEX_GENERATOR: "deepseek/deepseek-v4-flash",
    APODEX_GRADER: "deepseek/deepseek-v4-flash",
    APODEX_VERIFIER: "deepseek/deepseek-v4-flash",
    APODEX_WORKER: "deepseek/deepseek-v4-flash",
    APODEX_JUDGE: "deepseek/deepseek-v4-flash",
    APODEX_BRIEF_ENABLED: "0",
    APODEX_CONTEXT_ENABLED: "0",
    APODEX_DELIVERY_PLAN: "0",
    APODEX_MAX_SUBCALLS: process.env.APODEX_MAX_SUBCALLS ?? "20",
    APODEX_MAX_COST_USD: process.env.APODEX_MAX_COST_USD ?? "0.5",
    APODEX_MAX_WALL_TIME_MS: process.env.APODEX_MAX_WALL_TIME_MS ?? "180000",
  };
  const { config, warnings } = loadConfig({ cwd: process.cwd(), env, overrides: { rounds: 1, candidates: 1 } });
  if (!config.triage.enabled) {
    console.log("UNEXPECTED: triage disabled; this smoke needs it on");
    process.exitCode = 1;
    return;
  }

  const results: boolean[] = [];

  // --- MEGA arm: must early-return a roadmap, must NOT solve. ---
  console.log("== MEGA arm ==");
  const mega = await runHifi({
    config,
    configWarnings: warnings,
    registry,
    task: MEGA_TASK,
    mode: "auto",
    cwd: process.cwd(),
    onProgress: (m) => console.error(`[mega] ${m}`),
  });
  results.push(line("mega: triage scale=mega", mega.composition?.scale === "mega", `scale=${mega.composition?.scale ?? "n/a"}`));
  results.push(
    line("mega: roadmap clarification", mega.clarification?.kind === "roadmap", `clar=${mega.clarification?.kind ?? "none"}`),
  );
  results.push(line("mega: NOT solved (empty answer)", mega.finalAnswer === "", `answerLen=${mega.finalAnswer.length}`));
  results.push(line("mega: cheap (solve pipeline skipped)", mega.budget.subCalls <= 3, `subCalls=${mega.budget.subCalls}`));
  console.log(`[mega] spent ${mega.budget.subCalls} calls, $${mega.budget.costUsd.toFixed(4)}`);

  // --- MICRO arm: must proceed past triage to a real answer. ---
  console.log("== MICRO arm ==");
  const micro = await runHifi({
    config,
    configWarnings: warnings,
    registry,
    task: MICRO_TASK,
    mode: "auto",
    cwd: process.cwd(),
    onProgress: (m) => console.error(`[micro] ${m}`),
  });
  results.push(
    line(
      "micro: triage scale != mega",
      micro.composition !== null && micro.composition.scale !== "mega",
      `scale=${micro.composition?.scale ?? "n/a"}`,
    ),
  );
  results.push(
    line("micro: not a roadmap pause", micro.clarification?.kind !== "roadmap", `clar=${micro.clarification?.kind ?? "none"}`),
  );
  results.push(line("micro: produced an answer", micro.finalAnswer.length > 0, `answerLen=${micro.finalAnswer.length}`));
  console.log(`[micro] spent ${micro.budget.subCalls} calls, $${micro.budget.costUsd.toFixed(4)}`);

  const ok = results.every(Boolean);
  console.log(`\n${ok ? "SMOKE-TRIAGE PASSED" : "SMOKE-TRIAGE FAILED"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("smoke-triage crashed:", err);
  process.exit(1);
});
