---
id: composer
kind: spec
touches: src/primitives.ts, src/composer.ts, src/decompose.ts
---

# Work-primitive layer + composer contracts

See also: [20_pipeline.md](20_pipeline.md) (the linear `runHifi` this evolves
from) · [30_subcall_infra.md](30_subcall_infra.md) (the reused sub-call/exec
machinery) · [../pi-hifi-architecture.md](../pi-hifi-architecture.md) (the design
§1-3).

Status (2026-06-14): the primitive layer (`src/primitives.ts`) and the composer
(`src/composer.ts`) are BUILT and free-tested (`eval/primitives-selftest.ts`,
`eval/composer-selftest.ts`). `decompose` and pipeline wiring land in later
slices; until then `runHifi` (20_pipeline.md) is still the execution path.

## The two channels (architecture §1) - the trust principle

Every primitive output carries two channels:

- **claim** - what the work-model SAYS. Cheap to fake. Diagnostic only.
- **observation** - what the SYSTEM did: a sandbox-executed run, a real exit
  code, a parsed structural fact. The model cannot author this channel.

**Enforced design rule**: every `hifiGate` reads OBSERVATION fields only, never
the `claim`. A primitive is hard-to-fake when its load-bearing output sits on
the observation channel. The primitives-selftest proves this directly: a lying
claim cannot satisfy any gate.

## Primitive contract (`src/primitives.ts`)

A `Primitive` = `{ name, tier, produces, deps, validateDeps?, execute, gate }`:

- `produces`: the `ObservationKind` it emits
  (`candidate|run|verdict|audit|final`).
- `deps: DepSpec` = `{ min, max, kinds }` - the declarative wiring contract
  (arity + accepted dep kinds), checked statically by the composer.
- `validateDeps?(depKinds)`: finer static rules the DepSpec cannot express
  (e.g. `synthesize` needs exactly one artifact dep + at most one audit).
- `execute(input, deps, ctx) -> Observation`: never throws on model failure (a
  failed sub-call yields an observation whose gate then fails); only
  `BudgetExhaustedError` / abort propagate (same contract as SubCallClient).
- `gate(observation) -> {pass, reason}`: the §2 checklist. Reads observation
  fields only.

**hifi lives in the primitives, not the orchestrator** (architecture §0): no
matter how a task is composed, the output is hifi (every gate passed) or
HONESTLY FLAGGED (a gate failed, recorded and carried forward).

## The fixed catalog (5 primitives, REUSE not rebuild)

The catalog is FIXED and extended only by us; the model composes from it, never
invents a primitive. Each row reuses existing machinery:

| primitive | tier | produces | deps | reuses | gate (the checklist) |
|---|---|---|---|---|---|
| `gen` | W | candidate | none | `generatorSystem` (polyglot) + `parseExperiment` | code candidate ships a falsifiable self-test (structural: both blocks present); non-code = non-empty |
| `run` | W | run | 1×candidate | `runCandidateSelfTest` (sandbox pool) | OBSERVED, not predicted: passes iff `evidence.ran===true` - a FAILED test (exit!=0) PASSES (failure verbatim is valid grounding); fails only when nothing ran |
| `judge` | S | verdict | >=2×(run\|candidate) | `JUDGE_SYSTEM` + `parseVerdict` round-robin | a winner exists; `tie!=silent pick` (an all-tie is flagged `tie:true`); unparseable verdict degrades to tie, never a win (invariant 6) |
| `audit` | W | audit | 1×(verdict\|run\|candidate) | `runVerification` (atoms + holistic) | atoms or holistic produced; exec-kind claims had run evidence available (invariant 7) |
| `synthesize` | S | final | 1 artifact + opt 1 audit | `ASSEMBLER_SYSTEM` | non-empty; **artifact identity**: the shipped answer preserves the winner's verbatim solution block (synthesize cannot ship un-grounded code). Self-heals to the winner verbatim if the assembler altered/dropped it |

`gen.execute` records `codeCandidate` (mode) so the gate distinguishes a non-code
answer from a defective code answer (both have `selftestPresent=false`).
`synthesize.execute` appends an honest "Verification status" footer when the
winner's test was not a passing run.

