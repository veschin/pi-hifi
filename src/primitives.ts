// Work-primitive layer (architecture §1-2) - the designed core.
//
// A task is decomposed into a DAG of small work-primitives. Each primitive has a
// typed, HARD-TO-FAKE I/O contract and a checklist (the hifiGate). hifi lives in
// the primitives, not the orchestrator: no matter how a task is composed, the
// output is hifi (every gate passed) or HONESTLY FLAGGED (a gate failed, the
// failure recorded and carried forward).
//
// THE TWO CHANNELS (architecture §1):
//   claim       - what the work-model SAYS. Cheap to fake. Diagnostic only.
//   observation - what the SYSTEM did: a sandbox-executed run, a real exit code,
//                 a parsed structural fact. The model cannot author this channel.
// DESIGN RULE: every gate reads the OBSERVATION channel only, never the claim.
// A primitive is hard-to-fake when its load-bearing output sits on observation.
//
// This file reuses the existing machinery (generator/judge/auditor/assembler
// prompts, runCandidateSelfTest, runVerification) - it FORMALIZES the ad-hoc
// runHifi stages as catalog primitives with gates; it does not re-invent them.

import { execEvidenceToText, runCandidateSelfTest } from "./exec.ts";
import type { SubCallClient } from "./llm.ts";
import {
  ASSEMBLER_SYSTEM,
  assemblerUser,
  JUDGE_SYSTEM,
  generatorSystem,
  generatorUser,
  judgeUser,
} from "./prompts.ts";
import { parseExperiment } from "./runner.ts";
import { parseVerdict } from "./selector.ts";
import { atomsReportText, runVerification } from "./verifier.ts";
import type {
  AxisWinner,
  EvidenceAtom,
  ExecEvidence,
  HolisticVerdict,
  PairVerdict,
  ProgressFn,
  TaskMode,
} from "./types.ts";

// --- Observation channel (the un-fakeable output of every primitive) ----------

export type ObservationKind = "candidate" | "run" | "verdict" | "audit" | "final";

interface ObservationBase {
  kind: ObservationKind;
  /**
   * The model's prose (claim channel). Recorded for audit/debugging ONLY -
   * no gate and no downstream wiring is permitted to depend on it.
   */
  claim: string;
}

/** `gen` output: a candidate answer + the STRUCTURAL fact of whether it ships a
 *  falsifiable self-test (observed by parseExperiment, not asserted). */
export interface CandidateObservation extends ObservationBase {
  kind: "candidate";
  text: string;
  /** True when generated in code mode (the gate then requires a self-test). The
   *  gate cannot infer this from selftestPresent alone - a non-code candidate and
   *  a defective code candidate both have selftestPresent=false. */
  codeCandidate: boolean;
  /** Structural fact: a `<lang> selftest` block is present (falsifiable artifact). */
  selftestPresent: boolean;
  /** A language with a LOCAL runner (executable here), else null (ships flagged). */
  runnableLang: string | null;
}

/** `run` output: real execution evidence - the hardest-to-fake channel. Carries
 *  the candidate it ran forward so a downstream `judge` can compare on evidence. */
export interface RunObservation extends ObservationBase {
  kind: "run";
  candidate: string;
  evidence: ExecEvidence;
}

/** `judge` output: the winning candidate selected on evidence, with the winner's
 *  own execution evidence carried forward for grounding downstream. */
export interface VerdictObservation extends ObservationBase {
  kind: "verdict";
  winnerText: string;
  winnerEvidence: ExecEvidence | null;
  /** True when the judge could not separate the candidates (NOT a silent pick). */
  tie: boolean;
  /** Whether the judge saw any execution evidence at all (grounding indicator). */
  sawEvidence: boolean;
}

/** `audit` output: claim-by-claim verdicts + the holistic verifier verdict. */
export interface AuditObservation extends ObservationBase {
  kind: "audit";
  atoms: EvidenceAtom[];
  holistic: HolisticVerdict | null;
  /**
   * True when the auditor had run evidence available for any execution-kind atom
   * (invariant 7: exec-claims need run-evidence present; the atom-VERDICT, not
   * this flag, decides whether the evidence confirms or contradicts the claim).
   * False = the answer made execution claims with no run evidence to check them.
   */
  execEvidenceAvailable: boolean;
}

