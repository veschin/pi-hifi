// Free (no live LLM) proof of decompose (src/decompose.ts): the bounded-depth
// parser (clamping the model's candidates into the budget envelope), the
// catalog-derived graph builder (every shape validateGraph-clean), and
// runDecompose's control flow - one call + one re-ask, FAIL-SAFE to a DEEPER
// default (never cheaper), budget/abort propagated. A scripted stub
// SubCallClient drives the branches.
//
// Run: npx tsx eval/decompose-selftest.ts

import { buildGraphFromPlan, parseDecomposePlan, runDecompose, decomposeSystem, type DecomposeOptions } from "../src/decompose.ts";
import { validateGraph } from "../src/composer.ts";
import { BudgetExhaustedError } from "../src/budget.ts";
import { SubCallClient } from "../src/llm.ts";
import type { CompositionPlan } from "../src/triage.ts";
import type { SubCallOutcome, SubCallRecord, SubCallRequest, TaskMode } from "../src/types.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

const COMPOSITION: CompositionPlan = { type: "code", scale: "micro", oracle: "execute", archRisk: false, needsDialog: false, confidence: "high", roadmap: [], rationale: "off-by-one fix" };

function outcome(ok: boolean, text: string, error?: string): SubCallOutcome {
  const record = { label: "stub", responseText: text } as unknown as SubCallRecord;
  return error !== undefined ? { ok, text, record, error } : { ok, text, record };
}

function scriptedClient(scripted: Array<SubCallOutcome | (() => never)>): { client: SubCallClient; calls: () => number } {
  let i = 0;
  const stub = {
    call: async (_req: SubCallRequest): Promise<SubCallOutcome> => {
      const next = scripted[i] ?? outcome(false, "", "stub exhausted");
      i += 1;
      if (typeof next === "function") next(); // throws (budget/abort)
      return next as SubCallOutcome;
    },
  };
  return { client: stub as unknown as SubCallClient, calls: () => i };
}

function opts(mode: TaskMode): DecomposeOptions {
  return { mode, maxCandidates: 8, defaultCandidates: 4 };
}

const ids = (g: { orders: { id: string }[] }) => g.orders.map((o) => o.id).join(",");

