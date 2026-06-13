// The composer (architecture §3) - executes a DAG of work-orders.
//
// A WorkOrder names a catalog primitive, its literal input, and its deps (the
// orders whose OBSERVATIONS feed it). The composer:
//   1. VALIDATES the graph statically (typed I/O: only compatible primitives are
//      wired - arity, kinds, per-primitive validateDeps, acyclicity, no dangling
//      deps) BEFORE any execution.
//   2. EXECUTES in topological layers: independent orders run in PARALLEL; each
//      order's observation is gated; a gate failure is FLAGGED and propagated
//      (architecture §0 "hifi or honestly flagged"), never silently dropped.
//   3. Honors `collect` (snapshot to the run store) and `checkpoint` (pause the
//      run after an order, resuming stateless - reuses the clarification contract).
//
// Not a free DAG-builder: predictable because primitives + checklists + costs are
// fixed; budgetable because every order is one guarded sub-call / sandbox cell.

import { BudgetExhaustedError } from "./budget.ts";
import {
  CATALOG,
  isPrimitiveName,
  observationSummary,
  type Observation,
  type ObservationKind,
  type GateResult,
  type PrimitiveContext,
  type PrimitiveName,
  type WorkInput,
} from "./primitives.ts";
import type { ProgressFn } from "./types.ts";

// --- The DAG model ------------------------------------------------------------

export interface WorkOrder {
  /** Unique within the graph. */
  id: string;
  primitive: PrimitiveName;
  input: WorkInput;
  /** Ids of the orders whose observations feed this one (order is significant). */
  deps: string[];
  /** After this order passes, the run may pause for the user and resume stateless. */
  checkpoint?: boolean;
  /** Snapshot label: this order's observation is collected into the run store. */
  collect?: string;
}

export interface WorkGraph {
  orders: WorkOrder[];
}

// --- Execution result ---------------------------------------------------------

export interface ExecutedOrder {
  id: string;
  primitive: PrimitiveName;
  /** The observation produced, or null when the order was skipped / crashed. */
  observation: Observation | null;
  /** The gate verdict over the observation, or null when not executed. */
  gate: GateResult | null;
  skipped: boolean;
  skipReason?: string;
}

export interface ComposerResult {
  orders: ExecutedOrder[];
  /** The chosen sink observation (the run's output), or null if it failed. */
  output: Observation | null;
  outputOrderId: string | null;
  /** True iff EVERY executed order passed its gate and none was skipped. */
  hifi: boolean;
  budgetExhausted: boolean;
  /** Set when a `checkpoint` order paused the run before downstream work. */
  paused: { afterOrderId: string } | null;
  warnings: string[];
}

export interface ComposerOptions {
  signal?: AbortSignal;
  onProgress?: ProgressFn;
  /** Snapshot a collect-point observation (the pipeline wires this to RunStore). */
  collect?: (label: string, summary: string, observation: Observation) => void;
}

export class ComposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposerError";
  }
}

// --- Static validation (the typed-I/O guarantee) ------------------------------

/**
 * Validate a work-graph WITHOUT executing it: unique ids, known primitives, no
 * dangling deps, no cycles, and every order's deps satisfy its primitive's wiring
 * contract (arity + kinds + validateDeps). Returns a list of human-readable
 * errors; empty = the graph is executable. This is the gate that makes the DAG
 * "predictable, not a free builder" - decompose's output runs only if it passes.
 */