/** `synthesize` output: the final answer assembled from verified observations. */
export interface FinalObservation extends ObservationBase {
  kind: "final";
  answer: string;
  /** The verbatim winning solution block this answer is required to preserve. */
  preservedSolution: string | null;
}

export type Observation =
  | CandidateObservation
  | RunObservation
  | VerdictObservation
  | AuditObservation
  | FinalObservation;

// --- The gate (architecture §2 "checklist" column) ----------------------------

export interface GateResult {
  pass: boolean;
  /** Why it passed, or - on failure - exactly what the checklist caught. */
  reason: string;
}

// --- The primitive contract ---------------------------------------------------

export type PrimitiveName = "gen" | "run" | "judge" | "audit" | "synthesize";
export type Tier = "W" | "S";

/** Declarative dependency contract - the composer validates wiring against it
 *  STATICALLY (kinds + arity) before any execution, so only type-compatible
 *  primitives are wired (architecture §3 "typed I/O wires only compatible"). */
export interface DepSpec {
  min: number;
  /** null = unbounded. */
  max: number | null;
  /** Observation-kinds this primitive may consume; empty = source primitive. */
  kinds: ObservationKind[];
}

/** Everything a primitive needs from the run, threaded by the composer. */
export interface PrimitiveContext {
  client: SubCallClient;
  /** The shared task materials (invariant-13 identical text for every call). */
  task: string;
  mode: TaskMode;
  polyglot: boolean;
  execEnabled: boolean;
  execTimeoutMs: number;
  /** Stable label prefix for sub-call artifacts, e.g. the work-order id. */
  label: string;
  onProgress?: ProgressFn;
}

/** Literal parameters carried on a WorkOrder (the model-chosen knobs). */
export interface WorkInput {
  /** Extra spec/criteria/angle appended to the task for this order (gen lanes). */
  spec?: string;
  /** Sampling temperature for this lane (gen diversity). */
  temperature?: number;
}

export interface Primitive {
  name: PrimitiveName;
  tier: Tier;
  produces: ObservationKind;
  deps: DepSpec;
  /**
   * Finer wiring rules the declarative DepSpec (arity + kinds) cannot express,
   * checked STATICALLY by the composer at DAG-validation time (architecture §3).
   * Receives the ORDERED dep kinds; returns an error string or null. Optional -
   * most primitives are fully specified by DepSpec alone.
   */
  validateDeps?(depKinds: ObservationKind[]): string | null;
  /**
   * Do the work and return the OBSERVATION. Never throws on model-level failure
   * (a failed sub-call yields an observation whose gate then fails); only budget
   * exhaustion and external abort propagate, exactly like the SubCallClient.
   */
  execute(input: WorkInput, deps: Observation[], ctx: PrimitiveContext): Promise<Observation>;
  /** The checklist over the observation. Reads observation fields ONLY. */
  gate(obs: Observation): GateResult;
}

// --- Shared helpers -----------------------------------------------------------

const pass = (reason: string): GateResult => ({ pass: true, reason });
const fail = (reason: string): GateResult => ({ pass: false, reason });

/** A failed self-test that RAN is a valid observation (failure observed
 *  verbatim, §2 `run` checklist); "ran" is the grounding fact, exit code is not. */
function ranObserved(e: ExecEvidence): boolean {
  return e.ran === true;
}

/** Structural read of a candidate answer (no model trust): does it ship a
 *  selftest block, and is its language locally runnable? */
function inspectCandidate(text: string): { selftestPresent: boolean; runnableLang: string | null } {
  const parsed = parseExperiment(text);
  if (!("error" in parsed)) return { selftestPresent: true, runnableLang: parsed.lang };
  // parseExperiment failed (no locally-runnable pair). A COMPLETE pair in a
  // non-runnable language (unsupported / mismatch) still ships a falsifiable
  // artifact; a missing block does not. A falsifiable selftest needs BOTH blocks
  // (a selftest alone has nothing to falsify), so require both present.
  const hasSolution = /```[a-zA-Z0-9+]+\s+solution\s*\n/.test(text);
  const hasSelftest = /```[a-zA-Z0-9+]+\s+selftest\s*\n/.test(text);
  return { selftestPresent: hasSolution && hasSelftest, runnableLang: null };
}

