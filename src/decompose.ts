// decompose (architecture §2 ORCHESTRATE / §3) - the strong-session entry that
// turns a triaged task into a validated work-graph drawn ONLY from the fixed
// catalog. It NEVER invents a primitive and NEVER emits raw graph topology: the
// model picks DEPTH (how many candidates to compare, whether to claim-audit)
// within the fixed vocabulary; deterministic code wires the DAG from that depth +
// the triage CompositionPlan. This is the same discipline as triage (invariant
// 19 / 1.7: the model fills parameters, this code decides what runs) - the
// model-driven free-DAG orchestrator stays rejected because decompose reliability
// is the dominant risk (architecture §6).
//
// FAIL-SAFE: a failed/unparseable decompose falls back to MORE verification (a
// deeper default graph), never a silent cheap one. The "ask the user" escape is
// triage's job (needsDialog), upstream of here.

import { buildCanonicalGraph, validateGraph, type WorkGraph } from "./composer.ts";
import { asBoundedInt, parseJsonLoose } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import type { CompositionPlan } from "./triage.ts";
import type { ProgressFn, TaskMode } from "./types.ts";

/** The bounded depth choice the strong model makes - its only freedom (§3). */
export interface DecomposePlan {
  /** N independent gen lanes to generate + compare (depth). */
  candidates: number;
  /** Run a claim-by-claim audit before synthesis (deeper verification). */
  withAudit: boolean;
  rationale: string;
}

export interface DecomposeOptions {
  mode: TaskMode;
  /** Clamp ceiling for candidates (config.candidates clamp = 8). */
  maxCandidates: number;
  /** The fail-safe depth used when the model call fails/parses badly. */
  defaultCandidates: number;
  onProgress?: ProgressFn;
}

export interface DecomposeResult {
  graph: WorkGraph;
  plan: DecomposePlan;
  /** "model" = the strong call drove it; "fail-safe" = the robust default. */
  source: "model" | "fail-safe";
}

export function decomposeSystem(maxCandidates: number): string {
  return `You are the DECOMPOSE stage of a verification-centric engineering pipeline. You do
NOT solve the task. It has already been triaged (you receive its composition
plan). You decide the DEPTH of verification only.

The pipeline is a FIXED catalog of work-primitives (you cannot add to it; the
composer wires them automatically from your depth choice):
- gen: generate one independent candidate solution (+ a runnable self-test for code).
- run: execute a code candidate's self-test in a sandbox (observed exit code - the
  un-fakeable evidence).
- judge: compare candidates pairwise on that execution evidence and pick a winner.
- audit: extract the answer's load-bearing claims and verify each against evidence.
- synthesize: assemble the final answer from verified material only.

You choose only DEPTH - never the wiring:
- candidates (1..${maxCandidates}): how many independent solutions to generate and
  compare. Use MORE for harder, ambiguous, or high-stakes tasks (diverse
  approaches + stronger evidence-based selection); use 1 only for a genuinely
  trivial, unambiguous task.
- with_audit (bool): true for claim-heavy, correctness-critical, or high-stakes
  answers (an extra claim-by-claim verification pass before the final assembly).

FAIL-SAFE: when unsure, choose MORE depth, never less.

Return ONLY this JSON object, no prose, no markdown fences:
{"candidates": <integer ${1}..${maxCandidates}>, "with_audit": <true|false>, "rationale": "<one sentence>"}`;
}

export function decomposeUser(task: string, plan: CompositionPlan): string {
  return `# Triage composition plan

type=${plan.type} scale=${plan.scale} oracle=${plan.oracle} archRisk=${plan.archRisk} confidence=${plan.confidence}
rationale: ${plan.rationale || "(none)"}

# Task

${task}`;
}

interface RawPlan {
  candidates?: unknown;
  with_audit?: unknown;
  rationale?: unknown;
}

// Recognize the model's affirmative forms (a model emitting with_audit:1 or
// "yes" clearly INTENDS audit on; treating it as false would drop verification -
// the wrong direction for a fail-safe-toward-more pipeline). Everything else
// (absent, null, 0, "false", "no", garbage) is the lean default: no audit.
function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === "true" || v === "1" || v === "yes";
}

