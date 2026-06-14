---
id: devlog-05
kind: devlog
---

# Devlog 05 - the composer + work-primitive layer, built and proven (2026-06-14)

## Why

The central failure recorded in the prior handoff: the DESIGN
(`docs/pi-hifi-architecture.md` §2-3 - a work-primitive catalog + a composer)
was NOT built. Every prior session decorated the linear `runHifi` pipeline
(triage, polyglot, sandbox, admission, rename) and deferred the core at every
fork. This session's only goal was to BUILD THE CORE - the typed, hard-to-fake
primitive layer with per-primitive hifiGates, the DAG composer, and decompose -
and prove it real end-to-end, not extend the perimeter again.

Delivered as four committed green vertical slices; `runHifi` stays the default
path (eval-pinned) until the composer reaches measured parity.

## What was built

### Slice 1 - primitive contracts + fixed catalog (410bf91)

`src/primitives.ts`: the two-channel contract (architecture §1) - every
primitive emits an OBSERVATION (un-fakeable: exit code, real output, parsed
structural fact) + a CLAIM (model prose, diagnostic only). Enforced design rule:
every `hifiGate` reads observation fields ONLY. Discriminated `Observation`
union, `GateResult`, `Primitive` (DepSpec arity+kinds + optional `validateDeps`).
Fixed catalog of 5 primitives REUSING existing machinery: gen (generatorSystem +
parseExperiment), run (runCandidateSelfTest), judge (JUDGE_SYSTEM + parseVerdict
tournament), audit (runVerification), synthesize (ASSEMBLER_SYSTEM). The
load-bearing gate is `run`: passes iff `evidence.ran===true` - a FAILED-but-
executed test PASSES (failure observed verbatim is valid grounding); only "could
not run" fails. `eval/primitives-selftest.ts`: 35 free checks, the key ones
proving a lying CLAIM cannot satisfy any gate and synthesize cannot ship code the
assembler altered (artifact identity).

### Slice 2 - DAG executor + static validation (f5ca5e9)

`src/composer.ts`: `validateGraph` (the typed-I/O guarantee, STATIC: unique ids,
catalog-only primitives, no dangling/self/duplicate deps, arity, kinds,
validateDeps, acyclicity by Kahn - the cycle pass independent of kind/arity
errors but gated on resolvable deps). `runComposer`: topological LAYERS
(independent orders parallel via allSettled); gate failure = FLAG + PROPAGATE
(architecture §0 "or honestly flagged"), never block, so a code task on a
tier-less host ships flagged instead of deadlocking; budget stop returns
best-so-far; checkpoint pauses; collect snapshots; sink = preferred non-skipped
synthesize. `buildCanonicalGraph` deterministic shapes. `eval/composer-selftest.ts`:
26 free checks over the REAL catalog via a stubbed client.

### Slice 3 - decompose (135adff)

`src/decompose.ts`: the strong entry. Same discipline as triage (invariant
19/1.7) - the model fills a FIXED vocabulary, this code decides structure. The
model's only freedom is DEPTH (candidates 1..max, with_audit); it NEVER emits raw
topology and NEVER invents a primitive (deterministic buildGraphFromPlan wires a
catalog DAG, so a cyclic/invalid graph is structurally impossible). FAIL-SAFE =
order MORE (deeper + audit), never cheaper; budget/abort propagate. 16 free
checks.

### Slice 4 - wire + prove end-to-end (a97857f)

`src/composer-pipeline.ts` `runComposerHifi`: the composer EXECUTION PATH,
selected by `config.composer.enabled` (default OFF). Mirrors runHifi's shared
front (triage/brief/context/classify/admission), reusing the exported stage
functions, then decompose -> runComposer -> delivery. `runHifi` UNTOUCHED
(export-only on classifyMode); eval pins composer OFF.

## Decisions + critic rounds

- **Bounded-knobs decompose over a free model-emitted DAG.** Decompose
  reliability is the architecture's dominant risk (§6); a catalog-derived graph
  makes a mis-wired/cyclic/invented-primitive DAG structurally impossible.
  Tradeoff named: no task-specific topologies yet (not needed to prove the
  canonical chain). Free-form decomposition deferred until measured to help.
- **Separate runComposerHifi, runHifi untouched.** Lowest-risk path: the
  eval-pinned linear path carries zero regression risk while the two paths run in
  parallel. The duplicated front collapses when the composer replaces the linear
  middle. (Acknowledged tech-debt, documented in 25_composer.md.)
- Critic caught and fixed: judge.axes wrong for N>2 (removed); synthesize
  all-audit validateDeps hole; synthesize self-heal to winner-verbatim on
  assembler block-drop; composer duplicate-dep validation hole (judge a candidate
  vs itself); skipped-sink fallback; decompose with_audit truthy-int coercion.
- **opus critic** (security boundary) traced the admission-gate replication +
  materials propagation line-by-line: CONFIRMED SOUND (fail-closed preserved,
  identical shared text). Fixed: run.json brief-field log parity,
  extractFinalAnswer whitespace check, checkpoint-pause contract-gap comment.

## Verification (the proof)

FREE first, every slice: tsc clean -> selftest -> selfcheck unchanged (refs
1.00) -> critic -> commit. Then the LIVE proof
(`eval/smoke-composer.ts`, deepseek pro/flash + rootless sandbox, ~$0.02, 11/11):

- Run 1 (decompose decides): triage code/micro/execute -> decompose N=1 (the
  model judged the task simple) -> gen PASS -> run PASS **observed real exit 0 in
  the sandbox** -> synthesize PASS (preserves the solution block), hifi=true.
- Run 2 (forced N=2): gen×2 -> run×2 (both observed) -> judge PASS (winner on
  evidence, sawEvidence=true) -> synthesize PASS, hifi=true.

`decompose -> gen -> run -> judge -> synthesize` proven end-to-end with the
OBSERVED evidence (exit codes), not prose, load-bearing.

## Next (the real backlog now that the core exists)

- Measure composer vs linear on the eval (parity gate before flipping the
  default); the saturated code eval may need harder tasks to discriminate.
- Per-primitive cheap model (3.4 D1: gen->flash) - now SAFE because the gates
  ground cheap output (the strong+weak design, architecture §0/1.5).
- New primitives (the catalog is meant to grow): `probe` (3.6, archRisk spike),
  the RESEARCH tier (read/grep/web), `test`/`bench`/`typecheck`.
- Checkpoint stateless-resume protocol (the documented contract gap before any
  checkpoint-bearing graph ships).
- Unify the duplicated front (prepareRun/finishRun) once the composer replaces
  the linear middle.
