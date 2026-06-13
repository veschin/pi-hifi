---
id: handoff
kind: guide
---

# Handoff

## Operating mode (the user's standing directive for this project)

Work **autonomously and continuously** - do NOT stop for check-ins; take the work
all the way to the finish at **production-hifi quality**. Spending on real pi runs
(cheap-flash classification, live smokes, paid eval) to VERIFY is sanctioned - do
not ask before spending on verification. Non-negotiable bars: verify FREE first
(selftests, no LLM) before paying; "done" means OBSERVED behavior, never "looks
right"; commit each verified slice to `feat/sandbox` with what-was-verified in the
body; critic before the completion message, `model:opus` for any
sandbox/isolation/security change. Stop to ask ONLY when a decision is genuinely
the user's and unresolvable from context - and do the safely-completable work
first. Never cram a large item into exhausted context (break it into committed
green slices).

---

## READ THIS FIRST - the honest status (do not skip)

**The designed CORE IS NOW BUILT and PROVEN end-to-end.** The prior failure
("built perimeter, deferred the core") is resolved. `docs/pi-hifi-architecture.md`
§1-3 (work-primitive catalog + composer) exists in code, free-tested, and proven
live: `decompose -> gen -> run -> judge -> synthesize` ran on a real code task with
the OBSERVED sandbox exit code load-bearing (not prose). See
[25_composer.md](25_composer.md) and [devlog 05](devlog/05_devlog_composer_primitives.md).

What is built (4 committed green slices, feat/sandbox, NOT pushed):

- `src/primitives.ts` - the two-channel contract (observation vs claim; gates read
  observation ONLY) + the fixed catalog of 5 primitives (gen/run/judge/audit/
  synthesize), each reusing existing machinery + a real hifiGate.
- `src/composer.ts` - `validateGraph` (static typed-I/O guarantee) +
  `runComposer` (topological parallel execution, gate-flag-propagate, budget/
  checkpoint/collect) + `buildCanonicalGraph`.
- `src/decompose.ts` - the strong entry: task -> validated catalog DAG (bounded
  depth, fail-safe-deeper, never invents a primitive).
- `src/composer-pipeline.ts` - `runComposerHifi`, the composer execution path
  behind `config.composer.enabled` (default OFF). `runHifi` is UNTOUCHED and
  stays the default + eval-pinned path until the composer reaches measured parity.

**The composer is OFF by default.** `runHifi` (the linear middle) is still the
production + eval path. The next job is to MEASURE the composer against it and,
once at parity, flip the default - then grow the catalog.

---

## THE TASK - next steps (the real backlog now that the core exists)

Pick the next committed green slice. Suggested order:

1. **Parity measurement.** Run the composer path against the linear path on the
   eval (`eval/run-eval.ts` pins composer OFF for the baseline; add a composer
   arm). The published code eval is SATURATED (flash 0.96->1.00) - it likely
   cannot discriminate; you may need harder tasks (the analyzer/scoring
   discipline in [50_eval.md](50_eval.md)). Do NOT flip `composer.enabled`
   default to true until parity is OBSERVED, not assumed.
2. **Per-primitive cheap model (old 3.4 D1).** Bind `gen` to flash while
   judge/synthesize stay strong - NOW SAFE because the gates ground cheap output
   (the strong+weak design, architecture §0/1.5). It was unsafe on the linear
   pipeline (no objective oracle per round); under the composer's run-gate it is
   safe. Add as a per-primitive model knob; measure.
3. **Grow the catalog** (architecture §2, "more is better"): `probe` (old 3.6,
   archRisk spike: build PoC -> run -> observe), the RESEARCH tier
   (read/grep/web.fetch - observation-dominant), `test`/`bench`/`typecheck`.
   Each = one catalog row (executor + hifiGate) + a free gate selftest.
4. **Checkpoint stateless-resume protocol.** The composer detects a checkpoint
   pause but currently ships best-so-far + a warning instead of returning a
   clarification (documented CONTRACT GAP in `composer-pipeline.ts` + 25_composer).
   Wire the resume before shipping any checkpoint-bearing graph.
5. **Unify the duplicated front.** `runComposerHifi` mirrors ~90 lines of
   runHifi's front (deliberate isolation during the parallel-paths phase). Once
   the composer reaches parity and replaces the linear middle, factor a shared
   `prepareRun`/`finishRun` and delete runHifi's middle.

Drive at MEASUREMENT next (1): the core is built; the open question is whether it
beats the linear path and where. Everything else is additive on a proven core.

---

## Mistakes - do NOT repeat

1. **Built perimeter, deferred the core** (the prior central failure - now
   RESOLVED). The lesson stands: when the design names a core, build the core
   first; treat perimeter as subordinate.
