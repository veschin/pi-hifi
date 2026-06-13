// Free (no live LLM) proof of the composer (src/composer.ts): static graph
// validation (the typed-I/O guarantee) and the topological executor (layers,
// parallel dispatch, gate-flag-PROPAGATE vs skip-on-failed-dep, budget stop,
// checkpoint pause, collect snapshots, sink selection). The executor runs the
// REAL primitive catalog driven by a stubbed SubCallClient - no network.
//
// Run: npx tsx eval/composer-selftest.ts

import {
  buildCanonicalGraph,
  runComposer,
  validateGraph,
  type ComposerResult,
  type ExecutedOrder,
  type WorkGraph,
} from "../src/composer.ts";
import { extractFinalAnswer } from "../src/composer-pipeline.ts";
import type { Observation, PrimitiveContext } from "../src/primitives.ts";
import { BudgetExhaustedError } from "../src/budget.ts";
import { SubCallClient } from "../src/llm.ts";
import type { SubCallOutcome, SubCallRecord, SubCallRequest, TaskMode } from "../src/types.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

const GOOD_CODE = ['```js solution', "export const inc = (n) => n + 1;", "```", "", "```js selftest", 'import { inc } from "./solution.mjs";\nif (inc(1) !== 2) process.exit(1);', "```"].join("\n");
const VERDICT_JSON = JSON.stringify({ comprehension: "a", causality: "a", grounding: "a", overall: "a", rationale: "A is grounded" });

function outcome(ok: boolean, text: string, error?: string): SubCallOutcome {
  const record = { label: "stub", responseText: text } as unknown as SubCallRecord;
  return error !== undefined ? { ok, text, record, error } : { ok, text, record };
}

/** Route a stubbed response by role + label suffix (gen vs synthesize share the
 *  generator role; the label distinguishes them). */
function stubClient(route: (req: SubCallRequest) => SubCallOutcome): SubCallClient {
  return { call: async (req: SubCallRequest) => route(req) } as unknown as SubCallClient;
}

function baseCtx(client: SubCallClient, mode: TaskMode, execEnabled: boolean): Omit<PrimitiveContext, "label"> {
  return { client, task: "Increment a number, or design something.", mode, polyglot: false, execEnabled, execTimeoutMs: 3_000 };
}

/** A normal stub: gen -> answer, judge -> A-wins verdict, synthesize -> echo. */
function normalRoute(genAnswer: string): (req: SubCallRequest) => SubCallOutcome {
  return (req) => {
    if (req.label.endsWith(".synthesize")) return outcome(true, `Finalized.\n\n${genAnswer}`);
    if (req.role === "generator") return outcome(true, genAnswer);
    if (req.role === "judge") return outcome(true, VERDICT_JSON);
    return outcome(true, "{}");
  };
}