// --- gen ----------------------------------------------------------------------

const gen: Primitive = {
  name: "gen",
  tier: "W",
  produces: "candidate",
  deps: { min: 0, max: 0, kinds: [] },
  async execute(input, _deps, ctx): Promise<CandidateObservation> {
    const taskText = input.spec ? `${ctx.task}\n\n# Additional focus for this candidate\n\n${input.spec}` : ctx.task;
    ctx.onProgress?.(`[gen:${ctx.label}] generating candidate`);
    const outcome = await ctx.client.call({
      role: "generator",
      label: `${ctx.label}.gen`,
      systemPrompt: generatorSystem(ctx.mode, ctx.polyglot),
      userText: generatorUser(taskText),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });
    const codeCandidate = ctx.mode === "code";
    if (!outcome.ok) {
      return { kind: "candidate", claim: outcome.error ?? "generation failed", text: "", codeCandidate, selftestPresent: false, runnableLang: null };
    }
    const inspected = codeCandidate ? inspectCandidate(outcome.text) : { selftestPresent: false, runnableLang: null };
    return { kind: "candidate", claim: "", text: outcome.text, codeCandidate, ...inspected };
  },
  gate(obs): GateResult {
    const o = obs as CandidateObservation;
    if (o.text.trim() === "") return fail("candidate is empty (generation failed)");
    // Code candidates MUST ship a falsifiable self-test (architecture §2 gen
    // checklist); non-code modes have no self-test concept, so non-empty is the
    // bar. The gate reads codeCandidate + selftestPresent (parsed structural
    // facts), never the model's prose.
    if (!o.codeCandidate) return pass("non-code candidate, non-empty");
    return o.selftestPresent
      ? pass(`ships a self-test${o.runnableLang ? ` (${o.runnableLang}, runnable)` : " (present, not locally runnable)"}`)
      : fail("code candidate ships no falsifiable self-test block");
  },
};

// --- run ----------------------------------------------------------------------

const run: Primitive = {
  name: "run",
  tier: "W",
  produces: "run",
  deps: { min: 1, max: 1, kinds: ["candidate"] },
  async execute(_input, deps, ctx): Promise<RunObservation> {
    const cand = deps[0] as CandidateObservation;
    if (!ctx.execEnabled) {
      return {
        kind: "run",
        claim: "",
        candidate: cand.text,
        evidence: { ran: false, exitCode: null, stdout: "", stderr: "", timedOut: false, skippedReason: "execution disabled (no sandbox tier / opt-out)" },
      };
    }
    ctx.onProgress?.(`[run:${ctx.label}] executing candidate self-test in sandbox`);
    const evidence = await runCandidateSelfTest(cand.text, ctx.execTimeoutMs);
    return { kind: "run", claim: "", candidate: cand.text, evidence };
  },
  gate(obs): GateResult {
    const o = obs as RunObservation;
    // §2 `run` checklist: "observed, not predicted; failure verbatim". The gate
    // passes when the experiment REALLY RAN (ran=true) regardless of exit code -
    // a non-zero exit is a valid, load-bearing observation. It fails only when no
    // execution happened, so a non-runnable candidate is flagged, never faked.
    if (!ranObserved(o.evidence)) return fail(`not executed: ${o.evidence.skippedReason ?? "unknown reason"}`);
    const status = o.evidence.timedOut ? "TIMED OUT" : `exit ${o.evidence.exitCode}`;
    return pass(`executed (observed ${status})`);
  },
};

// --- judge --------------------------------------------------------------------

interface JudgeItem {
  ref: number;
  text: string;
  evidence: ExecEvidence | null;
}

function passedSelfTest(e: ExecEvidence | null): boolean {
  return e?.ran === true && e.exitCode === 0 && !e.timedOut;
}