export function validateGraph(graph: WorkGraph): string[] {
  const errors: string[] = [];
  if (graph.orders.length === 0) return ["graph has no orders"];

  // --- structural pass: ids, duplicates (these break topology if present) ---
  const byId = new Map<string, WorkOrder>();
  let duplicateIds = false;
  for (const o of graph.orders) {
    if (typeof o.id !== "string" || o.id === "") {
      errors.push(`an order has an empty/invalid id (primitive=${o.primitive})`);
      continue;
    }
    if (byId.has(o.id)) { errors.push(`duplicate order id: ${o.id}`); duplicateIds = true; }
    byId.set(o.id, o);
  }

  // --- wiring pass: unknown primitive, dangling/self deps, arity, kinds, validateDeps ---
  // These are INDEPENDENT of acyclicity; a dangling/self dep, however, makes the
  // in-degree math unreliable, so it gates the cycle pass below.
  let danglingOrSelfDep = false;
  for (const o of graph.orders) {
    if (!isPrimitiveName(o.primitive)) {
      // The catalog is fixed - the model never invents a primitive (§2).
      errors.push(`order ${o.id}: unknown primitive "${o.primitive}" (not in the fixed catalog)`);
      continue;
    }
    const prim = CATALOG[o.primitive];
    const depKinds: ObservationKind[] = [];
    let allDepsResolved = true;
    const seenDeps = new Set<string>();
    for (const depId of o.deps) {
      // A duplicate dep satisfies arity + kinds yet feeds the SAME observation
      // twice (e.g. judge "run.0","run.0" would compare a candidate to itself).
      // Kahn handles the double in-degree, so this is the only place it is caught.
      if (seenDeps.has(depId)) { errors.push(`order ${o.id}: duplicate dep "${depId}"`); allDepsResolved = false; continue; }
      seenDeps.add(depId);
      if (depId === o.id) { errors.push(`order ${o.id}: depends on itself`); danglingOrSelfDep = true; allDepsResolved = false; continue; }
      const dep = byId.get(depId);
      if (!dep) { errors.push(`order ${o.id}: dangling dep "${depId}" (no such order)`); danglingOrSelfDep = true; allDepsResolved = false; continue; }
      if (!isPrimitiveName(dep.primitive)) { allDepsResolved = false; continue; } // already reported
      depKinds.push(CATALOG[dep.primitive].produces);
    }
    // Arity.
    if (o.deps.length < prim.deps.min || (prim.deps.max !== null && o.deps.length > prim.deps.max)) {
      const max = prim.deps.max === null ? "inf" : String(prim.deps.max);
      errors.push(`order ${o.id} (${o.primitive}): ${o.deps.length} dep(s), needs ${prim.deps.min}..${max}`);
    }
    // Kinds.
    for (const kind of depKinds) {
      if (prim.deps.kinds.length > 0 && !prim.deps.kinds.includes(kind)) {
        errors.push(`order ${o.id} (${o.primitive}): a dep produces "${kind}", incompatible (accepts ${prim.deps.kinds.join("|") || "nothing"})`);
      }
    }
    // Finer per-primitive wiring rules (e.g. synthesize needs one artifact dep) -
    // only when every dep resolved, so depKinds is the true ordered dep list.
    if (prim.validateDeps && allDepsResolved) {
      const verr = prim.validateDeps(depKinds);
      if (verr) errors.push(`order ${o.id} (${o.primitive}): ${verr}`);
    }
  }

  // --- cycle pass (Kahn): independent of wiring (kind/arity) errors, but only
  // valid when the dep graph resolves (no dangling/self deps, no duplicate ids). ---
  if (!danglingOrSelfDep && !duplicateIds) {
    const indeg = new Map<string, number>();
    for (const o of graph.orders) indeg.set(o.id, o.deps.length);
    const dependents = new Map<string, string[]>();
    for (const o of graph.orders) for (const d of o.deps) dependents.set(d, [...(dependents.get(d) ?? []), o.id]);
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      for (const dep of dependents.get(id) ?? []) {
        const nd = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, nd);
        if (nd === 0) queue.push(dep);
      }
    }
    if (visited !== graph.orders.length) errors.push("graph has a cycle (not a DAG)");
  }

  return errors;
}

// --- Topological helpers ------------------------------------------------------

/** Orders that nothing else depends on (the candidate outputs of the DAG). */
function sinkOrders(graph: WorkGraph): WorkOrder[] {
  const depended = new Set<string>();
  for (const o of graph.orders) for (const d of o.deps) depended.add(d);
  return graph.orders.filter((o) => !depended.has(o.id));
}

// --- The executor -------------------------------------------------------------

/**
 * Execute a VALIDATED graph. Call validateGraph first; this throws ComposerError
 * if the graph is invalid (a caller that skipped validation is a bug). Budget
 * exhaustion stops dispatch and returns best-so-far (never throws away paid
 * work); external abort stops dispatch; a checkpoint order pauses the run.
 */
