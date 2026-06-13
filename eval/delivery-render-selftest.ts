// Free (no-LLM) check that the EXTENSION's user-facing rendering of a clarification
// (index.ts composeDelivery -> composeClarification) is correct for every kind -
// most importantly the new "roadmap" kind a mega task returns. The pipeline RETURN
// of the roadmap clarification is covered by smoke-triage; this covers what the
// caller actually SEES. The live TUI wake-up (triggerTurn) is not testable here.
//
// Run: npx tsx eval/delivery-render-selftest.ts

import { composeDelivery } from "../index.ts";
import type { ApodexResult, Clarification } from "../src/types.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

// composeDelivery routes a clarification result straight to composeClarification,
// which reads only result.clarification + result.runId - a minimal stub suffices.
function clarResult(clar: Clarification): ApodexResult {
  return { runId: "run-test", clarification: clar } as unknown as ApodexResult;
}

function roadmap(milestones: string[]): Clarification {
  return { kind: "roadmap", questions: [], briefDraft: null, roadmap: milestones };
}

// The non-clarification path reads summary fields + budget; the optional stages
// (gvr/selection/verification/contextPack/deliveryPlan) are guarded by `if`, so
// nulls are valid - only budget's numeric fields are dereferenced unconditionally.
function normalResult(finalAnswer: string): ApodexResult {
  return {
    runId: "run-test",
    runDir: "/tmp/run-test",
    finalAnswer,
    clarification: null,
    mode: "code",
    bestScore: 100,
    brief: null,
    composition: null,
    gvr: null,
    selection: null,
    verification: null,
    contextPack: null,
    deliveryPlan: null,
    budget: { subCalls: 5, totalTokens: 1000, inputTokens: 800, outputTokens: 200, costUsd: 0.01, elapsedMs: 12_000, limits: {} },
    budgetExhausted: false,
    warnings: [],
  } as unknown as ApodexResult;
}

async function main(): Promise<void> {
  const r: boolean[] = [];

  // roadmap with milestones: each numbered, mega framing, slice NEXT STEP.
  {
    const out = composeDelivery(clarResult(roadmap(["terrain gen", "block I/O", "lighting"])));
    r.push(
      line(
        "roadmap render: milestones + mega framing + slice directive",
        /mega/i.test(out) &&
          out.includes("1. terrain gen") &&
          out.includes("2. block I/O") &&
          out.includes("3. lighting") &&
          /NEXT STEP/.test(out) &&
          /one slice|ONE slice/i.test(out),
        out.split("\n")[0] ?? "(empty)",
      ),
    );
  }

  // roadmap empty (mega-no-roadmap fail-safe): explicit "no slice plan" fallback,
  // never a blank/misleading render.
  {
    const out = composeDelivery(clarResult(roadmap([])));
    r.push(line("roadmap render: empty -> split-by-hand fallback", /no slice plan/i.test(out) && /mega/i.test(out), out.includes("no slice plan") ? "fallback present" : out.slice(0, 60)));
  }

  // regression: questions kind still renders the relay directive.
  {
    const out = composeDelivery(clarResult({ kind: "questions", questions: ["Q1?", "Q2?"], briefDraft: null, roadmap: [] }));
    r.push(line("questions render (regression)", out.includes("1. Q1?") && /relay these questions/i.test(out), "questions branch"));
  }

  // regression: brief-review kind still renders the approve directive.
  {
    const out = composeDelivery(clarResult({ kind: "brief-review", questions: [], briefDraft: "DRAFT BRIEF BODY", roadmap: [] }));
    r.push(line("brief-review render (regression)", out.includes("DRAFT BRIEF BODY") && /Approved brief/.test(out), "brief-review branch"));
  }

  // non-clarification path: summary header + inline answer + final.md ref + NEXT STEP.
  {
    const out = composeDelivery(normalResult("export const sum = (a, b) => a + b;"));
    r.push(
      line(
        "normal result render: summary + inline answer + NEXT STEP",
        out.includes("run-test") &&
          out.includes("export const sum") &&
          out.includes("/tmp/run-test/final.md") &&
          /NEXT STEP/.test(out),
        out.split("\n")[0] ?? "(empty)",
      ),
    );
  }

  const ok = r.every(Boolean);
  console.log(ok ? "DELIVERY-RENDER-SELFTEST PASSED: clarification + normal rendering correct" : "DELIVERY-RENDER-SELFTEST FAILED");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("delivery-render selftest crashed:", err);
  process.exitCode = 1;
});
