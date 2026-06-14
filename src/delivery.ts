// Delivery stage - the pipeline's final step.
//
// A worker call classifies the task shape and turns the verified answer into
// an actionable plan (apply steps / key points / open items) for the CALLING
// agent - the session model that must continue the user's request. The plan
// plus a verification digest is rendered into <runDir>/handoff.md so the
// result of a run is an artifact, not just chat text.
//
// Failure discipline: planning is decoration on top of a finished answer - a
// failed planner call degrades to plan=null (generic delivery directive), it
// never blocks or alters the answer.

import { asStringArray, extractEnumField, parseJsonLoose } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import { DELIVERY_PLANNER_SYSTEM, deliveryPlannerUser } from "./prompts.ts";
import type {
  BudgetSnapshot,
  ComposerSummary,
  ContextPack,
  DeliveryPlan,
  ProgressFn,
  TaskMode,
  TaskShape,
  VerificationReport,
} from "./types.ts";

/** The planner sees at most this much answer text (it plans, it does not edit). */
const PLANNER_ANSWER_CAP = 20_000;
const MAX_PLAN_ITEMS = 12;
const PLAN_ITEM_MAX_LEN = 600;

const TASK_SHAPES = ["implementation", "analysis", "answer"] as const;

function parsePlan(text: string): DeliveryPlan | null {
  const raw = parseJsonLoose<{
    task_shape?: unknown;
    apply_steps?: unknown;
    key_points?: unknown;
    open_items?: unknown;
  }>(text);
  let shape: string | null = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.task_shape === "string") {
    shape = raw.task_shape;
  }
  if (shape === null) shape = extractEnumField(text, "task_shape", TASK_SHAPES);
  if (shape !== "implementation" && shape !== "analysis" && shape !== "answer") return null;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    taskShape: shape as TaskShape,
    applySteps: asStringArray(obj.apply_steps, MAX_PLAN_ITEMS, PLAN_ITEM_MAX_LEN),
    keyPoints: asStringArray(obj.key_points, MAX_PLAN_ITEMS, PLAN_ITEM_MAX_LEN),
    openItems: asStringArray(obj.open_items, MAX_PLAN_ITEMS, PLAN_ITEM_MAX_LEN),
  };
}

export interface PlanDeliveryOptions {
  client: SubCallClient;
  task: string;
  answer: string;
  onProgress?: ProgressFn;
}

export async function planDelivery(
  opts: PlanDeliveryOptions,
): Promise<{ plan: DeliveryPlan | null; error?: string }> {
  const answer =
    opts.answer.length > PLANNER_ANSWER_CAP
      ? `${opts.answer.slice(0, PLANNER_ANSWER_CAP)}\n\n... [answer truncated for planning at ${PLANNER_ANSWER_CAP} chars]`
      : opts.answer;
  const userText = deliveryPlannerUser(opts.task, answer);

  const first = await opts.client.call({
    role: "worker",
    label: "deliver.plan",
    systemPrompt: DELIVERY_PLANNER_SYSTEM,
    userText,
    temperature: 0,
  });
  if (first.ok) {
    const plan = parsePlan(first.text);
    if (plan) return { plan };
  }
  const second = await opts.client.call({
    role: "worker",
    label: "deliver.plan.retry",
    systemPrompt: DELIVERY_PLANNER_SYSTEM,
    userText: `${userText}\n\nIMPORTANT: your previous reply was not parseable. Return ONLY the JSON object described in your instructions.`,
    temperature: 0,
  });
  if (second.ok) {
    const plan = parsePlan(second.text);
    if (plan) return { plan };
    return { plan: null, error: "delivery planner returned unparseable JSON twice" };
  }
  return { plan: null, error: second.error ?? "delivery planner call failed twice" };
}

export interface HandoffInput {
  runId: string;
  task: string;
  mode: TaskMode;
  bestScore: number | null;
  verification: VerificationReport | null;
  /** Composer-path summary; when set, the handoff reports it instead of the
   * linear grader/atoms/verifier lines (which are null on the composer path). */
  composer: ComposerSummary | null;
  contextPack: ContextPack | null;
  deliveryPlan: DeliveryPlan | null;
  budget: BudgetSnapshot;
  budgetExhausted: boolean;
}

function bulletList(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${item}`).join("\n");
}

function numberedList(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

/** Deterministic render - no LLM involved, safe on every exit path. */
export function renderHandoff(input: HandoffInput): string {
  const atoms = input.verification?.atoms ?? [];
  const verified = atoms.filter((a) => a.verdict === "verified").length;
  const unsupported = atoms.filter((a) => a.verdict === "unsupported").length;
  const contradicted = atoms.filter((a) => a.verdict === "contradicted").length;
  const holistic = input.verification?.holistic?.verdict ?? "n/a";
  const context = input.contextPack;
  const contextLine = context
    ? context.gathered
      ? `${context.files.length} file(s), ${(context.totalBytes / 1024).toFixed(1)} KB in ${context.rounds} scout round(s): ${context.files.map((f) => f.path).join(", ")}`
      : `none (${context.skippedReason ?? "no reason recorded"})`
    : "stage not run";
  const plan = input.deliveryPlan;

  // Grounding lines are path-specific: the composer path has no linear grader/
  // verifier (those fields are null -> would render as dead "n/a"); it reports its
  // OWN evidence - the per-primitive hifi gate result (architecture §0: a run is
  // "hifi or honestly flagged").
  const c = input.composer;
  const groundingLines = c
    ? [
        `- composer: ${c.depth} candidate(s) -> ${c.orderCount} gated work-order(s)${c.flaggedCount > 0 ? `, ${c.flaggedCount} flagged` : ""}`,
        `- run grounding: ${c.hifi ? "fully grounded (every executed order passed its observation gate)" : "PARTIAL - some orders skipped or gate-flagged (see run.json / composer.json)"}`,
      ]
    : [
        `- best grader score: ${input.bestScore ?? "n/a"}/100`,
        `- claim atoms: ${verified} verified / ${unsupported} unsupported / ${contradicted} contradicted`,
        `- external verifier: ${holistic}`,
      ];

  const lines: string[] = [
    `# pi-hifi handoff - ${input.runId}`,
    "",
    `Task (first 300 chars): ${input.task.length > 300 ? `${input.task.slice(0, 300)}...` : input.task}`,
    "",
    `- mode: ${input.mode}`,
    ...groundingLines,
    `- workspace context: ${contextLine}`,
    `- spend: $${input.budget.costUsd.toFixed(4)}, ${input.budget.subCalls} sub-calls, ${input.budget.totalTokens} tokens${input.budgetExhausted ? " (BUDGET EXHAUSTED - best-so-far answer)" : ""}`,
    "",
    "The verified answer lives in final.md next to this file.",
    "",
    `## Task shape: ${plan?.taskShape ?? "unclassified (planner unavailable)"}`,
    "",
    "## Key points",
    "",
    bulletList(plan?.keyPoints ?? [], "(planner unavailable - read final.md directly)"),
    "",
    "## Apply steps (for the calling agent)",
    "",
    numberedList(plan?.applySteps ?? [], plan ? "(none - the task did not ask for changes)" : "(planner unavailable)"),
    "",
    "## Open items (unverified / assumed / deferred)",
    "",
    bulletList(plan?.openItems ?? [], "(none recorded)"),
    "",
  ];
  return lines.join("\n");
}