async function main(): Promise<void> {
  const r: boolean[] = [];

  // ===== Static validation =====
  // Canonical graphs (every shape) must validate clean - the executor's precondition.
  for (const o of [
    { candidates: 2, code: true },
    { candidates: 1, code: true },
    { candidates: 4, code: true, withAudit: true },
    { candidates: 3, code: false },
    { candidates: 1, code: false },
  ]) {
    const errs = validateGraph(buildCanonicalGraph(o));
    r.push(line(`validate: canonical ${JSON.stringify(o)} clean`, errs.length === 0, errs.join("; ") || "ok"));
  }

  // Each malformed graph yields a specific error class.
  r.push(line("validate: empty graph", validateGraph({ orders: [] }).length === 1, "rejected"));
  r.push(line("validate: unknown primitive", validateGraph({ orders: [{ id: "a", primitive: "frobnicate" as never, input: {}, deps: [] }] }).some((e) => /unknown primitive/.test(e)), "rejected"));
  r.push(line("validate: dangling dep", validateGraph({ orders: [{ id: "a", primitive: "run", input: {}, deps: ["ghost"] }] }).some((e) => /dangling dep/.test(e)), "rejected"));
  r.push(line("validate: duplicate id", validateGraph({ orders: [{ id: "a", primitive: "gen", input: {}, deps: [] }, { id: "a", primitive: "gen", input: {}, deps: [] }] }).some((e) => /duplicate order id/.test(e)), "rejected"));
  // Duplicate DEP (satisfies arity+kinds, would feed the same observation twice).
  r.push(
    line(
      "validate: duplicate dep (would compare a candidate to itself)",
      validateGraph({ orders: [{ id: "g0", primitive: "gen", input: {}, deps: [] }, { id: "g1", primitive: "gen", input: {}, deps: [] }, { id: "j", primitive: "judge", input: {}, deps: ["g0", "g0"] }] }).some((e) => /duplicate dep/.test(e)),
      "rejected",
    ),
  );
  r.push(
    line(
      "validate: arity (run needs exactly 1 candidate)",
      validateGraph({ orders: [{ id: "g0", primitive: "gen", input: {}, deps: [] }, { id: "g1", primitive: "gen", input: {}, deps: [] }, { id: "r", primitive: "run", input: {}, deps: ["g0", "g1"] }] }).some((e) => /needs 1\.\.1/.test(e)),
      "rejected",
    ),
  );
  r.push(
    line(
      "validate: kind mismatch (run wants candidate, got verdict)",
      validateGraph({
        orders: [
          { id: "g0", primitive: "gen", input: {}, deps: [] },
          { id: "g1", primitive: "gen", input: {}, deps: [] },
          { id: "j", primitive: "judge", input: {}, deps: ["g0", "g1"] },
          { id: "r", primitive: "run", input: {}, deps: ["j"] },
        ],
      }).some((e) => /incompatible/.test(e)),
      "rejected",
    ),
  );
  r.push(
    line(
      "validate: synthesize all-audit (validateDeps hole)",
      validateGraph({
        orders: [
          { id: "g0", primitive: "gen", input: {}, deps: [] },
          { id: "g1", primitive: "gen", input: {}, deps: [] },
          { id: "j", primitive: "judge", input: {}, deps: ["g0", "g1"] },
          { id: "a", primitive: "audit", input: {}, deps: ["j"] },
          { id: "s", primitive: "synthesize", input: {}, deps: ["a"] },
        ],
      }).some((e) => /exactly one artifact/.test(e)),
      "rejected",
    ),
  );
  r.push(
    line(
      "validate: cycle",
      validateGraph({
        orders: [
          { id: "a", primitive: "synthesize", input: {}, deps: ["b"] },
          { id: "b", primitive: "synthesize", input: {}, deps: ["a"] },
        ],
      }).some((e) => /cycle/.test(e)),
      "rejected",
    ),
  );

  // runComposer must reject an invalid graph rather than execute it.
  {
    let threw = false;
    try {
      await runComposer({ orders: [{ id: "a", primitive: "run", input: {}, deps: ["ghost"] }] }, baseCtx(stubClient(() => outcome(true, "")), "code", false));
    } catch (e) {
      threw = e instanceof Error && /invalid work-graph/.test(e.message);
    }
    r.push(line("runComposer: refuses invalid graph", threw, "threw ComposerError"));
  }

  // ===== Executor: all-pass (non-code, no exec needed) =====
  {
    const collected: string[] = [];
    const res: ComposerResult = await runComposer(
      buildCanonicalGraph({ candidates: 2, code: false }),
      baseCtx(stubClient(normalRoute("A complete design answer with tradeoffs and a rejected alternative.")), "design", false),
      { collect: (label) => collected.push(label) },
    );
    const ok = res.hifi && res.output?.kind === "final" && res.outputOrderId === "synthesize" && !res.budgetExhausted && res.paused === null && collected.includes("verdict") && collected.includes("final") && res.orders.every((o) => !o.skipped && o.gate?.pass);
    r.push(line("executor: non-code gen×2->judge->synthesize all-pass (hifi)", ok, `hifi=${res.hifi} output=${res.output?.kind} collect=[${collected.join(",")}]`));
  }

  // ===== Executor: gate-flag PROPAGATE (code, exec disabled -> run gate fails) =====
  {
    const res = await runComposer(
      buildCanonicalGraph({ candidates: 2, code: true }),
      baseCtx(stubClient(normalRoute(GOOD_CODE)), "code", false),
      {},
    );
    const runOrders = res.orders.filter((o) => o.primitive === "run");
    const runsFlagged = runOrders.length === 2 && runOrders.every((o) => o.observation !== null && o.gate?.pass === false && !o.skipped);
    // The run gate FAILED but the observations still fed judge+synthesize: the
    // chain COMPLETED (output exists), hifi=false (honestly flagged), nothing skipped.
    const ok = runsFlagged && res.output?.kind === "final" && res.hifi === false && res.orders.every((o) => !o.skipped) && res.warnings.some((w) => /FAILED its gate/.test(w));
    r.push(line("executor: failed run gate FLAGGED + propagated (not skipped)", ok, `hifi=${res.hifi} runsFlagged=${runsFlagged} output=${res.output?.kind}`));
  }

  // ===== Executor: pure gate failure cascades as FLAGGED, never as skip =====
  {
    // gen returns ok:false -> empty candidate -> gen gate fails; downstream still
    // executes on the (empty, flagged) observations. NO order is skipped.
    const res = await runComposer(
      buildCanonicalGraph({ candidates: 2, code: false }),
      baseCtx(stubClient(() => outcome(false, "", "model down")), "design", false),
      {},
    );
    const noSkips = res.orders.every((o) => !o.skipped);
    const genFailed = res.orders.filter((o) => o.primitive === "gen").every((o) => o.gate?.pass === false);
    r.push(line("executor: gate failures flag, never skip (no dep was null)", noSkips && genFailed && res.hifi === false, `noSkips=${noSkips} genFailed=${genFailed} hifi=${res.hifi}`));
  }

  // ===== Executor: budget exhaustion stops dispatch, best-so-far =====
  {
    const res = await runComposer(
      buildCanonicalGraph({ candidates: 2, code: false }),
      baseCtx(
        stubClient((req) => {
          if (req.role === "judge") throw new BudgetExhaustedError("sub-call limit reached");
          return outcome(true, "design answer");
        }),
        "design",
        false,
      ),
      {},
    );
    const judge = res.orders.find((o) => o.primitive === "judge");
    const synth = res.orders.find((o) => o.primitive === "synthesize");
    const ok = res.budgetExhausted && judge?.skipped === true && synth?.skipped === true && res.output === null && res.hifi === false;
    r.push(line("executor: budget stop -> skip rest, best-so-far, not hifi", ok, `exhausted=${res.budgetExhausted} judgeSkip=${judge?.skipped} synthSkip=${synth?.skipped}`));
  }

  // ===== Executor: checkpoint pauses the run =====
  {
    const graph: WorkGraph = {
      orders: [
        { id: "g0", primitive: "gen", input: {}, deps: [], checkpoint: true },
        { id: "s", primitive: "synthesize", input: {}, deps: ["g0"] },
      ],
    };
    const res = await runComposer(graph, baseCtx(stubClient(normalRoute("a design answer")), "design", false), {});
    const g0 = res.orders.find((o) => o.id === "g0");
    const s = res.orders.find((o) => o.id === "s");
    const ok = res.paused?.afterOrderId === "g0" && g0?.gate?.pass === true && s?.skipped === true && res.hifi === false;
    r.push(line("executor: checkpoint pauses before downstream", ok, `paused=${res.paused?.afterOrderId} synthSkipped=${s?.skipped}`));
  }

  // ===== Executor: skipped preferred sink falls through to a non-skipped sink =====
  {
    // Two sinks: g1 (independent) and s (synthesize, deps g0). Budget kills the
    // synthesize call -> s skipped; output must fall through to the non-skipped g1
    // (paid work is not discarded just because the preferred sink died).
    const graph: WorkGraph = {
      orders: [
        { id: "g0", primitive: "gen", input: {}, deps: [] },
        { id: "g1", primitive: "gen", input: {}, deps: [] },
        { id: "s", primitive: "synthesize", input: {}, deps: ["g0"] },
      ],
    };
    const res = await runComposer(
      graph,
      baseCtx(
        stubClient((req) => {
          if (req.label.endsWith(".synthesize")) throw new BudgetExhaustedError("cost limit");
          return outcome(true, "a design answer");
        }),
        "design",
        false,
      ),
      {},
    );
    const ok = res.budgetExhausted && res.output?.kind === "candidate" && res.outputOrderId === "g1";
    r.push(line("executor: skipped synthesize sink -> output from non-skipped sink", ok, `output=${res.output?.kind} from=${res.outputOrderId}`));
  }

  // ===== extractFinalAnswer: best-so-far deliverable extraction =====
  {
    const cr = (output: Observation | null, orders: ExecutedOrder[]): ComposerResult => ({ orders, output, outputOrderId: null, hifi: false, budgetExhausted: false, paused: null, warnings: [] });
    const final: Observation = { kind: "final", claim: "", answer: "FINAL ANSWER", preservedSolution: null };
    const verdict: Observation = { kind: "verdict", claim: "", winnerText: "WINNER TEXT", winnerEvidence: null, tie: false, sawEvidence: false };
    const candidate: Observation = { kind: "candidate", claim: "", text: "CAND TEXT", codeCandidate: false, selftestPresent: false, runnableLang: null };
    r.push(line("extractFinalAnswer: final output -> answer", extractFinalAnswer(cr(final, [])) === "FINAL ANSWER", "final"));
    r.push(line("extractFinalAnswer: verdict output -> winnerText", extractFinalAnswer(cr(verdict, [])) === "WINNER TEXT", "verdict"));
    // output null (synthesize skipped) -> best-so-far from a non-skipped verdict order.
    const verdictOrder: ExecutedOrder = { id: "judge", primitive: "judge", observation: verdict, gate: { pass: true, reason: "" }, skipped: false };
    const skippedSynth: ExecutedOrder = { id: "s", primitive: "synthesize", observation: null, gate: null, skipped: true, skipReason: "budget" };
    r.push(line("extractFinalAnswer: null output -> best-so-far verdict winner", extractFinalAnswer(cr(null, [verdictOrder, skippedSynth])) === "WINNER TEXT", "best-so-far"));
    const candOrder: ExecutedOrder = { id: "g0", primitive: "gen", observation: candidate, gate: { pass: true, reason: "" }, skipped: false };
    r.push(line("extractFinalAnswer: null output -> falls through to candidate", extractFinalAnswer(cr(null, [candOrder])) === "CAND TEXT", "candidate fallback"));
    r.push(line("extractFinalAnswer: nothing -> empty", extractFinalAnswer(cr(null, [skippedSynth])) === "", "empty"));
  }

  const ok = r.every(Boolean);
  console.log(ok ? `\nCOMPOSER-SELFTEST PASSED (${r.length} checks, free): validation + topological execution sound` : "\nCOMPOSER-SELFTEST FAILED");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("COMPOSER-SELFTEST CRASHED:", err);
  process.exitCode = 1;
});