const judge: Primitive = {
  name: "judge",
  tier: "S",
  produces: "verdict",
  deps: { min: 2, max: null, kinds: ["run", "candidate"] },
  async execute(_input, deps, ctx): Promise<VerdictObservation> {
    const items: JudgeItem[] = deps.map((d, ref) =>
      d.kind === "run"
        ? { ref, text: d.candidate, evidence: d.evidence }
        : { ref, text: (d as CandidateObservation).text, evidence: null },
    );
    const viable = items.filter((it) => it.text.trim() !== "");
    const sawEvidence = viable.some((it) => it.evidence !== null && it.evidence.ran);

    if (viable.length === 0) {
      return { kind: "verdict", claim: "no viable candidate to judge", winnerText: "", winnerEvidence: null, tie: false, sawEvidence: false };
    }
    if (viable.length === 1) {
      const only = viable[0]!;
      return { kind: "verdict", claim: "single viable candidate (no pairwise comparison)", winnerText: only.text, winnerEvidence: only.evidence, tie: false, sawEvidence };
    }

    // Round-robin pairwise tournament on evidence axes (reuses JUDGE_SYSTEM +
    // parseVerdict - the identical judging contract the linear selector uses).
    const wins: Record<number, number> = {};
    const axisWins: Record<number, number> = {};
    for (const it of viable) { wins[it.ref] = 0; axisWins[it.ref] = 0; }

    for (let i = 0; i < viable.length; i++) {
      for (let j = i + 1; j < viable.length; j++) {
        const a = viable[i]!;
        const b = viable[j]!;
        ctx.onProgress?.(`[judge:${ctx.label}] pair ${a.ref} vs ${b.ref}`);
        const outcome = await ctx.client.call({
          role: "judge",
          label: `${ctx.label}.judge.${a.ref}v${b.ref}`,
          systemPrompt: JUDGE_SYSTEM,
          userText: judgeUser(ctx.task, a.text, execEvidenceToText(a.evidence), b.text, execEvidenceToText(b.evidence)),
          temperature: 0,
        });
        const verdict: Omit<PairVerdict, "a" | "b"> | null = outcome.ok ? parseVerdict(outcome.text) : null;
        // Unparseable / failed verdicts degrade to tie (never to a winner) -
        // invariant 6: an ungrounded verdict must not award a win.
        const axes = verdict?.axes ?? { comprehension: "tie" as AxisWinner, causality: "tie" as AxisWinner, grounding: "tie" as AxisWinner };
        const overall = verdict?.overall ?? "tie";
        const award = (w: AxisWinner, table: Record<number, number>) => {
          if (w === "a") table[a.ref] = (table[a.ref] ?? 0) + 1;
          else if (w === "b") table[b.ref] = (table[b.ref] ?? 0) + 1;
        };
        award(overall, wins);
        award(axes.comprehension, axisWins);
        award(axes.causality, axisWins);
        award(axes.grounding, axisWins);
      }
    }

    // Deterministic winner: overall wins -> axis wins -> passing self-test ->
    // lowest ref (invariant 11). A genuine all-tie is reported as tie=true.
    const ranked = [...viable].sort((x, y) => {
      const w = (wins[y.ref] ?? 0) - (wins[x.ref] ?? 0);
      if (w !== 0) return w;
      const ax = (axisWins[y.ref] ?? 0) - (axisWins[x.ref] ?? 0);
      if (ax !== 0) return ax;
      const t = Number(passedSelfTest(y.evidence)) - Number(passedSelfTest(x.evidence));
      if (t !== 0) return t;
      return x.ref - y.ref;
    });
    const winner = ranked[0]!;
    const second = ranked[1];
    // A tie is when the winner could NOT be separated from the runner-up on
    // judged evidence (equal overall wins AND equal axis wins) - the pick then
    // came only from the deterministic tiebreaker, so it is flagged, not
    // presented as a confident evidence pick (§2 "tie != silent pick").
    const tie =
      second !== undefined &&
      (wins[winner.ref] ?? 0) === (wins[second.ref] ?? 0) &&
      (axisWins[winner.ref] ?? 0) === (axisWins[second.ref] ?? 0);
    return { kind: "verdict", claim: "", winnerText: winner.text, winnerEvidence: winner.evidence, tie, sawEvidence };
  },
  gate(obs): GateResult {
    const o = obs as VerdictObservation;
    if (o.winnerText.trim() === "") return fail("judge produced no winner (no viable candidate)");
    // §2 `judge` checklist: "sees experiment evidence; tie != silent pick". A tie
    // is allowed but must be EXPLICIT (o.tie), never resolved into a silent pick.
    if (o.tie) return pass("explicit tie recorded (not a silent pick)");
    return pass(`winner selected${o.sawEvidence ? " on execution evidence" : " (no execution evidence available)"}`);
  },
};