export async function runComposer(
  graph: WorkGraph,
  base: Omit<PrimitiveContext, "label">,
  opts: ComposerOptions = {},
): Promise<ComposerResult> {
  const validationErrors = validateGraph(graph);
  if (validationErrors.length > 0) {
    throw new ComposerError(`invalid work-graph:\n- ${validationErrors.join("\n- ")}`);
  }

  const byId = new Map<string, WorkOrder>();
  for (const o of graph.orders) byId.set(o.id, o);

  const done = new Map<string, ExecutedOrder>();
  const pending = new Set(graph.orders.map((o) => o.id));
  const warnings: string[] = [];
  let budgetExhausted = false;
  let paused: { afterOrderId: string } | null = null;

  const emit = (m: string) => opts.onProgress?.(m);

  while (pending.size > 0 && !budgetExhausted && !paused) {
    if (opts.signal?.aborted) { warnings.push("composer: aborted by caller"); break; }

    // A layer = all pending orders whose every dep has finished (done = executed
    // OR skipped). Independent orders in a layer run concurrently.
    const ready = [...pending].filter((id) => byId.get(id)!.deps.every((d) => done.has(d)));
    if (ready.length === 0) {
      // No progress with work remaining: every remaining order is blocked behind
      // a dep that never finished. Validation guarantees acyclicity, so this can
      // only happen after a budget stop / abort cut a layer short.
      for (const id of pending) {
        done.set(id, { id, primitive: byId.get(id)!.primitive, observation: null, gate: null, skipped: true, skipReason: "upstream order did not complete (run stopped early)" });
      }
      break;
    }

    emit(`[composer] layer of ${ready.length} order(s): ${ready.join(", ")}`);
    const settled = await Promise.allSettled(
      ready.map((id) => executeOrder(byId.get(id)!, done, base, opts)),
    );

    for (let i = 0; i < ready.length; i++) {
      const id = ready[i]!;
      pending.delete(id);
      const res = settled[i]!;
      if (res.status === "fulfilled") {
        done.set(id, res.value);
      } else {
        const reason = res.reason;
        if (reason instanceof BudgetExhaustedError) {
          budgetExhausted = true;
          warnings.push(`composer: budget exhausted at order ${id} (${reason.reason})`);
          done.set(id, { id, primitive: byId.get(id)!.primitive, observation: null, gate: null, skipped: true, skipReason: "budget exhausted" });
        } else {
          // execute() is contracted not to throw on model failure; a throw here
          // is unexpected - record it as a skip rather than killing the run.
          const msg = reason instanceof Error ? reason.message : String(reason);
          warnings.push(`composer: order ${id} crashed unexpectedly: ${msg}`);
          done.set(id, { id, primitive: byId.get(id)!.primitive, observation: null, gate: null, skipped: true, skipReason: `crashed: ${msg}` });
        }
      }
    }

    // Gate-failure flagging + collect snapshots + checkpoint detection.
    for (const id of ready) {
      const ex = done.get(id)!;
      const order = byId.get(id)!;
      if (ex.skipped) { warnings.push(`composer: order ${id} (${ex.primitive}) skipped: ${ex.skipReason}`); continue; }
      if (ex.gate && !ex.gate.pass) warnings.push(`composer: order ${id} (${ex.primitive}) FAILED its gate: ${ex.gate.reason} (flagged, not dropped)`);
      if (order.collect && ex.observation) opts.collect?.(order.collect, observationSummary(ex.observation), ex.observation);
      // Checkpoint fires only on a PASSED order (a failed checkpoint would pause
      // on ungrounded work); the first such order in the layer pauses the run.
      if (order.checkpoint && ex.gate?.pass && !paused) {
        paused = { afterOrderId: id };
        emit(`[composer] checkpoint at ${id}: pausing the run (resume stateless)`);
      }
    }
  }

  // Anything still pending after a checkpoint/budget/abort stop is recorded as skipped.
  for (const id of pending) {
    if (!done.has(id)) done.set(id, { id, primitive: byId.get(id)!.primitive, observation: null, gate: null, skipped: true, skipReason: paused ? "after checkpoint pause" : "run stopped early" });
  }

  const orders = graph.orders.map((o) => done.get(o.id)!);

  // The run's output = a sink order (nothing depends on it). Prefer a NON-SKIPPED
  // synthesize sink; else any non-skipped sink (paid work is not discarded just
  // because the preferred sink was skipped); else name the synthesize sink with a
  // null output so the caller flags the run honestly.
  const sinks = sinkOrders(graph);
  const notSkipped = (o: WorkOrder) => done.get(o.id)?.skipped === false;
  const synthSinks = sinks.filter((o) => byId.get(o.id)!.primitive === "synthesize");
  const finalSink =
    synthSinks.find(notSkipped) ?? sinks.find(notSkipped) ?? synthSinks[0] ?? sinks[sinks.length - 1] ?? null;
  const outputEx = finalSink ? done.get(finalSink.id) ?? null : null;
  const output = outputEx && !outputEx.skipped ? outputEx.observation : null;
  const outputOrderId = finalSink?.id ?? null;
  if (sinks.length > 1) warnings.push(`composer: ${sinks.length} sink orders; output taken from ${outputOrderId}`);

  const hifi = !budgetExhausted && !paused && orders.every((o) => !o.skipped && o.gate?.pass === true);

  return { orders, output, outputOrderId, hifi, budgetExhausted, paused, warnings };
}