## The composer (`src/composer.ts`)

`WorkOrder` = `{ id, primitive, input, deps, checkpoint?, collect? }`;
`WorkGraph` = `{ orders }`. `deps` are the order ids whose OBSERVATIONS feed this
one (order is significant - judge/synthesize read deps positionally).

### `validateGraph(graph) -> string[]` (the typed-I/O guarantee)

Static, run BEFORE any execution. Empty list = executable. Checks: non-empty;
unique ids; known primitives (catalog-only); no dangling/self/duplicate deps (a
duplicate dep would feed the same observation twice - e.g. judge a candidate
against itself); arity (`DepSpec.min..max`); kind compatibility (every dep's
`produces` ∈ accepted `kinds`); `validateDeps`; acyclicity (Kahn). The cycle pass is INDEPENDENT of
kind/arity errors but gated on resolvable deps (no dangling/duplicate). This is
what makes the DAG "predictable, not a free builder" - `decompose` output runs
only if it validates.

### `runComposer(graph, base, opts) -> ComposerResult`

Throws `ComposerError` on an invalid graph (callers MUST validate first - the
executor's precondition). Otherwise:

- **Topological layers**: orders whose deps are all finished run together; a
  layer is dispatched with `Promise.allSettled` (independent orders run in
  PARALLEL; sandbox-pool admission + budget guard bound real concurrency).
- **Gate failure = FLAG + PROPAGATE**, never block: a failed-gate observation
  still feeds downstream (architecture §0 "or honestly flagged"); the warning is
  recorded and `hifi` becomes false. This matches the existing
  ship-always-flagged contract - the composer never deadlocks a code task on a
  tier-less host. The ONLY skips are cascades from a dep that produced NO
  observation (budget stop, abort, unexpected crash).
- **Budget exhaustion**: stops dispatch, records remaining orders skipped,
  returns best-so-far (`budgetExhausted:true`); never throws away paid work
  (invariant 10 parity). Abort stops dispatch.
- **`checkpoint`**: an order with `checkpoint:true` that PASSES its gate pauses
  the run (`paused:{afterOrderId}`); downstream is left skipped. Resume is
  stateless re-invocation (wiring deferred to the pipeline slice).
- **`collect`**: an order with a `collect` label snapshots its observation via
  `opts.collect` (the pipeline wires this to `RunStore`).
- **Output**: the sink order (nothing depends on it); a `synthesize`/`final`
  sink is preferred. `hifi` = every order executed AND passed its gate AND none
  skipped AND not paused/exhausted.

### `buildCanonicalGraph({candidates, code, withAudit?})`

Deterministic default DAG shape (the proof-of-concept the composer runs
end-to-end), always validateGraph-clean:

- code, N>=2: `gen×N -> run×N -> judge -> [audit] -> synthesize`
- code, N=1: `gen -> run -> [audit] -> synthesize`
- non-code: `gen×N -> [judge] -> [audit] -> synthesize`

## decompose (`src/decompose.ts`) - the strong entry

`runDecompose(client, task, composition, opts) -> {graph, plan, source}` turns a
TRIAGED task into a validated work-graph. Same discipline as triage (invariant
19 / 1.7): the model fills a FIXED vocabulary, this code decides structure. The
model's only freedom is DEPTH:

- `candidates` (1..`maxCandidates`): how many independent gen lanes to compare.
- `with_audit` (bool): insert the `audit` primitive before synthesis.

It NEVER emits raw graph topology and NEVER invents a primitive: deterministic
`buildGraphFromPlan(plan, mode)` wires the validated catalog DAG
(`buildCanonicalGraph`) from the depth + the classified mode. `parseDecomposePlan`
CLAMPS `candidates` into `1..maxCandidates` (the budget envelope) and returns
null only when there is no usable integer.

Control flow mirrors `runTriage`: one strong call (role `analyst`) + one bounded
re-ask. **FAIL-SAFE = order MORE, never cheaper**: an unparseable/failed decompose
returns the robust default plan (`defaultCandidates` + `with_audit:true`), NEVER a
silent shallow one. Budget exhaustion and abort PROPAGATE (the run stops rather
than guessing). The "ask the user" escape is triage's `needsDialog`, upstream of
decompose - decompose itself never pauses.

Rationale for bounded-knobs over a free model-emitted DAG: decompose reliability
is the dominant risk (architecture §6); a mis-wired DAG (cycle, invented
primitive, wrong arity) is structurally impossible when the graph is
catalog-derived. Richer free-form decomposition is deferred until measured to
help. Tradeoff: the model cannot express task-specific topologies (e.g. per-lane
gen specs) yet - not needed to prove the canonical chain.

## Pipeline wiring (`src/composer-pipeline.ts`)

`runComposerHifi` is the composer EXECUTION PATH, selected by
`config.composer.enabled` (default FALSE, env `APODEX_COMPOSER`, file
`composer.enabled`). `index.ts` dispatches `config.composer.enabled ?
runComposerHifi : runHifi`; both take the same options and return a `HifiResult`,
so delivery/clarification rendering is identical downstream.

`runComposerHifi` mirrors runHifi's SHARED front stages (triage with mega
early-return -> brief with clarification exits -> context -> classify ->
admission gate), then `decompose -> runComposer -> delivery -> handoff`. It reuses
the exported stage functions (`runTriage`, `runBriefStage`, `gatherContext`,
`classifyMode`, `execAdmission`, `planDelivery`, `renderHandoff`). The
admission-gate policy is byte-faithful to runHifi (fail-closed: no tier +
`!allowUnsandboxed` -> exec DISABLED, answers ship flagged "not executed");
`execEnabled` threads into the composer's `PrimitiveContext` so `run` honors it.
`materials` (invariant 13/18 shared text) is built identically and reaches
decompose AND the composer's `ctx.task` (so gen/judge/synthesize see the same
text). `extractFinalAnswer` pulls the deliverable (final answer, else best-so-far
verdict winner / candidate). Budget: front/decompose budget exhaustion THROWS
(fail loud if no answer); runComposer's exhaustion is IN-BAND (best-so-far).

