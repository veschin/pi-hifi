// Triage - the gate-driver. One classification call turns a raw task into a
// CompositionPlan: five fields that a deterministic composer turns into "which
// work runs". The model only fills parameters from a fixed vocabulary; it never
// invents stages (predictability + budgetability preserved). FAIL-SAFE: any
// uncertainty defaults toward asking / more work, never a silent cheap miss.

import { parseJsonLoose, extractEnumField, asStringArray } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import type { ProgressFn } from "./types.ts";

export type TaskType = "code" | "design" | "research" | "incident" | "general";
export type TaskScale = "micro" | "bounded" | "mega";
/** How the result gets grounded (the oracle ladder, strongest first). */
export type Oracle = "execute" | "repo-suite" | "bench" | "web" | "none";

export interface CompositionPlan {
  type: TaskType;
  scale: TaskScale;
  oracle: Oracle;
  /** Architectural risk that warrants a probe/spike before committing. */
  archRisk: boolean;
  /** Ambiguous or large -> open a dialog before solving. */
  needsDialog: boolean;
  confidence: "high" | "low";
  /** Milestones for a mega task (solved per-slice across runs), else empty. */
  roadmap: string[];
  /** Free-text reason, for the run log. */
  rationale: string;
}

export const TRIAGE_SYSTEM = `You are the triage stage of a verification-centric engineering pipeline. You do
NOT solve the task. You classify it into a composition plan that decides how much
work runs and how it is grounded.

Return ONLY this JSON object:
{
  "type": "code" | "design" | "research" | "incident" | "general",
  "scale": "micro" | "bounded" | "mega",
  "oracle": "execute" | "repo-suite" | "bench" | "web" | "none",
  "arch_risk": <bool>,
  "needs_dialog": <bool>,
  "confidence": "high" | "low",
  "roadmap": [ "<milestone>", ... ],
  "rationale": "<one sentence>"
}

Guidance:
- scale: micro = one function/fix; bounded = one module/feature; mega = a whole
  app/system that must be sliced (e.g. "build minecraft from scratch").
- oracle (how the result is proven): execute = runnable self-test; repo-suite =
  run the project's existing tests (modifications); bench = measure (perf);
  web = source-backed research; none = nothing to run (design/theory, or a
  language with no runner here) -> ship the artifact flagged "not executed".
- arch_risk: true when the right design hinges on unknown contracts that a cheap
  PoC should probe before committing.
- roadmap: REQUIRED and non-empty when scale = mega; the ordered milestones.

FAIL-SAFE (critical): if the task is ambiguous, under-specified, or large, set
needs_dialog = true and confidence = "low". When unsure between scales, pick the
LARGER. Never route a hard or ambiguous task to a silent cheap path.`;

export function triageUser(task: string): string {
  return `# Task to triage\n\n${task}`;
}

const TYPES = ["code", "design", "research", "incident", "general"] as const;
const SCALES = ["micro", "bounded", "mega"] as const;
const ORACLES = ["execute", "repo-suite", "bench", "web", "none"] as const;

interface RawPlan {
  type?: unknown;
  scale?: unknown;
  oracle?: unknown;
  arch_risk?: unknown;
  needs_dialog?: unknown;
  confidence?: unknown;
  roadmap?: unknown;
  rationale?: unknown;
}

/** The safe default when classification cannot be trusted: ask, don't guess cheap. */
export function fallbackPlan(rationale: string): CompositionPlan {
  return {
    type: "general",
    scale: "bounded",
    oracle: "none",
    archRisk: false,
    needsDialog: true,
    confidence: "low",
    roadmap: [],
    rationale,
  };
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

export function parseTriage(text: string): CompositionPlan | null {
  const raw = parseJsonLoose<RawPlan>(text);
  const parsedOk = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const obj: RawPlan = parsedOk ? (raw as RawPlan) : {};

  const type =
    (typeof obj.type === "string" && (TYPES as readonly string[]).includes(obj.type) ? (obj.type as TaskType) : null) ??
    (extractEnumField(text, "type", TYPES) as TaskType | null);
  const scale =
    (typeof obj.scale === "string" && (SCALES as readonly string[]).includes(obj.scale) ? (obj.scale as TaskScale) : null) ??
    (extractEnumField(text, "scale", SCALES) as TaskScale | null);
  const oracle =
    (typeof obj.oracle === "string" && (ORACLES as readonly string[]).includes(obj.oracle) ? (obj.oracle as Oracle) : null) ??
    (extractEnumField(text, "oracle", ORACLES) as Oracle | null);
  if (type === null || scale === null || oracle === null) return null;

  const archRisk = asBool(obj.arch_risk) ?? false;
  let needsDialog = asBool(obj.needs_dialog) ?? true; // default: ask
  let confidence: "high" | "low" = obj.confidence === "high" ? "high" : "low";
  const roadmap = asStringArray(obj.roadmap, 20, 200);
  const rationale = typeof obj.rationale === "string" ? obj.rationale.slice(0, 400) : "";

  // Fail-safe coercions the model must not be able to bypass:
  if (!parsedOk) {
    // The JSON did not parse as an object: the enums were salvaged by the regex
    // fallback and every other field is a bare default. A partially-recovered
    // classification is untrustworthy, so force the safe side - a corrupt reply
    // can never yield a confident cheap route. (Without this, the safe outcome is
    // only an emergent artifact of obj={}, not a guaranteed invariant.)
    needsDialog = true;
    confidence = "low";
  }
  if (confidence === "low") needsDialog = true; // low confidence always asks
  if (scale === "mega" && roadmap.length === 0) {
    // mega without a plan is untrustworthy -> force the dialog to get one.
    needsDialog = true;
  }

  return { type, scale, oracle, archRisk, needsDialog, confidence, roadmap, rationale };
}

/**
 * Classify a task into a CompositionPlan. One call + one bounded re-ask. An
 * unrecoverable MODEL or PARSE failure returns the fail-safe plan (ask, do not
 * guess cheap). Budget exhaustion and external abort are NOT caught here - they
 * throw through, because the run must stop rather than proceed on a guessed plan.
 */
export async function runTriage(client: SubCallClient, task: string, onProgress?: ProgressFn): Promise<CompositionPlan> {
  const call = (label: string, extra = "") =>
    client.call({ role: "analyst", label, systemPrompt: TRIAGE_SYSTEM, userText: triageUser(task) + extra, temperature: 0 });

  const first = await call("triage.classify");
  if (first.ok) {
    const plan = parseTriage(first.text);
    if (plan) return plan;
    onProgress?.("[triage] first reply unparseable; one bounded re-ask");
  } else {
    onProgress?.(`[triage] first classification call failed (${first.error ?? "unknown"}); one bounded retry`);
  }
  // Correct an invalid REPLY only when there was one; a transport failure gets a
  // plain retry, not an instruction to fix a reply the model never sent.
  const correction = first.ok
    ? "\n\nIMPORTANT: your previous reply was not valid. Return ONLY the JSON object specified - no prose."
    : "";
  const second = await call("triage.classify.retry", correction);
  if (second.ok) {
    const plan = parseTriage(second.text);
    if (plan) return plan;
  }
  onProgress?.("[triage] classification failed twice; fail-safe plan (dialog)");
  return fallbackPlan(first.ok ? "classification unparseable twice" : (first.error ?? "triage call failed"));
}