async function main(): Promise<void> {
  const r: boolean[] = [];

  // 1. parseDecomposePlan - clamping is the budget guard.
  {
    const good = parseDecomposePlan(JSON.stringify({ candidates: 3, with_audit: true, rationale: "hard" }), 8);
    r.push(line("parse: good plan", good?.candidates === 3 && good.withAudit === true, JSON.stringify(good)));
    const high = parseDecomposePlan(JSON.stringify({ candidates: 99 }), 8);
    r.push(line("parse: clamps candidates to max", high?.candidates === 8 && high.withAudit === false, `candidates=${high?.candidates}`));
    const low = parseDecomposePlan(JSON.stringify({ candidates: 0 }), 8);
    r.push(line("parse: clamps candidates to >=1", low?.candidates === 1, `candidates=${low?.candidates}`));
    r.push(line("parse: with_audit string coerces", parseDecomposePlan(JSON.stringify({ candidates: 2, with_audit: "true" }), 8)?.withAudit === true, "coerced"));
    // with_audit:1 (integer) must coerce to true - dropping audit would fail-safe
    // the WRONG way (less verification). false-y forms stay the lean default.
    r.push(
      line(
        "parse: with_audit truthy forms (1/\"yes\") coerce; 0/\"no\" do not",
        parseDecomposePlan(JSON.stringify({ candidates: 2, with_audit: 1 }), 8)?.withAudit === true &&
          parseDecomposePlan(JSON.stringify({ candidates: 2, with_audit: "yes" }), 8)?.withAudit === true &&
          parseDecomposePlan(JSON.stringify({ candidates: 2, with_audit: 0 }), 8)?.withAudit === false &&
          parseDecomposePlan(JSON.stringify({ candidates: 2, with_audit: "no" }), 8)?.withAudit === false,
        "1/yes->true, 0/no->false",
      ),
    );
    r.push(line("parse: missing candidates -> null", parseDecomposePlan(JSON.stringify({ with_audit: true }), 8) === null, "no usable depth"));
    r.push(line("parse: garbage -> null", parseDecomposePlan("Sorry, I cannot.", 8) === null, "unparseable"));
  }

  // 2. buildGraphFromPlan - every shape validateGraph-clean + correct topology.
  {
    const codeDeep = buildGraphFromPlan({ candidates: 3, withAudit: true, rationale: "" }, "code");
    const codeOk = validateGraph(codeDeep).length === 0 && codeDeep.orders.filter((o) => o.primitive === "gen").length === 3 && codeDeep.orders.some((o) => o.primitive === "audit") && codeDeep.orders.filter((o) => o.primitive === "run").length === 3;
    r.push(line("build: code N=3 + audit -> gen×3,run×3,judge,audit,synthesize (valid)", codeOk, ids(codeDeep)));
    const designShallow = buildGraphFromPlan({ candidates: 2, withAudit: false, rationale: "" }, "design");
    const designOk = validateGraph(designShallow).length === 0 && !designShallow.orders.some((o) => o.primitive === "run") && designShallow.orders.some((o) => o.primitive === "judge");
    r.push(line("build: non-code N=2 -> gen×2,judge,synthesize, NO run (valid)", designOk, ids(designShallow)));
    const single = buildGraphFromPlan({ candidates: 1, withAudit: false, rationale: "" }, "code");
    r.push(line("build: code N=1 -> gen,run,synthesize, no judge (valid)", validateGraph(single).length === 0 && !single.orders.some((o) => o.primitive === "judge"), ids(single)));
  }

  // 3. runDecompose control flow.
  {
    const { client } = scriptedClient([outcome(true, JSON.stringify({ candidates: 2, with_audit: false, rationale: "ok" }))]);
    const res = await runDecompose(client, "fix it", COMPOSITION, opts("code"));
    r.push(line("runDecompose: good first call -> source=model", res.source === "model" && res.plan.candidates === 2 && validateGraph(res.graph).length === 0, `source=${res.source} N=${res.plan.candidates}`));
  }
  {
    // first ok but unparseable, retry good -> model.
    const { client, calls } = scriptedClient([outcome(true, "not json"), outcome(true, JSON.stringify({ candidates: 5, with_audit: true, rationale: "retry" }))]);
    const res = await runDecompose(client, "fix it", COMPOSITION, opts("code"));
    r.push(line("runDecompose: unparseable then good -> model (2 calls)", res.source === "model" && res.plan.candidates === 5 && calls() === 2, `source=${res.source} calls=${calls()}`));
  }
  {
    // garbage twice -> FAIL-SAFE deeper default (withAudit true, never cheaper).
    const { client } = scriptedClient([outcome(true, "no"), outcome(true, "still no")]);
    const res = await runDecompose(client, "fix it", COMPOSITION, opts("code"));
    const deeper = res.source === "fail-safe" && res.plan.withAudit === true && res.plan.candidates === 4 && validateGraph(res.graph).length === 0;
    r.push(line("runDecompose: garbage twice -> fail-safe DEEPER (audit, N=4)", deeper, `source=${res.source} N=${res.plan.candidates} audit=${res.plan.withAudit}`));
  }
  {
    // call fails (transport) twice -> fail-safe.
    const { client } = scriptedClient([outcome(false, "", "timeout"), outcome(false, "", "timeout")]);
    const res = await runDecompose(client, "fix it", COMPOSITION, opts("design"));
    r.push(line("runDecompose: call fails twice -> fail-safe", res.source === "fail-safe" && validateGraph(res.graph).length === 0, `source=${res.source}`));
  }
  {
    // budget exhaustion PROPAGATES (not caught - the run must stop).
    const { client } = scriptedClient([() => { throw new BudgetExhaustedError("sub-call limit"); }]);
    let threw = false;
    try {
      await runDecompose(client, "fix it", COMPOSITION, opts("code"));
    } catch (e) {
      threw = e instanceof BudgetExhaustedError;
    }
    r.push(line("runDecompose: budget exhaustion propagates", threw, "thrown, not swallowed"));
  }

  // 4. decomposeSystem advertises the fixed catalog + the bound.
  {
    const sys = decomposeSystem(8);
    const ok = ["gen", "run", "judge", "audit", "synthesize"].every((p) => sys.includes(p)) && sys.includes("1..8") && /FAIL-SAFE/i.test(sys) && /cannot add to it/i.test(sys);
    r.push(line("decomposeSystem: fixed catalog + bound + fail-safe", ok, "vocabulary advertised"));
  }

  const ok = r.every(Boolean);
  console.log(ok ? `\nDECOMPOSE-SELFTEST PASSED (${r.length} checks, free): catalog-bound, clamped, fail-safe DEEPER` : "\nDECOMPOSE-SELFTEST FAILED");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("DECOMPOSE-SELFTEST CRASHED:", err);
  process.exitCode = 1;
});