// --- audit --------------------------------------------------------------------

const audit: Primitive = {
  name: "audit",
  tier: "W",
  produces: "audit",
  deps: { min: 1, max: 1, kinds: ["verdict", "run", "candidate"] },
  async execute(_input, deps, ctx): Promise<AuditObservation> {
    const dep = deps[0]!;
    const { answer, evidence } =
      dep.kind === "verdict"
        ? { answer: dep.winnerText, evidence: dep.winnerEvidence }
        : dep.kind === "run"
          ? { answer: dep.candidate, evidence: dep.evidence }
          : { answer: (dep as CandidateObservation).text, evidence: null };
    ctx.onProgress?.(`[audit:${ctx.label}] claim extraction + atom audit`);
    const report = await runVerification({ client: ctx.client, task: ctx.task, answer, execEvidence: evidence, ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}) });
    // Structural backstop (invariant 7): when the answer makes execution-kind
    // claims, the auditor must have had real run evidence to check them against;
    // whether that evidence CONFIRMS or CONTRADICTS the claim is the atom verdict's
    // job, not this flag's. No execution atoms => trivially satisfied.
    const execAtoms = report.atoms.filter((a) => a.kind === "execution");
    const execEvidenceAvailable = execAtoms.length === 0 || (evidence !== null && evidence.ran);
    return { kind: "audit", claim: report.holistic?.summary ?? "", atoms: report.atoms, holistic: report.holistic, execEvidenceAvailable };
  },
  gate(obs): GateResult {
    const o = obs as AuditObservation;
    if (o.atoms.length === 0 && o.holistic === null) return fail("audit produced neither atoms nor a holistic verdict");
    if (!o.execEvidenceAvailable) return fail("answer makes execution claims but no run evidence was available to audit them");
    return pass(`${o.atoms.length} atom(s) audited; holistic=${o.holistic?.verdict ?? "n/a"}`);
  },
};

// --- synthesize ---------------------------------------------------------------

/** Extract the verbatim `<lang> solution` block body, if any (artifact identity). */
function solutionBlock(text: string): string | null {
  const parsed = parseExperiment(text);
  return "error" in parsed ? null : parsed.solution;
}

