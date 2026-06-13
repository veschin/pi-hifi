// Composer execution path (architecture §3) - the work-primitive alternative to
// the linear runHifi middle, selected by `config.composer.enabled`.
//
//   triage -> brief -> context -> classify -> admission   (SHARED front stages,
//   the same stage functions runHifi uses)
//   -> decompose (task -> validated work-graph from the fixed catalog)
//   -> runComposer (gated, parallel DAG execution: gen -> run -> judge ->
//      [audit] -> synthesize, observation-grounded)
//   -> delivery plan + handoff.md
//
// runHifi (src/pipeline.ts) is deliberately UNTOUCHED: it stays the default,
// eval-pinned path until the composer reaches measured parity. This file reuses
// the exported stage functions (runTriage/runBriefStage/gatherContext/
// classifyMode/execAdmission/planDelivery/renderHandoff) rather than runHifi's
// body; the front-stage SEQUENCE is intentionally mirrored here (not factored
// into a shared helper yet) so the linear path carries zero regression risk
// while the two paths run in parallel. The duplication collapses when the
// composer replaces the linear middle.

import { Budget, BudgetExhaustedError } from "./budget.ts";
import { extractApprovedBrief, runBriefStage } from "./brief.ts";
import { runComposer, type ComposerResult } from "./composer.ts";
import { contextPackToText, gatherContext } from "./context.ts";
import { runDecompose } from "./decompose.ts";
import { planDelivery, renderHandoff } from "./delivery.ts";
import { SubCallClient } from "./llm.ts";
import { classifyMode } from "./pipeline.ts";
import { observationSummary } from "./primitives.ts";
import { RoleResolver, type ModelRegistryLike } from "./roles.ts";
import { detectSandbox, execAdmission } from "./sandbox.ts";
import { RunStore } from "./store.ts";
import {
  megaRoadmapClarification,
  runTriage,
  shouldBackstopDialog,
  type CompositionPlan,
} from "./triage.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  Clarification,
  ContextPack,
  DeliveryPlan,
  HifiConfig,
  HifiResult,
  ProgressFn,
  TaskMode,
} from "./types.ts";