/**
 * Parse a decompose reply into a bounded DecomposePlan. Returns null when the
 * reply has no usable `candidates` integer (the caller then fails safe). The
 * candidates value is clamped to 1..maxCandidates so a model over/under-shoot
 * cannot escape the budget envelope.
 */
export function parseDecomposePlan(text: string, maxCandidates: number): DecomposePlan | null {
  const raw = parseJsonLoose<RawPlan>(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidates = asBoundedInt(raw.candidates, 1, maxCandidates);
  if (candidates === null) return null;
  return {
    candidates,
    withAudit: asBool(raw.with_audit),
    rationale: typeof raw.rationale === "string" ? raw.rationale.slice(0, 400) : "",
  };
}

/**
 * Build the validated work-graph for a depth plan. Always catalog-derived
 * (buildCanonicalGraph), so it cannot invent a primitive; validateGraph is a
 * belt-and-suspenders assertion (a failure here is a bug, not bad model input) -
 * on the impossible chance it fails, fall back to the minimal valid single-lane
 * graph rather than handing the composer an invalid DAG.
 */
export function buildGraphFromPlan(plan: DecomposePlan, mode: TaskMode): WorkGraph {
  const code = mode === "code";
  const graph = buildCanonicalGraph({ candidates: plan.candidates, code, withAudit: plan.withAudit });
  if (validateGraph(graph).length === 0) return graph;
  return buildCanonicalGraph({ candidates: 1, code, withAudit: false });
}

/** The robust fail-safe plan: more verification, never less (architecture §6). */
function failSafePlan(opts: DecomposeOptions, rationale: string): DecomposePlan {
  return { candidates: Math.max(1, Math.min(opts.defaultCandidates, opts.maxCandidates)), withAudit: true, rationale };
}

/**
 * Decompose a triaged task into a validated work-graph. One strong call + one
 * bounded re-ask; an unrecoverable model/parse failure returns the fail-safe
 * (deeper) graph - NEVER a silent cheap one. Budget exhaustion and abort are NOT
 * caught here: they propagate so the run stops rather than proceeding on a guess
 * (same contract as runTriage).
 */
export async function runDecompose(
  client: SubCallClient,
  task: string,
  composition: CompositionPlan,
  opts: DecomposeOptions,
): Promise<DecomposeResult> {
  const system = decomposeSystem(opts.maxCandidates);
  const call = (label: string, extra = "") =>
    client.call({ role: "analyst", label, systemPrompt: system, userText: decomposeUser(task, composition) + extra, temperature: 0 });

  // Diagnose each attempt honestly (ok-but-unparseable vs transport failure) so a
  // mixed-failure fail-safe rationale is accurate, not guessed.
  const diag = (out: { ok: boolean; error?: string }) => (out.ok ? "reply unparseable" : (out.error ?? "call failed"));

  const first = await call("decompose.plan");
  let plan = first.ok ? parseDecomposePlan(first.text, opts.maxCandidates) : null;
  let secondDiag = "";
  if (!plan) {
    opts.onProgress?.(`[decompose] attempt 1 unusable (${diag(first)}); one bounded re-ask`);
    const correction = first.ok ? "\n\nIMPORTANT: your previous reply was not valid JSON. Return ONLY the specified object." : "";
    const second = await call("decompose.plan.retry", correction);
    plan = second.ok ? parseDecomposePlan(second.text, opts.maxCandidates) : null;
    secondDiag = diag(second);
  }

  if (!plan) {
    const fs = failSafePlan(opts, `decompose failed (attempt1: ${diag(first)}; attempt2: ${secondDiag}); fail-safe deep default`);
    opts.onProgress?.(`[decompose] fail-safe: ${fs.candidates} candidates + audit (${fs.rationale})`);
    return { graph: buildGraphFromPlan(fs, opts.mode), plan: fs, source: "fail-safe" };
  }

  opts.onProgress?.(`[decompose] depth: ${plan.candidates} candidate(s)${plan.withAudit ? " + audit" : ""} (${plan.rationale || "no rationale"})`);
  return { graph: buildGraphFromPlan(plan, opts.mode), plan, source: "model" };
}
