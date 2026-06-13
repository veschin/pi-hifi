// Free (no live LLM) proof of the work-primitive layer (src/primitives.ts):
// every primitive's hifiGate and the catalog wiring contract (DepSpec arity +
// produces). The load-bearing assertions are the HARD-TO-FAKE ones: a gate must
// read the OBSERVATION channel and IGNORE a lying claim. Stubbed sub-calls drive
// the execute() paths that need a model (gen inspection, judge tournament,
// synthesize assembly) so the structural detection is proven too - no network.
//
// Every assertion is a GUARANTEED invariant of the gate/wiring, never an emergent
// artifact (lesson 90-class: a test that codifies a side effect is a false green).
//
// Run: npx tsx eval/primitives-selftest.ts

import {
  CATALOG,
  PRIMITIVE_NAMES,
  isPrimitiveName,
  type AuditObservation,
  type CandidateObservation,
  type FinalObservation,
  type Observation,
  type PrimitiveContext,
  type RunObservation,
  type VerdictObservation,
} from "../src/primitives.ts";
import { SubCallClient } from "../src/llm.ts";
import type { EvidenceAtom, ExecEvidence, HolisticVerdict, SubCallOutcome, SubCallRecord, SubCallRequest, TaskMode } from "../src/types.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

// --- builders ---------------------------------------------------------------

function evidence(p: Partial<ExecEvidence>): ExecEvidence {
  return { ran: false, exitCode: null, stdout: "", stderr: "", timedOut: false, ...p };
}

function codeAnswer(solution: string, selftest: string): string {
  return ["```js solution", solution, "```", "", "```js selftest", selftest, "```", "", "Approach: trivial."].join("\n");
}

const GOOD_SOLUTION = "export const inc = (n) => n + 1;";
const GOOD_SELFTEST = 'import { inc } from "./solution.mjs";\nif (inc(1) !== 2) process.exit(1);\nconsole.log("ok");';
const GOOD_CODE = codeAnswer(GOOD_SOLUTION, GOOD_SELFTEST);

function cand(p: Partial<CandidateObservation>): CandidateObservation {
  return { kind: "candidate", claim: "", text: "x", codeCandidate: false, selftestPresent: false, runnableLang: null, ...p };
}
function runObs(p: Partial<RunObservation>): RunObservation {
  return { kind: "run", claim: "", candidate: "x", evidence: evidence({}), ...p };
}
function verdict(p: Partial<VerdictObservation>): VerdictObservation {
  return { kind: "verdict", claim: "", winnerText: "x", winnerEvidence: null, tie: false, sawEvidence: false, ...p };
}
function auditObs(p: Partial<AuditObservation>): AuditObservation {
  return { kind: "audit", claim: "", atoms: [], holistic: null, execEvidenceAvailable: true, ...p };
}
function finalObs(p: Partial<FinalObservation>): FinalObservation {
  return { kind: "final", claim: "", answer: "x", preservedSolution: null, ...p };
}
function atom(p: Partial<EvidenceAtom>): EvidenceAtom {
  return { id: "a1", claim: "c", kind: "fact", support: "s", verdict: "verified", note: "", ...p };
}

// --- scriptable stub SubCallClient ------------------------------------------

function outcome(ok: boolean, text: string, error?: string): SubCallOutcome {
  const record = { label: "stub", responseText: text } as unknown as SubCallRecord;
  return error !== undefined ? { ok, text, record, error } : { ok, text, record };
}

function stubClient(handler: (req: SubCallRequest, i: number) => SubCallOutcome): SubCallClient {
  let i = 0;
  const stub = { call: async (req: SubCallRequest): Promise<SubCallOutcome> => handler(req, i++) };
  return stub as unknown as SubCallClient;
}

function ctx(client: SubCallClient, mode: TaskMode, execEnabled: boolean): PrimitiveContext {
  return { client, task: "Increment a number.", mode, polyglot: false, execEnabled, execTimeoutMs: 5_000, label: "t" };
}