2. **False green**: a test must assert a GUARANTEED invariant, never an emergent
   artifact. (The primitive gates are tested on synthetic observations; the
   hard-to-fake proofs - lying claim ignored, artifact identity - are the
   load-bearing ones.)
3. **Don't add a gate that fires against the thesis.** `run.gate` PASSES a
   FAILED-but-executed test (failure observed verbatim IS grounding); it fails
   only when nothing ran. A gate that suppressed execution grounding would be the
   old oracle=none mistake again.
4. **A behavior flag must reach EVERY stage** (grep the assumption). `materials`
   (invariant 13/18 shared text) must reach decompose AND the composer ctx.task;
   `execEnabled` must thread into the PrimitiveContext.
5. **Default-open on a security boundary** -> fail-closed. The composer path's
   admission gate is byte-faithful to runHifi (no tier + !allowUnsandboxed ->
   exec DISABLED). opus-verified.
6. **Shared-value wiring**: grep every call site when a field must reach all
   consumers; tsc does not catch non-propagation.
7. **hifi = OBSERVED behavior.** Every "done" traces to a run you executed.
   Verify FREE before paying.
8. **Sandbox/isolation/admission is a SECURITY BOUNDARY - critic `model:opus`.**
9. **Cheap-model gen is safe ONLY under grounding** (the composer's gates). Don't
   blind-flip it on the un-gated linear path.
10. **Eval comparability pinned by single lines** in `run-eval.ts` pinnedConfig
    (triage/brief/context/delivery/polyglot/**composer** all OFF). Removing any
    diverges from `docs/eval-results/20260611-164416`.
11. **`__setSandboxTier` is test-only** (throws without `APODEX_TEST_HOOKS=1`).
12. **Don't cram a large item into exhausted context.** Committed green slices only.

---

## What IS built (reuse - do NOT rebuild). feat/sandbox, ~22 commits ahead of main, NOT pushed.

- **The composer core** (this session): `src/primitives.ts`, `src/composer.ts`,
  `src/decompose.ts`, `src/composer-pipeline.ts` - see above + 25_composer.md.
- **Sandbox** (`src/sandbox.ts`, `sandbox-pool.ts`, `runner.ts`, `exec.ts`):
  rootless cell + admission scheduler + node/python runner. `execAdmission` is the
  single security authority; `allowUnsandboxed` default FALSE. The composer's
  `run` primitive routes through `runCandidateSelfTest` -> this layer.
- **Triage** (`src/triage.ts`): CompositionPlan classifier; fronts decompose.
- **Polyglot** (`config.polyglot`): generatorSystem/analystSystem; feeds `gen`.
- **Linear pipeline** (`src/pipeline.ts` `runHifi`): the DEFAULT path; the
  composer's peer until parity. `classifyMode` is exported (reused by the composer
  path). The roles (selector/JUDGE_SYSTEM/atom-auditor/GVR/verifier) are now ALSO
  formalized as catalog primitives - the ad-hoc stages remain for the linear path.
- **Delivery/UX** (`index.ts`): composeDelivery/composeClarification; dispatches
  `config.composer.enabled ? runComposerHifi : runHifi`; /hifi+/apodex.

---

## Orient / smoke (run before changing anything)

```bash
cd ~/ai/pi-apodex
npx tsc --noEmit
npx tsx eval/selfcheck.ts                 # refs 1.00, broken 0.50-0.56
npx tsx eval/primitives-selftest.ts       # FREE 35 - the catalog gates
npx tsx eval/composer-selftest.ts         # FREE 26 - validation + executor
npx tsx eval/decompose-selftest.ts        # FREE 16 - bounded depth + fail-safe
npx tsx eval/triage-selftest.ts           # FREE 17
npx tsx eval/exec-selftest.ts ; npx tsx eval/generator-selftest.ts
npx tsx eval/delivery-render-selftest.ts
./docs/llm/validate.sh
# LIVE (paid, proves the composer end-to-end; needs deepseek auth + rootless tier):
#   npx tsx eval/smoke-composer.ts        # 11/11, ~$0.02
# tiered host only (else SKIP): sandbox-selftest, sandbox-pool-selftest,
#   runner-selftest, smoke-triage, smoke-polyglot, exec-gate-smoke, smoke-pipeline
```

Read order: this file -> [25_composer.md](25_composer.md) (THE built core) ->
`docs/pi-hifi-architecture.md` §1-3 (the design) -> [20_pipeline.md](20_pipeline.md)
(the linear path the composer parallels) -> [30_subcall_infra.md](30_subcall_infra.md)
-> [50_eval.md](50_eval.md) (before measuring) ->
`docs/research/test-time-boosting.md` (the science).