const synthesize: Primitive = {
  name: "synthesize",
  tier: "S",
  produces: "final",
  deps: { min: 1, max: null, kinds: ["verdict", "run", "candidate", "audit"] },
  // DepSpec kinds alone permit an all-audit dep list (which has nothing to
  // finalize). Require EXACTLY ONE artifact dep + at most one audit, statically.
  validateDeps(depKinds): string | null {
    const artifacts = depKinds.filter((k) => k !== "audit");
    const audits = depKinds.filter((k) => k === "audit");
    if (artifacts.length !== 1) return `synthesize needs exactly one artifact dep (verdict|run|candidate), got ${artifacts.length}`;
    if (audits.length > 1) return `synthesize takes at most one audit dep, got ${audits.length}`;
    return null;
  },
  async execute(_input, deps, ctx): Promise<FinalObservation> {
    const auditDep = deps.find((d): d is AuditObservation => d.kind === "audit");
    const artifactDep = deps.find((d) => d.kind !== "audit");
    if (!artifactDep) {
      return { kind: "final", claim: "no artifact to synthesize", answer: "", preservedSolution: null };
    }
    const { answer: candidate, evidence } =
      artifactDep.kind === "verdict"
        ? { answer: artifactDep.winnerText, evidence: artifactDep.winnerEvidence }
        : artifactDep.kind === "run"
          ? { answer: artifactDep.candidate, evidence: artifactDep.evidence }
          : { answer: (artifactDep as CandidateObservation).text, evidence: null };

    const atomsReport = auditDep ? atomsReportText(auditDep.atoms) : "(no claim audit was run)";
    const issues =
      auditDep?.holistic && auditDep.holistic.criticalIssues.length > 0
        ? auditDep.holistic.criticalIssues.map((i) => `- ${i}`).join("\n")
        : "(none)";

    ctx.onProgress?.(`[synthesize:${ctx.label}] assembling final answer from verified material`);
    const outcome = await ctx.client.call({
      role: "generator",
      label: `${ctx.label}.synthesize`,
      systemPrompt: ASSEMBLER_SYSTEM,
      userText: assemblerUser(ctx.task, candidate, atomsReport, issues),
      temperature: 0.2,
    });
    const preservedSolution = solutionBlock(candidate);

    // Artifact identity over polish: SELF-HEAL to the winner verbatim whenever the
    // assembler failed OR altered/dropped the verified solution block. We never
    // ship code the assembler changed - that code was never grounded. The gate is
    // the defense-in-depth backstop; this keeps a legitimate run from being
    // rejected just because the model reformatted a block.
    let answer: string;
    let claim = "";
    if (!outcome.ok) {
      answer = candidate;
      claim = outcome.error ?? "assembly failed; shipped winner verbatim";
    } else if (preservedSolution !== null && !outcome.text.includes(preservedSolution.trim())) {
      answer = candidate;
      claim = "assembler altered the verified solution block; shipped winner verbatim";
    } else {
      answer = outcome.text;
    }

    // Attach an honest execution-status footer when the winner's test was NOT a
    // passing run, so an un-grounded answer is flagged rather than silently shipped.
    if (preservedSolution !== null && !passedSelfTest(evidence)) {
      const note = evidence === null || !evidence.ran ? "the solution was NOT executed here" : `the self-test did not pass (${evidence.timedOut ? "timed out" : `exit ${evidence.exitCode}`})`;
      if (!/Verification status/i.test(answer)) answer += `\n\n## Verification status\n\nUnverified: ${note}.`;
    }
    return { kind: "final", claim, answer, preservedSolution };
  },
  gate(obs): GateResult {
    const o = obs as FinalObservation;
    if (o.answer.trim() === "") return fail("final answer is empty");
    // §2 `synthesize` checklist: "only verified; blocks verbatim". The hard-to-
    // fake invariant: when the artifact carried a runnable solution block, the
    // SHIPPED answer must contain it VERBATIM - synthesize cannot swap in code
    // that was never grounded (artifact identity == the code that produced the
    // observation). An audit note may license a correction; absent that, verbatim.
    if (o.preservedSolution !== null && !o.answer.includes(o.preservedSolution.trim())) {
      return fail("synthesized answer dropped/altered the verified solution block (artifact identity broken)");
    }
    return pass(o.preservedSolution !== null ? "final answer preserves the verified solution block" : "final answer assembled");
  },
};

// --- The fixed catalog --------------------------------------------------------

/**
 * The catalog is FIXED and extensible only by us (architecture §2): the model
 * composes from it, never invents a primitive. Adding a primitive = adding one
 * entry here (executor + gate) - one place, audited.
 */
export const CATALOG: Record<PrimitiveName, Primitive> = { gen, run, judge, audit, synthesize };

export const PRIMITIVE_NAMES = Object.keys(CATALOG) as PrimitiveName[];

export function isPrimitiveName(name: string): name is PrimitiveName {
  return Object.prototype.hasOwnProperty.call(CATALOG, name);
}

/** Render an observation's load-bearing summary for logs / collect snapshots. */
export function observationSummary(obs: Observation): string {
  switch (obs.kind) {
    case "candidate":
      return `candidate (${obs.text.length} chars; selftest=${obs.selftestPresent}; lang=${obs.runnableLang ?? "n/a"})`;
    case "run":
      return obs.evidence.ran ? `run (exit ${obs.evidence.exitCode}${obs.evidence.timedOut ? ", TIMED OUT" : ""})` : `run (not executed: ${obs.evidence.skippedReason ?? "?"})`;
    case "verdict":
      return obs.winnerText === "" ? "verdict (no winner)" : `verdict (winner ${obs.winnerText.length} chars; tie=${obs.tie}; sawEvidence=${obs.sawEvidence})`;
    case "audit":
      return `audit (${obs.atoms.length} atoms; holistic=${obs.holistic?.verdict ?? "n/a"})`;
    case "final":
      return `final (${obs.answer.length} chars)`;
  }
}
