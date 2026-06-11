// Causal-evidence candidate selector.
//
// Samples N candidates in parallel (temperature-diversified), gathers execution
// evidence for each (code mode), then runs a round-robin pairwise tournament
// judged on three axes: comprehension, causality, empirical grounding. The
// judge sees candidates + execution evidence only - never generator reasoning.
// Winner = most overall wins; ties broken by axis wins, then by passing
// self-test, then by lowest index (deterministic).

import { BudgetExhaustedError } from "./budget.ts";
import { runCandidateSelfTest } from "./exec.ts";
import { parseJsonLoose } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import { JUDGE_SYSTEM, generatorSystem, generatorUser, judgeUser } from "./prompts.ts";
import type {
  AxisWinner,
  Candidate,
  ExecEvidence,
  PairVerdict,
  ProgressFn,
  SelectionResult,
  TaskMode,
} from "./types.ts";

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

export interface SelectorOptions {
  client: SubCallClient;
  task: string;
  mode: TaskMode;
  /** N, 1..8 (validated upstream). */
  candidates: number;
  execEnabled: boolean;
  execTimeoutMs: number;
  onProgress?: ProgressFn;
}

function evidenceText(evidence: ExecEvidence | null): string {
  if (!evidence) return "(no execution evidence)";
  if (!evidence.ran) {
    return `Self-test was NOT executed. Reason: ${evidence.skippedReason ?? "unknown"}.`;
  }
  const status = evidence.timedOut
    ? `TIMED OUT`
    : `exit code ${evidence.exitCode ?? "unknown"} (${evidence.exitCode === 0 ? "PASS" : "FAIL"})`;
  return [
    `Self-test executed: ${status}`,
    evidence.stdout.trim() ? `--- stdout ---\n${evidence.stdout.trim()}` : "(empty stdout)",
    evidence.stderr.trim() ? `--- stderr ---\n${evidence.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isAxisWinner(value: unknown): value is AxisWinner {
  return value === "a" || value === "b" || value === "tie";
}

interface RawVerdict {
  comprehension?: unknown;
  causality?: unknown;
  grounding?: unknown;
  overall?: unknown;
  rationale?: unknown;
}

function parseVerdict(text: string): Omit<PairVerdict, "a" | "b"> | null {
  const raw = parseJsonLoose<RawVerdict>(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { comprehension, causality, grounding, overall } = raw;
  if (!isAxisWinner(comprehension) || !isAxisWinner(causality) || !isAxisWinner(grounding) || !isAxisWinner(overall)) {
    return null;
  }
  return {
    axes: { comprehension, causality, grounding },
    overall,
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
  };
}

async function generateCandidates(opts: SelectorOptions): Promise<Candidate[]> {
  opts.onProgress?.(`selector: generating ${opts.candidates} candidates in parallel`);
  const system = generatorSystem(opts.mode);
  const user = generatorUser(opts.task);

  const results = await Promise.all(
    Array.from({ length: opts.candidates }, (_, index) =>
      opts.client
        .call({
          role: "generator",
          label: `selector.candidate.${index}`,
          systemPrompt: system,
          userText: user,
          temperature: 0.8,
        })
        .then(
          (outcome) => ({ index, outcome }),
          (err: unknown) => {
            // BudgetExhaustedError must stop the whole stage, not vanish in Promise.all.
            if (err instanceof BudgetExhaustedError) throw err;
            return {
              index,
              outcome: {
                ok: false as const,
                text: "",
                record: null,
                error: err instanceof Error ? err.message : String(err),
              },
            };
          },
        ),
    ),
  );

  const candidates: Candidate[] = [];
  for (const { index, outcome } of results) {
    const candidate: Candidate = {
      index,
      text: outcome.ok ? outcome.text : "",
      execEvidence: null,
    };
    if (!outcome.ok) candidate.generationError = outcome.error ?? "generation failed";
    candidates.push(candidate);
  }
  return candidates;
}

async function attachExecEvidence(opts: SelectorOptions, candidates: Candidate[]): Promise<void> {
  if (opts.mode !== "code") return;
  for (const candidate of candidates) {
    if (candidate.generationError) continue;
    if (!opts.execEnabled) {
      candidate.execEvidence = {
        ran: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        skippedReason: "execution disabled by config",
      };
      continue;
    }
    opts.onProgress?.(`selector: running self-test of candidate ${candidate.index}`);
    candidate.execEvidence = await runCandidateSelfTest(candidate.text, opts.execTimeoutMs);
  }
}

function passedSelfTest(candidate: Candidate): boolean {
  return candidate.execEvidence?.ran === true && candidate.execEvidence.exitCode === 0 && !candidate.execEvidence.timedOut;
}

export async function runSelection(opts: SelectorOptions): Promise<SelectionResult> {
  if (opts.candidates < 1) throw new SelectorError(`candidates must be >= 1, got ${opts.candidates}`);

  const candidates = await generateCandidates(opts);
  const viable = candidates.filter((c) => !c.generationError && c.text.trim() !== "");
  if (viable.length === 0) {
    throw new SelectorError(
      `all ${opts.candidates} candidate generations failed: ${candidates
        .map((c) => c.generationError ?? "empty")
        .join("; ")}`,
    );
  }

  await attachExecEvidence(opts, candidates);

  // Single viable candidate: nothing to compare.
  if (viable.length === 1) {
    const winner = viable[0];
    if (!winner) throw new SelectorError("internal: viable[0] missing");
    return { winnerIndex: winner.index, candidates, pairs: [], wins: { [winner.index]: 0 } };
  }

  // Round-robin pairwise tournament.
  const wins: Record<number, number> = {};
  const axisWins: Record<number, number> = {};
  for (const c of viable) {
    wins[c.index] = 0;
    axisWins[c.index] = 0;
  }

  const pairJobs: Array<[Candidate, Candidate]> = [];
  for (let i = 0; i < viable.length; i++) {
    for (let j = i + 1; j < viable.length; j++) {
      const a = viable[i];
      const b = viable[j];
      if (a && b) pairJobs.push([a, b]);
    }
  }

  opts.onProgress?.(`selector: judging ${pairJobs.length} pairs on evidence axes`);
  const pairs: PairVerdict[] = [];
  // Sequential judging keeps call volume predictable under the budget guard;
  // pair count is small (N<=8 -> <=28 pairs, typical 4 -> 6 pairs).
  for (const [a, b] of pairJobs) {
    const outcome = await opts.client.call({
      role: "worker",
      label: `selector.judge.${a.index}v${b.index}`,
      systemPrompt: JUDGE_SYSTEM,
      userText: judgeUser(opts.task, a.text, evidenceText(a.execEvidence), b.text, evidenceText(b.execEvidence)),
      temperature: 0,
    });

    const base: PairVerdict = {
      a: a.index,
      b: b.index,
      axes: { comprehension: "tie", causality: "tie", grounding: "tie" },
      overall: "tie",
      rationale: "",
    };

    if (outcome.ok) {
      const parsed = parseVerdict(outcome.text);
      if (parsed) {
        base.axes = parsed.axes;
        base.overall = parsed.overall;
        base.rationale = parsed.rationale;
      } else {
        base.judgeError = "unparseable judge verdict; treated as tie";
      }
    } else {
      base.judgeError = outcome.error ?? "judge call failed; treated as tie";
    }
    pairs.push(base);

    const award = (axisOrOverall: AxisWinner, weight: number, table: Record<number, number>) => {
      if (axisOrOverall === "a") table[a.index] = (table[a.index] ?? 0) + weight;
      else if (axisOrOverall === "b") table[b.index] = (table[b.index] ?? 0) + weight;
    };
    award(base.overall, 1, wins);
    award(base.axes.comprehension, 1, axisWins);
    award(base.axes.causality, 1, axisWins);
    award(base.axes.grounding, 1, axisWins);
  }

  // Deterministic winner: overall wins -> axis wins -> passed self-test -> lowest index.
  const ranked = [...viable].sort((x, y) => {
    const winDiff = (wins[y.index] ?? 0) - (wins[x.index] ?? 0);
    if (winDiff !== 0) return winDiff;
    const axisDiff = (axisWins[y.index] ?? 0) - (axisWins[x.index] ?? 0);
    if (axisDiff !== 0) return axisDiff;
    const testDiff = Number(passedSelfTest(y)) - Number(passedSelfTest(x));
    if (testDiff !== 0) return testDiff;
    return x.index - y.index;
  });

  const winner = ranked[0];
  if (!winner) throw new SelectorError("internal: tournament produced no winner");
  opts.onProgress?.(`selector: winner is candidate ${winner.index} (${wins[winner.index] ?? 0} wins)`);
  return { winnerIndex: winner.index, candidates, pairs, wins };
}