/** Execute ONE order: skip if any dep failed, else gather dep observations (in
 *  dep order), run the primitive, and gate the observation. */
async function executeOrder(
  order: WorkOrder,
  done: Map<string, ExecutedOrder>,
  base: Omit<PrimitiveContext, "label">,
  opts: ComposerOptions,
): Promise<ExecutedOrder> {
  const prim = CATALOG[order.primitive];

  const depObs: Observation[] = [];
  for (const depId of order.deps) {
    const dep = done.get(depId);
    if (!dep || dep.skipped || dep.observation === null) {
      return { id: order.id, primitive: order.primitive, observation: null, gate: null, skipped: true, skipReason: `upstream dep ${depId} produced no observation` };
    }
    depObs.push(dep.observation);
  }

  const ctx: PrimitiveContext = { ...base, label: order.id, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) };
  const observation = await prim.execute(order.input, depObs, ctx);
  const gate = prim.gate(observation);
  return { id: order.id, primitive: order.primitive, observation, gate, skipped: false };
}

// --- Deterministic canonical graph (the default DAG shape) --------------------

export interface CanonicalGraphOptions {
  /** N parallel gen lanes (>=1). */
  candidates: number;
  /** Code mode wires a `run` after each `gen`; non-code skips execution. */
  code: boolean;
  /** Insert an `audit` between judge/winner and synthesize. */
  withAudit?: boolean;
}

/**
 * Build the canonical work-graph deterministically - the default DAG shape and
 * the proof-of-concept the composer runs end-to-end:
 *   code, N>=2 : gen×N -> run×N -> judge -> [audit] -> synthesize
 *   code, N=1  : gen -> run -> [audit] -> synthesize
 *   non-code   : gen×N -> [judge] -> [audit] -> synthesize
 * Always passes validateGraph (asserted in the composer selftest).
 */
export function buildCanonicalGraph(opts: CanonicalGraphOptions): WorkGraph {
  const n = Math.max(1, Math.floor(opts.candidates));
  const orders: WorkOrder[] = [];

  const genIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `gen.${i}`;
    genIds.push(id);
    orders.push({ id, primitive: "gen", input: n > 1 ? { temperature: 0.8 } : {}, deps: [] });
  }

  // The artifacts the judge/synthesize compare: run observations (code) or the
  // candidates directly (non-code, nothing to execute).
  let artifactIds: string[];
  if (opts.code) {
    artifactIds = genIds.map((g, i) => {
      const id = `run.${i}`;
      orders.push({ id, primitive: "run", input: {}, deps: [g] });
      return id;
    });
  } else {
    artifactIds = genIds;
  }

  // The single artifact that feeds synthesize: a judge winner when N>=2, else the
  // lone artifact directly.
  let artifactForSynth: string;
  if (artifactIds.length >= 2) {
    orders.push({ id: "judge", primitive: "judge", input: {}, deps: artifactIds, collect: "verdict" });
    artifactForSynth = "judge";
  } else {
    artifactForSynth = artifactIds[0]!;
  }

  const synthDeps = [artifactForSynth];
  if (opts.withAudit) {
    orders.push({ id: "audit", primitive: "audit", input: {}, deps: [artifactForSynth], collect: "audit" });
    synthDeps.push("audit");
  }
  orders.push({ id: "synthesize", primitive: "synthesize", input: {}, deps: synthDeps, collect: "final" });

  return { orders };
}
