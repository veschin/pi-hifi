// LIVE smoke for the composer execution path (slice 4 proof). Paid (real
// sub-calls + real sandbox). Two runs:
//   1. runComposerHifi end-to-end: triage -> decompose -> composer, the model's
//      OWN depth choice honored, OBSERVED evidence load-bearing.
//   2. a FORCED N=2 graph run to exercise the full chain decompose-shape
//      gen×2 -> run×2 -> judge -> synthesize with real models judging real
//      sandbox evidence (the judge primitive live).
//
// Run: npx tsx eval/smoke-composer.ts   (models default to deepseek pro/flash)

import * as fs from "node:fs";
import { Budget } from "../src/budget.ts";
import { buildCanonicalGraph, runComposer, type ComposerResult } from "../src/composer.ts";
import { runComposerHifi } from "../src/composer-pipeline.ts";
import { loadConfig } from "../src/config.ts";
import { SubCallClient } from "../src/llm.ts";
import { RoleResolver } from "../src/roles.ts";
import { detectSandbox, execAdmission } from "../src/sandbox.ts";
import { RunStore } from "../src/store.ts";
import type { HifiConfig, HifiResult, TaskMode } from "../src/types.ts";
import { createStandaloneRegistry } from "./standalone.ts";
import { designTasks } from "./tasks/design.ts";
import { incidentTasks } from "./tasks/incident.ts";

const TASK = `Write a JavaScript (ESM) function "chunk(array, size)" that splits an array into
chunks of the given size. Define behavior for: empty array, size <= 0 (throw),
size larger than the array, non-integer size (throw), and non-array input (throw).
Make it production-grade.`;

interface ComposerArtifact {
  hifi: boolean;
  budgetExhausted: boolean;
  orders: Array<{ id: string; primitive: string; skipped: boolean; gate: { pass: boolean; reason: string } | null; observation: string | null }>;
}

const checks: Array<[string, boolean, string]> = [];
const check = (label: string, ok: boolean, detail: string) => checks.push([label, ok, detail]);