export interface ComposerPipelineOptions {
  config: HifiConfig;
  configWarnings: string[];
  registry: ModelRegistryLike;
  sessionModel?: Model<Api>;
  task: string;
  mode: TaskMode | "auto";
  cwd: string;
  briefInteractive?: boolean;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

/**
 * Extract the deliverable text from a composer result. Prefers the final
 * synthesized answer; falls back through the most-final available non-skipped
 * observation (verdict winner -> run candidate -> candidate) so a budget/abort
 * stop still ships the best-so-far (never throws away paid work).
 */
export function extractFinalAnswer(composed: ComposerResult): string {
  const out = composed.output;
  if (out) {
    if (out.kind === "final") return out.answer;
    if (out.kind === "verdict" && out.winnerText) return out.winnerText;
    if (out.kind === "run") return out.candidate;
    if (out.kind === "candidate") return out.text;
  }
  for (const kind of ["final", "verdict", "run", "candidate"] as const) {
    for (const o of composed.orders) {
      const ob = o.observation;
      if (o.skipped || !ob || ob.kind !== kind) continue;
      if (ob.kind === "final") return ob.answer;
      if (ob.kind === "verdict" && ob.winnerText) return ob.winnerText;
      if (ob.kind === "run") return ob.candidate;
      if (ob.kind === "candidate") return ob.text;
    }
  }
  return "";
}

/** A default composition for decompose when triage is disabled by config. */
function defaultComposition(mode: TaskMode): CompositionPlan {
  return {
    type: mode === "code" ? "code" : mode === "design" ? "design" : mode === "incident" ? "incident" : "general",
    scale: "bounded",
    oracle: mode === "code" ? "execute" : "none",
    archRisk: false,
    needsDialog: false,
    confidence: "high",
    roadmap: [],
    rationale: "triage disabled; default composition from mode",
  };
}

export async function runComposerHifi(opts: ComposerPipelineOptions): Promise<HifiResult> {
  const task = opts.task.trim();
  if (task === "") throw new Error("pi-hifi: task must be a non-empty string");

  const warnings: string[] = [...opts.configWarnings];
  const runId = RunStore.newRunId();
  const store = new RunStore(
    opts.config.runsDir.startsWith("/") ? opts.config.runsDir : `${opts.cwd}/${opts.config.runsDir}`,
    runId,
    (w) => warnings.push(w),
  );
  const emitProgress: ProgressFn = (message) => {
    store.appendJsonl("progress.jsonl", { at: new Date().toISOString(), message });
    opts.onProgress?.(message);
  };

  const budget = new Budget(opts.config.budget);
  const resolver = new RoleResolver({
    config: opts.config,
    registry: opts.registry,
    ...(opts.sessionModel !== undefined ? { sessionModel: opts.sessionModel } : {}),
  });
  const client = new SubCallClient({
    resolver,
    budget,
    store,
    timeoutMs: opts.config.budget.subCallTimeoutMs,
    maxRetries: opts.config.budget.subCallMaxRetries,
    onNote: (note: string) => { warnings.push(note); emitProgress(note); },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  store.writeJson("config.json", { task, requestedMode: opts.mode, config: opts.config, path: "composer", startedAt: new Date().toISOString() });
  emitProgress("[composer-pipeline] path=composer (work-primitive DAG)");

  let mode: TaskMode = opts.mode === "auto" ? "general" : opts.mode;
  let composition: CompositionPlan | null = null;
  let briefText: string | null = null;
  let briefSource: "approved" | "generated" | null = null;
  let enrichedTask = task;
  let contextPack: ContextPack | null = null;
  let deliveryPlan: DeliveryPlan | null = null;
  let finalAnswer = "";
  let budgetExhausted = false;
  let composed: ComposerResult | null = null;

  // One clarification-pause shape, mirroring runHifi.clarReturn.
  const clarReturn = (clarification: Clarification): HifiResult => {
    const snapshot = budget.snapshot();
    store.writeJson("run.json", { status: "needs-clarification", runId, clarification, composition, budget: snapshot, warnings, finishedAt: new Date().toISOString() });
    return {
      runId, runDir: store.runDir, task, mode, finalAnswer: "", brief: null, clarification, composition,
      bestScore: null, gvr: null, selection: null, verification: null, contextPack: null, deliveryPlan: null,
      budget: snapshot, budgetExhausted: false, warnings,
    };
  };

  try {
    // --- Front (shared stage functions) ---
    if (opts.config.triage.enabled) {
      emitProgress("[triage] classifying the task into a composition plan");
      composition = await runTriage(client, task, emitProgress);
      store.writeJson("triage.json", composition);
      emitProgress(`[triage] type=${composition.type} scale=${composition.scale} oracle=${composition.oracle} dialog=${composition.needsDialog} conf=${composition.confidence}`);
      if (composition.scale === "mega") {
        emitProgress(`[triage] mega task -> ${composition.roadmap.length}-milestone roadmap; not solving in one run`);
        return clarReturn(megaRoadmapClarification(composition));
      }
    } else {
      emitProgress("[triage] disabled by config");
    }

    if (opts.config.brief.enabled) {
      const approved = extractApprovedBrief(task);
      if (approved !== null) {
        briefText = approved; briefSource = "approved";
        store.writeJson("brief.json", { kind: "approved", brief: approved, questions: [] });
        emitProgress("[brief] approved brief found in the task; analyst skipped");
      } else {
        emitProgress(`[brief] analyst elaborating the task (${opts.briefInteractive ? "interactive" : "assumption"} mode)`);
        const stage = await runBriefStage({ client, task, interactive: opts.briefInteractive ?? false, polyglot: opts.config.polyglot, onProgress: emitProgress });
        store.writeJson("brief.json", stage);
        if (stage.kind === "questions" || stage.kind === "brief-review") {
          emitProgress(stage.kind === "questions" ? `[brief] paused: ${stage.questions.length} question(s)` : "[brief] paused: draft brief awaits review");
          return clarReturn({ kind: stage.kind, questions: stage.questions, briefDraft: stage.brief, roadmap: [] });
        }
        if (stage.kind === "ready" && stage.brief !== null) {
          briefText = stage.brief; briefSource = "generated";
          emitProgress(`[brief] brief composed (${stage.brief.length} chars)`);
        } else {
          warnings.push(`brief stage skipped: ${stage.skippedReason ?? "no brief produced"}`);
          emitProgress(`[brief] skipped: ${stage.skippedReason ?? "no brief produced"}`);
        }
      }
    } else {
      emitProgress("[brief] disabled by config");
    }

    if (shouldBackstopDialog(composition, opts.config.brief.enabled, opts.briefInteractive ?? false)) {
      emitProgress("[triage] needs-dialog + brief off + interactive: fail-safe pause");
      return clarReturn({ kind: "questions", questions: [`Triage flagged this task as uncertain (${composition?.rationale || "low confidence"}). Restate the goal, hard constraints, and acceptance criteria, then re-invoke.`], briefDraft: null, roadmap: [] });
    }

    enrichedTask = briefSource === "generated" ? `${task}\n\n# Task brief\n\n${briefText}` : task;

    if (opts.config.context.enabled) {
      emitProgress("[context] scouting the workspace for task-relevant files");
      contextPack = await gatherContext({ client, task: enrichedTask, cwd: opts.cwd, config: opts.config.context, onProgress: emitProgress });
      store.writeJson("context.json", contextPack);
      warnings.push(...contextPack.warnings);
      emitProgress(contextPack.gathered ? `[context] gathered ${contextPack.files.length} file(s)` : `[context] none: ${contextPack.skippedReason ?? "no reason"}`);
    } else {
      emitProgress("[context] disabled by config");
    }
    const materials = contextPack?.gathered ? `${enrichedTask}\n\n${contextPackToText(contextPack)}` : enrichedTask;

    if (opts.mode === "auto") mode = await classifyMode(client, materials, emitProgress);
    emitProgress(`[classify] mode: ${mode}`);

    // Sandbox admission gate (code mode), identical policy to runHifi.
    let execEnabled = opts.config.exec.enabled;
    if (mode === "code" && execEnabled) {
      const admission = execAdmission(await detectSandbox(), opts.config.exec.allowUnsandboxed);
      if (admission === "bare-host") {
        const w = "[exec] SECURITY: no sandbox tier detected; candidate self-tests will run UNSANDBOXED on the bare host. Install the rootless tier (cgroup v2 + bubblewrap) or set exec.allowUnsandboxed=false to disable.";
        warnings.push(w); emitProgress(w);
      } else if (admission === "disabled") {
        execEnabled = false;
        const w = '[exec] no sandbox tier and exec.allowUnsandboxed=false; candidate self-tests DISABLED this run (answers ship flagged "not executed").';
        warnings.push(w); emitProgress(w);
      }
    }

    // --- decompose: task -> validated work-graph from the fixed catalog ---
    const compForDecompose = composition ?? defaultComposition(mode);
    emitProgress("[decompose] planning the work-graph");
    const decomposed = await runDecompose(client, materials, compForDecompose, {
      mode,
      maxCandidates: opts.config.candidates,
      defaultCandidates: opts.config.candidates,
      onProgress: emitProgress,
    });
    store.writeJson("decompose.json", { plan: decomposed.plan, source: decomposed.source, orders: decomposed.graph.orders });

    // --- composer: gated, parallel DAG execution ---
    emitProgress(`[composer] executing ${decomposed.graph.orders.length}-order graph`);
    composed = await runComposer(
      decomposed.graph,
      { client, task: materials, mode, polyglot: opts.config.polyglot, execEnabled, execTimeoutMs: opts.config.exec.timeoutMs },
      {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        onProgress: emitProgress,
        collect: (label, summary, observation) => store.writeJson(`collect-${label}.json`, { summary, observation }),
      },
    );
    store.writeJson("composer.json", {
      hifi: composed.hifi,
      budgetExhausted: composed.budgetExhausted,
      paused: composed.paused,
      output: composed.outputOrderId,
      orders: composed.orders.map((o) => ({ id: o.id, primitive: o.primitive, skipped: o.skipped, skipReason: o.skipReason ?? null, gate: o.gate, observation: o.observation ? observationSummary(o.observation) : null })),
      warnings: composed.warnings,
    });
    warnings.push(...composed.warnings);
    budgetExhausted = composed.budgetExhausted;
    finalAnswer = extractFinalAnswer(composed);

    if (composed.paused) {
      // CONTRACT GAP (the checkpoint slice must close this): the canonical graph
      // declares no checkpoints, so this is unreachable today. When a
      // checkpoint-bearing graph is introduced, a pause MUST be returned as a
      // clarification (clarReturn), NOT shipped as a finished answer. Until the
      // stateless-resume protocol is wired, surface it loudly and ship best-so-far.
      warnings.push(`composer paused after ${composed.paused.afterOrderId}; stateless resume not wired (best-so-far returned)`);
    }
    if (!composed.hifi && !budgetExhausted) {
      const flagged = composed.orders.filter((o) => o.skipped || o.gate?.pass === false).length;
      warnings.push(`composer: run not fully hifi (${flagged} order(s) skipped or gate-flagged); see composer.json`);
    }
    if (finalAnswer.trim() === "") {
      store.writeJson("run.json", { status: "failed", error: "composer produced no usable output", budget: budget.snapshot(), warnings });
      throw new Error("pi-hifi composer produced no usable output");
    }

    // --- delivery plan (decoration, never blocks) ---
    if (opts.config.delivery.planEnabled) {
      emitProgress("[deliver] composing the delivery plan");
      const planned = await planDelivery({ client, task: enrichedTask, answer: finalAnswer, onProgress: emitProgress });
      deliveryPlan = planned.plan;
      if (planned.error !== undefined) warnings.push(`delivery planning degraded: ${planned.error}`);
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      budgetExhausted = true;
      warnings.push(err.message);
      if (finalAnswer.trim() === "" && composed) finalAnswer = extractFinalAnswer(composed);
      if (finalAnswer.trim() === "") {
        store.writeJson("run.json", { status: "failed", error: err.message, budget: budget.snapshot(), warnings });
        throw err;
      }
    } else {
      store.writeJson("run.json", { status: "failed", error: err instanceof Error ? err.message : String(err), budget: budget.snapshot(), warnings });
      throw err;
    }
  }

  const result: HifiResult = {
    runId, runDir: store.runDir, task, mode, finalAnswer, brief: briefText, clarification: null, composition,
    bestScore: null, gvr: null, selection: null, verification: null, contextPack, deliveryPlan,
    budget: budget.snapshot(), budgetExhausted, warnings,
  };

  store.writeText("final.md", finalAnswer);
  if (deliveryPlan) store.writeJson("delivery.json", deliveryPlan);
  store.writeText("handoff.md", renderHandoff({
    runId, task: enrichedTask, mode, bestScore: null, verification: null, contextPack, deliveryPlan,
    budget: result.budget, budgetExhausted,
  }));
  store.writeJson("run.json", {
    status: budgetExhausted ? "budget-exhausted" : "completed",
    runId, path: "composer", mode, triageScale: composition?.scale ?? null,
    brief: briefSource, composerHifi: composed?.hifi ?? null, taskShape: deliveryPlan?.taskShape ?? null,
    budget: result.budget, warnings, finishedAt: new Date().toISOString(),
  });

  return result;
}