**runHifi is UNTOUCHED** (only `classifyMode` is now exported); the eval pins
`composer:false` for comparability. The front-stage SEQUENCE is duplicated here
(not yet factored into a shared helper) to keep the eval-pinned linear path at
zero regression risk during the parallel-paths phase; it collapses when the
composer replaces the linear middle. KNOWN GAP: a `checkpoint` pause is currently
surfaced as a warning + best-so-far, NOT returned as a clarification - the
checkpoint slice must wire the stateless-resume protocol before shipping a
checkpoint-bearing graph.

## Tests (free, no LLM)

- `eval/primitives-selftest.ts` (35 checks): every gate on synthetic
  observations + the hard-to-fake proofs (lying claim ignored, artifact
  identity, judge verdict degradation); `execute` paths via a stubbed client
  (gen structural detection, judge tournament determinism, synthesize
  self-heal/footer).
- `eval/decompose-selftest.ts` (16 checks): the bounded-depth parser (clamping
  into the budget envelope + truthy coercion), every graph shape
  validateGraph-clean, and runDecompose control flow (good / re-ask /
  fail-safe-DEEPER / budget propagation).
- `eval/composer-selftest.ts` (26 checks): every `validateGraph` error class +
  canonical-graph validity; the executor over the REAL catalog via a stubbed
  client (all-pass hifi, gate-flag-propagate vs skip-on-failed-dep, budget stop,
  checkpoint pause, collect snapshots, multi-sink fallback); `extractFinalAnswer`
  best-so-far extraction.

## Live smoke (paid, `eval/smoke-composer.ts`)

Proves the chain end-to-end on a real code task with real models + the real
rootless sandbox. Two runs: (1) `runComposerHifi` with decompose choosing depth
(observed: triage code/micro/execute -> decompose N=1 -> gen PASS -> run PASS
**real exit 0** -> synthesize PASS, hifi=true); (2) a forced N=2 graph exercising
the full `gen×2 -> run×2 -> judge -> synthesize` (judge picks a winner on real
sandbox evidence, `sawEvidence=true`). Verified 2026-06-14: 11/11 assertions
PASS, ~$0.02, ~2 min.