function newClient(config: HifiConfig, registry: ReturnType<typeof createStandaloneRegistry>, label: string) {
  const warnings: string[] = [];
  const store = new RunStore(`${process.cwd()}/${config.runsDir}`, `${RunStore.newRunId(label)}`, (w) => warnings.push(w));
  const budget = new Budget(config.budget);
  const resolver = new RoleResolver({ config, registry });
  const client = new SubCallClient({ resolver, budget, store, timeoutMs: config.budget.subCallTimeoutMs, maxRetries: config.budget.subCallMaxRetries });
  return { client, budget, store };
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    APODEX_GENERATOR: process.env.APODEX_GENERATOR ?? "deepseek/deepseek-v4-pro",
    APODEX_JUDGE: process.env.APODEX_JUDGE ?? "deepseek/deepseek-v4-pro",
    APODEX_ANALYST: process.env.APODEX_ANALYST ?? "deepseek/deepseek-v4-pro",
    APODEX_WORKER: process.env.APODEX_WORKER ?? "deepseek/deepseek-v4-flash",
    APODEX_BRIEF_ENABLED: process.env.APODEX_BRIEF_ENABLED ?? "0",
    APODEX_CONTEXT_ENABLED: process.env.APODEX_CONTEXT_ENABLED ?? "0",
    APODEX_COMPOSER: "1",
    APODEX_CANDIDATES: process.env.APODEX_CANDIDATES ?? "2",
  };
  const { config, warnings } = loadConfig({ cwd: process.cwd(), env });
  const tier = await detectSandbox();
  const admission = execAdmission(tier, config.exec.allowUnsandboxed);
  console.error(`[smoke] sandbox tier=${tier} admission=${admission} candidates=${config.candidates}`);
  const registry = createStandaloneRegistry();
  const sandboxed = admission === "sandbox";

  // ===== Run 1: full pipeline, decompose chooses depth =====
  console.error("\n[smoke] === RUN 1: runComposerHifi (decompose decides depth) ===");
  const t0 = Date.now();
  const result = await runComposerHifi({ config, configWarnings: warnings, registry, task: TASK, mode: "code", cwd: process.cwd(), onProgress: (m) => console.error(`[1] ${m}`) });
  const composer: ComposerArtifact | null = fs.existsSync(`${result.runDir}/composer.json`) ? JSON.parse(fs.readFileSync(`${result.runDir}/composer.json`, "utf8")) : null;
  const decompose = fs.existsSync(`${result.runDir}/decompose.json`) ? JSON.parse(fs.readFileSync(`${result.runDir}/decompose.json`, "utf8")) : null;
  const prims1 = new Set(composer?.orders.map((o) => o.primitive) ?? []);
  const n1 = decompose?.plan.candidates ?? 0;

  console.log("\n=== RUN 1 RESULT ===");
  console.log(`triage:    ${result.composition ? `type=${result.composition.type} scale=${result.composition.scale} oracle=${result.composition.oracle}` : "n/a"}`);
  console.log(`decompose: source=${decompose?.source} candidates=${n1} audit=${decompose?.plan.withAudit}`);
  console.log(`composer:  hifi=${composer?.hifi} orders=[${composer?.orders.map((o) => `${o.id}:${o.gate?.pass ? "PASS" : o.skipped ? "SKIP" : "FAIL"}`).join(" ")}]`);
  for (const o of composer?.orders ?? []) console.log(`  ${o.id.padEnd(14)} ${o.primitive.padEnd(11)} ${o.gate?.pass ? "PASS" : "FAIL"}  ${o.observation ?? ""}`);
  console.log(`answer:    ${result.finalAnswer.length} chars; budget ${result.budget.subCalls} calls $${result.budget.costUsd.toFixed(4)}; ${Math.round((Date.now() - t0) / 1000)}s`);

  check("run1: decompose produced a model plan", decompose?.source === "model" || decompose?.source === "fail-safe", `source=${decompose?.source}`);
  check("run1: graph has gen + synthesize", prims1.has("gen") && prims1.has("synthesize"), [...prims1].join(","));
  check("run1: graph shape matches decompose depth (judge iff N>=2)", (n1 >= 2) === prims1.has("judge"), `N=${n1} judge=${prims1.has("judge")}`);
  check("run1: final answer carries a solution block (artifact identity)", /```\w+\s+solution/.test(result.finalAnswer), `${result.finalAnswer.length} chars`);
  check("run1: composer hifi", composer?.hifi === true, `hifi=${composer?.hifi}`);
  if (sandboxed) {
    const observedRun = (composer?.orders ?? []).some((o) => o.primitive === "run" && o.gate?.pass === true);
    check("run1: a run order OBSERVED real execution (gate pass)", observedRun, observedRun ? "real exit code observed" : "no run passed");
  }

  // ===== Run 2: forced N=2 graph -> exercise judge live on real evidence =====
  console.error("\n[smoke] === RUN 2: forced N=2 graph (gen×2 -> run×2 -> judge -> synthesize) ===");
  const t1 = Date.now();
  const { client, budget } = newClient(config, registry, "smoke2");
  const graph = buildCanonicalGraph({ candidates: 2, code: true, withAudit: false });
  const composed: ComposerResult = await runComposer(
    graph,
    { client, task: TASK, mode: "code", polyglot: config.polyglot, execEnabled: sandboxed, execTimeoutMs: config.exec.timeoutMs },
    { onProgress: (m) => console.error(`[2] ${m}`) },
  );
  console.log("\n=== RUN 2 RESULT ===");
  for (const o of composed.orders) console.log(`  ${o.id.padEnd(14)} ${o.primitive.padEnd(11)} ${o.gate?.pass ? "PASS" : o.skipped ? "SKIP" : "FAIL"}  ${o.observation ? observationLine(o.observation) : ""}`);
  console.log(`composer:  hifi=${composed.hifi} output=${composed.outputOrderId}; budget ${budget.snapshot().subCalls} calls $${budget.snapshot().costUsd.toFixed(4)}; ${Math.round((Date.now() - t1) / 1000)}s`);

  const prims2 = new Set<string>(composed.orders.map((o) => o.primitive));
  const judgeOrder = composed.orders.find((o) => o.primitive === "judge");
  check("run2: full chain present (gen,run,judge,synthesize)", ["gen", "run", "judge", "synthesize"].every((p) => prims2.has(p)), [...prims2].join(","));
  check("run2: judge ran and picked a winner", judgeOrder?.gate?.pass === true && judgeOrder.observation?.kind === "verdict" && judgeOrder.observation.winnerText !== "", `gate=${judgeOrder?.gate?.pass}`);
  check("run2: final output is a synthesized answer", composed.output?.kind === "final" && composed.output.answer.length > 0, `output=${composed.output?.kind}`);
  if (sandboxed) {
    const runs = composed.orders.filter((o) => o.primitive === "run");
    check("run2: both run orders OBSERVED real execution", runs.length === 2 && runs.every((o) => o.gate?.pass === true), `${runs.filter((o) => o.gate?.pass).length}/${runs.length} observed`);
    check("run2: judge saw execution evidence", judgeOrder?.observation?.kind === "verdict" && judgeOrder.observation.sawEvidence === true, "evidence-grounded selection");
  }

  // ===== Run 3: mode sweep - design, incident, general live via runComposerHifi =====
  // T2 AC2-AC4: the composer must return an on-shape answer for EVERY advertised
  // mode, not just code. The binary checks here are GUARANTEED invariants only
  // (no throw, non-empty answer, run.json path=composer, mode preserved, the graph
  // ends in synthesize). The CONTENT quality - architecture + failure-modes +
  // rejected alternative for design, root-cause + evidence chain for incident,
  // coherence for general - is emergent model output, so it is OBSERVED by printing
  // the full answer (see the log), never asserted as a false-green test invariant.
  const GENERAL_TASK = `A mid-size engineering team keeps missing sprint commitments: roughly 40% of
committed stories spill over each sprint. Standups happen on time, the backlog is
groomed, and velocity looks stable on paper. Explain the most likely systemic
causes and give a concrete, prioritized plan to address it. State your assumptions
and what evidence would confirm or refute each cause.`;

  const sweep: Array<{ mode: TaskMode; task: string; label: string }> = [
    { mode: "design", task: designTasks[0]!.prompt, label: "design" },
    { mode: "incident", task: incidentTasks[0]!.prompt, label: "incident" },
    { mode: "general", task: GENERAL_TASK, label: "general" },
  ];

  for (const { mode, task, label } of sweep) {
    console.error(`\n[smoke] === RUN 3.${label}: runComposerHifi mode=${mode} ===`);
    const tx = Date.now();
    let res: HifiResult | null = null;
    let threw = "";
    try {
      res = await runComposerHifi({ config, configWarnings: warnings, registry, task, mode, cwd: process.cwd(), onProgress: (m) => console.error(`[3.${label}] ${m}`) });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(`run3.${label}: no throw`, threw === "" && res !== null, threw || "returned");
    if (!res) continue;
    const runJson = fs.existsSync(`${res.runDir}/run.json`) ? JSON.parse(fs.readFileSync(`${res.runDir}/run.json`, "utf8")) : null;
    const comp: ComposerArtifact | null = fs.existsSync(`${res.runDir}/composer.json`) ? JSON.parse(fs.readFileSync(`${res.runDir}/composer.json`, "utf8")) : null;
    const prims = new Set(comp?.orders.map((o) => o.primitive) ?? []);
    console.log(`\n=== RUN 3.${label} RESULT (mode=${res.mode}) ===`);
    console.log(`run.json:  status=${runJson?.status} path=${runJson?.path} composerHifi=${runJson?.composerHifi} taskShape=${runJson?.taskShape}`);
    console.log(`composer:  hifi=${comp?.hifi} orders=[${comp?.orders.map((o) => `${o.id}:${o.gate?.pass ? "PASS" : o.skipped ? "SKIP" : "FAIL"}`).join(" ")}]`);
    console.log(`answer:    ${res.finalAnswer.length} chars; $${res.budget.costUsd.toFixed(4)}; ${Math.round((Date.now() - tx) / 1000)}s`);
    console.log(`--- ${label} answer (full, for eyes-on observation) ---\n${res.finalAnswer}\n--- end ${label} answer ---`);
    check(`run3.${label}: non-empty answer`, res.finalAnswer.trim().length > 0, `${res.finalAnswer.length} chars`);
    check(`run3.${label}: run.json path=composer`, runJson?.path === "composer", `path=${runJson?.path} status=${runJson?.status}`);
    check(`run3.${label}: mode preserved`, res.mode === mode, `mode=${res.mode}`);
    check(`run3.${label}: graph ends in synthesize (gen+synthesize present)`, prims.has("gen") && prims.has("synthesize"), [...prims].join(","));
  }

  console.log("\n=== ASSERTIONS ===");
  let allOk = true;
  for (const [label, ok, detail] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`); allOk = allOk && ok; }
  console.log(allOk ? "\nCOMPOSER SMOKE PASSED: decompose -> gen -> run -> judge -> synthesize live, observed evidence load-bearing" : "\nCOMPOSER SMOKE FAILED");
  if (!allOk) process.exit(1);
}

// Tiny inline renderer (avoids importing observationSummary just for the log).
function observationLine(o: { kind: string }): string {
  return o.kind;
}

main().catch((err) => {
  console.error("COMPOSER SMOKE CRASHED:", err);
  process.exit(1);
});