const gate = (name: keyof typeof CATALOG, obs: Observation) => CATALOG[name].gate(obs);

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  const r: boolean[] = [];

  // 1. Catalog wiring contract (DepSpec arity + produces) - the typed-I/O spec.
  r.push(
    line(
      "catalog: names + produces",
      JSON.stringify(PRIMITIVE_NAMES) === JSON.stringify(["gen", "run", "judge", "audit", "synthesize"]) &&
        CATALOG.gen.produces === "candidate" &&
        CATALOG.run.produces === "run" &&
        CATALOG.judge.produces === "verdict" &&
        CATALOG.audit.produces === "audit" &&
        CATALOG.synthesize.produces === "final" &&
        isPrimitiveName("gen") &&
        !isPrimitiveName("nope"),
      PRIMITIVE_NAMES.join(","),
    ),
  );
  r.push(
    line(
      "catalog: dep arity + kinds",
      CATALOG.gen.deps.min === 0 && CATALOG.gen.deps.max === 0 &&
        CATALOG.run.deps.min === 1 && CATALOG.run.deps.max === 1 && CATALOG.run.deps.kinds.join() === "candidate" &&
        CATALOG.judge.deps.min === 2 && CATALOG.judge.deps.max === null && CATALOG.judge.deps.kinds.join() === "run,candidate" &&
        CATALOG.audit.deps.min === 1 && CATALOG.audit.deps.max === 1 &&
        CATALOG.synthesize.deps.min === 1 && CATALOG.synthesize.deps.max === null,
      "arities as designed",
    ),
  );
  // synthesize.validateDeps closes the all-audit hole the DepSpec cannot express.
  r.push(
    line(
      "synthesize validateDeps: needs exactly one artifact + opt audit",
      CATALOG.synthesize.validateDeps !== undefined &&
        CATALOG.synthesize.validateDeps(["audit"]) !== null &&
        CATALOG.synthesize.validateDeps(["verdict"]) === null &&
        CATALOG.synthesize.validateDeps(["verdict", "audit"]) === null &&
        CATALOG.synthesize.validateDeps(["verdict", "run"]) !== null &&
        CATALOG.synthesize.validateDeps(["verdict", "audit", "audit"]) !== null,
      "all-audit and multi-artifact rejected",
    ),
  );

  // 2. gen GATE invariants (synthetic observations).
  r.push(line("gen gate: empty -> fail", !gate("gen", cand({ text: "  " })).pass, "empty rejected"));
  r.push(line("gen gate: code + selftest -> pass", gate("gen", cand({ codeCandidate: true, selftestPresent: true, text: GOOD_CODE })).pass, "selftest accepted"));
  r.push(line("gen gate: code + NO selftest -> fail", !gate("gen", cand({ codeCandidate: true, selftestPresent: false, text: "just prose" })).pass, "missing selftest rejected"));
  r.push(line("gen gate: non-code + non-empty -> pass", gate("gen", cand({ codeCandidate: false, text: "a design" })).pass, "non-code accepted"));
  // HARD-TO-FAKE: a lying claim ("ships a selftest") cannot satisfy the gate when
  // the structural fact says otherwise.
  r.push(
    line(
      "gen gate: lying claim IGNORED (reads structural fact)",
      !gate("gen", cand({ codeCandidate: true, selftestPresent: false, claim: "I shipped a thorough self-test, it passes." })).pass,
      "claim cannot fake selftestPresent",
    ),
  );

  // 3. gen EXECUTE path proves the structural detection (inspectCandidate) via a stub.
  {
    const c = ctx(stubClient(() => outcome(true, GOOD_CODE)), "code", false);
    const obs = (await CATALOG.gen.execute({}, [], c)) as CandidateObservation;
    r.push(line("gen execute: detects shipped selftest", obs.selftestPresent && obs.runnableLang === "node" && CATALOG.gen.gate(obs).pass, `selftestPresent=${obs.selftestPresent} lang=${obs.runnableLang}`));
  }
  {
    const c = ctx(stubClient(() => outcome(true, "Here is some prose with no code blocks at all.")), "code", false);
    const obs = (await CATALOG.gen.execute({}, [], c)) as CandidateObservation;
    r.push(line("gen execute: no selftest -> gate fail", !obs.selftestPresent && !CATALOG.gen.gate(obs).pass, `selftestPresent=${obs.selftestPresent}`));
  }

  // 4. run GATE invariants - the thesis core: a FAILED test that RAN is grounding.
  r.push(line("run gate: ran + exit 0 -> pass", gate("run", runObs({ evidence: evidence({ ran: true, exitCode: 0 }) })).pass, "pass observed"));
  r.push(line("run gate: ran + exit 1 (FAILED) -> PASS (failure verbatim)", gate("run", runObs({ evidence: evidence({ ran: true, exitCode: 1 }) })).pass, "observed failure is valid grounding"));
  r.push(line("run gate: ran + timeout -> pass (observed)", gate("run", runObs({ evidence: evidence({ ran: true, timedOut: true, exitCode: null }) })).pass, "timeout observed"));
  r.push(line("run gate: NOT executed -> fail", !gate("run", runObs({ evidence: evidence({ ran: false, skippedReason: "no selftest" }) })).pass, "skip rejected"));
  // HARD-TO-FAKE: a claim of success cannot satisfy the gate when ran=false.
  r.push(
    line(
      "run gate: lying claim IGNORED (reads evidence.ran)",
      !gate("run", runObs({ evidence: evidence({ ran: false }), claim: "All tests passed, exit 0." })).pass,
      "claim cannot fake execution",
    ),
  );

  // 5. run EXECUTE with exec disabled -> honest not-executed observation, gate fail.
  {
    const obs = (await CATALOG.run.execute({}, [cand({ text: GOOD_CODE })], ctx(stubClient(() => outcome(false, "")), "code", false))) as RunObservation;
    r.push(line("run execute: exec disabled -> ran:false + gate fail", obs.evidence.ran === false && !CATALOG.run.gate(obs).pass, obs.evidence.skippedReason ?? "?"));
  }

  // 6. judge GATE invariants.
  r.push(line("judge gate: winner, non-tie -> pass", gate("judge", verdict({ winnerText: "A", sawEvidence: true })).pass, "winner on evidence"));
  r.push(line("judge gate: explicit tie -> pass (not silent)", gate("judge", verdict({ winnerText: "A", tie: true })).pass, "tie is explicit"));
  r.push(line("judge gate: no winner -> fail", !gate("judge", verdict({ winnerText: "" })).pass, "no winner rejected"));

  // 7. judge EXECUTE: single viable, zero viable, and a scripted 2-way tournament.
  {
    const c = ctx(stubClient(() => outcome(false, "")), "code", false);
    const single = (await CATALOG.judge.execute({}, [runObs({ candidate: "ONLY", evidence: evidence({ ran: true, exitCode: 0 }) }), cand({ text: "" })], c)) as VerdictObservation;
    r.push(line("judge execute: single viable -> that winner, gate pass", single.winnerText === "ONLY" && CATALOG.judge.gate(single).pass, single.claim));
    const none = (await CATALOG.judge.execute({}, [cand({ text: "" }), cand({ text: "  " })], c)) as VerdictObservation;
    r.push(line("judge execute: zero viable -> no winner, gate fail", none.winnerText === "" && !CATALOG.judge.gate(none).pass, "empty rejected"));
  }
  {
    // Scripted judge: A wins every axis -> deterministic winner A regardless of order.
    const aWins = JSON.stringify({ comprehension: "a", causality: "a", grounding: "a", overall: "a", rationale: "A grounded" });
    const c = ctx(stubClient(() => outcome(true, aWins)), "code", false);
    const v = (await CATALOG.judge.execute({}, [runObs({ candidate: "A", evidence: evidence({ ran: true, exitCode: 0 }) }), runObs({ candidate: "B", evidence: evidence({ ran: true, exitCode: 1 }) })], c)) as VerdictObservation;
    r.push(line("judge execute: tournament picks evidence winner", v.winnerText === "A" && !v.tie && v.sawEvidence && CATALOG.judge.gate(v).pass, `winner=${v.winnerText} tie=${v.tie}`));
    // Scripted all-tie -> deterministic tiebreak by passing self-test, flagged tie.
    const allTie = JSON.stringify({ comprehension: "tie", causality: "tie", grounding: "tie", overall: "tie", rationale: "even" });
    const c2 = ctx(stubClient(() => outcome(true, allTie)), "code", false);
    const v2 = (await CATALOG.judge.execute({}, [runObs({ candidate: "P", evidence: evidence({ ran: true, exitCode: 1 }) }), runObs({ candidate: "Q", evidence: evidence({ ran: true, exitCode: 0 }) })], c2)) as VerdictObservation;
    r.push(line("judge execute: all-tie -> tiebreak passing test, tie flagged", v2.winnerText === "Q" && v2.tie === true, `winner=${v2.winnerText} tie=${v2.tie}`));
  }

  // 8. audit GATE invariants.
  r.push(line("audit gate: atoms + evidence available -> pass", gate("audit", auditObs({ atoms: [atom({})], holistic: { verdict: "approve", summary: "", criticalIssues: [] } as HolisticVerdict, execEvidenceAvailable: true })).pass, "audited"));
  r.push(line("audit gate: no atoms + no holistic -> fail", !gate("audit", auditObs({ atoms: [], holistic: null })).pass, "empty audit rejected"));
  r.push(line("audit gate: exec-claims, no run evidence -> fail", !gate("audit", auditObs({ atoms: [atom({ kind: "execution" })], execEvidenceAvailable: false })).pass, "ungrounded exec rejected"));

  // 9. synthesize GATE invariants - artifact identity is the hard-to-fake core.
  r.push(line("synthesize gate: empty -> fail", !gate("synthesize", finalObs({ answer: "  " })).pass, "empty rejected"));
  r.push(line("synthesize gate: preserves block -> pass", gate("synthesize", finalObs({ answer: `intro\n${GOOD_SOLUTION}\noutro`, preservedSolution: GOOD_SOLUTION })).pass, "block preserved"));
  r.push(
    line(
      "synthesize gate: DROPS verified block -> fail (artifact identity)",
      !gate("synthesize", finalObs({ answer: "Trust me, the code works great.", preservedSolution: GOOD_SOLUTION })).pass,
      "swapped-out code rejected",
    ),
  );
  r.push(line("synthesize gate: non-code (null block) + non-empty -> pass", gate("synthesize", finalObs({ answer: "a design answer", preservedSolution: null })).pass, "non-code accepted"));

  // 10. synthesize EXECUTE: preserve, drop (gate catches), and assembly-failed fallback.
  {
    const winner = GOOD_CODE;
    // Assembler returns an answer that KEEPS the block -> gate pass.
    const keep = ctx(stubClient(() => outcome(true, `Refined.\n\n${GOOD_CODE}\n\nNotes.`)), "code", false);
    const f1 = (await CATALOG.synthesize.execute({}, [verdict({ winnerText: winner, winnerEvidence: evidence({ ran: true, exitCode: 0 }) })], keep)) as FinalObservation;
    r.push(line("synthesize execute: preserves block -> gate pass", CATALOG.synthesize.gate(f1).pass, "preserved"));
    // Assembler DROPS the block -> execute SELF-HEALS to the winner verbatim
    // (artifact identity: never ship code the assembler altered). Gate then passes
    // because the verified block is intact.
    const drop = ctx(stubClient(() => outcome(true, "I rewrote it differently and it is fine.")), "code", false);
    const f2 = (await CATALOG.synthesize.execute({}, [verdict({ winnerText: winner, winnerEvidence: evidence({ ran: true, exitCode: 0 }) })], drop)) as FinalObservation;
    r.push(line("synthesize execute: assembler drops block -> SELF-HEAL to winner", f2.answer.includes(GOOD_SOLUTION) && CATALOG.synthesize.gate(f2).pass, "self-healed verbatim"));
    // Assembly call fails -> winner shipped verbatim -> gate pass (block intact).
    const failC = ctx(stubClient(() => outcome(false, "", "provider down")), "code", false);
    const f3 = (await CATALOG.synthesize.execute({}, [verdict({ winnerText: winner, winnerEvidence: evidence({ ran: true, exitCode: 0 }) })], failC)) as FinalObservation;
    r.push(line("synthesize execute: assembly fails -> winner verbatim, gate pass", f3.answer.includes(GOOD_SOLUTION) && CATALOG.synthesize.gate(f3).pass, "verbatim fallback"));
    // Un-grounded winner (no run) -> answer flagged with a Verification status.
    const unground = ctx(stubClient(() => outcome(true, GOOD_CODE)), "code", false);
    const f4 = (await CATALOG.synthesize.execute({}, [verdict({ winnerText: winner, winnerEvidence: null })], unground)) as FinalObservation;
    r.push(line("synthesize execute: ungrounded winner -> flagged unverified", /Verification status/i.test(f4.answer) && /Unverified/i.test(f4.answer), "honesty footer added"));
    // Failed run (exit 1) in code mode -> footer cites the observed exit code.
    const failRun = ctx(stubClient(() => outcome(true, GOOD_CODE)), "code", false);
    const f5 = (await CATALOG.synthesize.execute({}, [verdict({ winnerText: winner, winnerEvidence: evidence({ ran: true, exitCode: 1 }) })], failRun)) as FinalObservation;
    r.push(line("synthesize execute: failed run -> footer cites exit 1", /Verification status/i.test(f5.answer) && /exit 1/i.test(f5.answer), "exit-1 flagged"));
  }

  const ok = r.every(Boolean);
  console.log(ok ? `\nPRIMITIVES-SELFTEST PASSED (${r.length} checks, free): gates read observation, ignore claims` : "\nPRIMITIVES-SELFTEST FAILED");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("PRIMITIVES-SELFTEST CRASHED:", err);
  process.exitCode = 1;
});
