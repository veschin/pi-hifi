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
green slices). See the `pi-hifi-autonomous-mode` memory note.

---

## READ THIS FIRST - the honest status (do not skip)

**The DESIGN is NOT built.** `docs/pi-hifi-architecture.md` specifies a
**work-primitive catalog (§2) + a composer (§3)**: `decompose` -> a DAG of typed
work-orders, each with a hard-to-fake I/O contract and a per-primitive checklist
(`hifiGate`), executed in parallel with a gate between stages, then `synthesize`.
**That system does not exist.**

What actually runs is still the **OLD linear pipeline** `runHifi`
(brief -> context -> classify -> [select] -> GVR -> verify -> assemble -> deliver) - the
exact stage pipeline the architecture doc marks **"supersedes the stage-based
rev.2"**. Everything shipped so far is **perimeter + infrastructure bolted onto
that old pipeline**, not the designed architecture:

- Real design INFRA that exists and is reusable: the **sandbox pool** (the
  experiment executor), **triage** (a front classifier), **polyglot** generation
  (stack-agnostic experiments), the exec **admission** gate.
- The DESIGN ITSELF - the **primitive layer** (typed I/O + `hifiGate` per
  primitive) and the **composer** (decompose -> WorkOrder DAG -> gated parallel
  execution -> synthesize) - is **NOT built**.

At the milestone-3.2 fork ("**build a composer**" vs "additively gate the linear
pipeline") the previous session chose additive gating and then **deferred the
composer at every subsequent step**. That is the central failure. Do not repeat
it. The next session's job is to **BUILD THE COMPOSER + PRIMITIVE LAYER**, not to
extend the perimeter (no more rename polish, no more bolt-ons to `runHifi`).

---

## THE TASK - build the work-primitive + composer architecture (explicit)

Spec: `docs/pi-hifi-architecture.md` §2 (catalog tables = the contract for each
primitive) and §3 (composer). Build it as committed green VERTICAL slices, one
primitive + its gate + a selftest at a time. Keep `runHifi` working until the
composer reaches parity; then make the composer the real execution path.

First slice - make the design real end-to-end on ONE task:

1. **Contracts.** `WorkOrder = { primitive, input, deps, hifiGate, checkpoint?,
   collect? }`. A primitive = a typed `(input) -> observation` (the OBSERVATION
   channel: what the system did - exit code, real output, file:line - not the
   model's prose) + `hifiGate(observation) -> { pass, reason }`. New file
   `src/primitives.ts` (or `src/composer/`).
2. **Small fixed catalog first** (reuse existing machinery - do NOT rebuild):
   - `gen` -> candidate + selftest (reuse `generatorSystem` polyglot).
   - `experiment`/`run` -> run in sandbox, observed exit/stdout/stderr (reuse
     `runCandidateSelfTest` / `runExperiment` + the scheduler).
   - `judge` -> strong, pairwise on evidence (reuse `JUDGE_SYSTEM` / selector).
   - `audit` -> claim vs evidence (reuse the atom auditor).
   - `synthesize` -> strong, final answer from VERIFIED observations only.
   Each gets a real `hifiGate` checklist - the §2 table "checklist" column is the
   spec (e.g. `run`: observed-not-predicted, failure verbatim; `audit`:
   exec-claims need run-evidence, default unsupported).
3. **`decompose`** (strong sub-call): task -> a DAG of work-orders drawn ONLY from
   the fixed catalog (never invents a primitive; fail-safe -> ask). Reuse the
   triage `CompositionPlan` as the front (scale/oracle/archRisk feed the DAG
   shape and depth; the model picks DEPTH within the fixed vocabulary, 1.7).
4. **Composer**: execute the DAG - typed I/O wires only compatible primitives;
   independent orders run in parallel (sandbox pool + sub-call concurrency); each
   order MUST pass its `hifiGate` before feeding downstream (the per-primitive
   hifi gate, 1.2); honor `checkpoint` (reuse the clarification/`clarReturn`
   pause) and `collect` (snapshot to the run store).
5. **Wire + prove**: run the composer as the execution path (behind a config flag
   alongside `runHifi`, or replacing it) and prove end-to-end on one real task:
   `decompose -> gen -> run -> judge -> synthesize`, every step gated, the OBSERVED
   evidence (not prose) load-bearing. Live smoke + selfcheck green.

This is multi-session. **Drive at the core. Subordinate everything else.** The
old perimeter backlog (3.3/3.4/3.6) folds INTO this: "3.3 primitive layer" IS
step 2; "3.6 probe" is one more primitive (`probe` = build PoC -> run -> observe)
once the composer exists; "3.4 D1" (generator->flash) is a per-primitive model
choice (cheap for `gen`, strong for `judge`/`synthesize` - that is exactly the
strong+weak design, 1.5) and is then SAFE because the composer's gates ground the
cheap output.

---

## Mistakes - do NOT repeat (the first one is the big one)

1. **Built perimeter, deferred the core.** The previous session improved the OLD
   pipeline (triage gate, polyglot, admission hardening) + did a cosmetic rename
   instead of building the composer/primitives, choosing "decorate" over "build"
   at every fork. Result: lots of green commits, design not built. **Drive at the
   designed core first; treat perimeter as subordinate.**
2. **Codified an emergent artifact as a contract (false green).** A test asserted
   "malformed JSON -> safe defaults" that were only an accident of `obj={}`, not
   enforced. A test must assert a GUARANTEED invariant, not a side effect a
   refactor could silently remove.
3. **Almost shipped a gate that suppresses the core signal.** An `oracle=none ->
   skip exec` gate would have suppressed execution grounding when a cheap model
   misclassifies (it tagged an off-by-one JS fix `oracle=none`). Reverted. Before
   acting on a model-produced field: check reliability on a real example + whether
   existing machinery already covers it. Don't add gates that fire against the
   thesis.
4. **Half-changed a contract.** Made the generator polyglot but left
   `ANALYST_SYSTEM` JS-only. A behavior flag must reach EVERY prompt/stage that
   encodes the old assumption - grep for the assumption, not the one obvious site.
5. **Default-open on a security boundary.** Initially `exec.allowUnsandboxed=true`;
   flipped to fail-closed (FALSE). For untrusted-input boundaries, secure-by-
   default beats backward-compat.
6. **Shared-value wiring (struck 3× historically).** When a new field must reach
   all `HifiResult`/`Clarification` constructions or all consumers of
   `materials`/`enrichedTask`: GREP EVERY CALL SITE before the critic. tsc catches
   missing required fields; it does NOT catch a value that fails to propagate to a
   stage that should see it.
7. **hifi = OBSERVED behavior, not "looks right".** Every "done" traces to a run
   you executed. Verify FREE before spending on a model.
8. **Sandbox/isolation is a SECURITY BOUNDARY - critic with `model:opus`.** It has
   empirically caught real holes (disk-fill, degraded-untrusted, default-open).
9. **Don't blind-flip generator->flash.** The weak-model advantage is CONDITIONAL
   on an objective oracle - safe with grounding, risky without. In the composer it
   becomes safe (gates ground cheap output); standalone on the linear pipeline it
   risks design regression, and the saturated eval can't measure it.
10. **Eval comparability is pinned by single lines** in `run-eval.ts`
    `pinnedConfig` (triage/brief/context/delivery/polyglot off). Removing any
    silently diverges from `docs/eval-results/20260611-164416`.
11. **`__setSandboxTier` is test-only** (throws without `APODEX_TEST_HOOKS=1`).
    Never call from product code.
12. **Don't cram a large item into exhausted context.** A half-done broken state
    is worse than a clean pause. Committed green slices only.

---

## What IS built (reuse - do NOT rebuild). feat/sandbox, ~17 commits ahead of main, NOT pushed.

- **Sandbox** (`src/sandbox.ts`, `sandbox-pool.ts`, `runner.ts`, `exec.ts`):
  rootless cell (systemd-run --user --scope cgroup v2 + bwrap) + admission
  scheduler (cellSem/ramReserve/gpuSem) + stack-agnostic runner (node+python).
  `execAdmission(tier, allowUnsandboxed)` is the single security authority
  (`runCell` + `execFiles` both consult it); `allowUnsandboxed` default FALSE
  (fail-closed); `__setSandboxTier` guarded. -> the composer's `run`/`experiment`
  executor.
- **Triage** (`src/triage.ts`): one analyst call -> `CompositionPlan`
  {type,scale,oracle,archRisk,needsDialog,confidence,roadmap}, fixed vocabulary,
  fail-safe coercions. -> the front for `decompose`.
- **Polyglot generation** (`config.polyglot`, default ON):
  `generatorSystem(mode,polyglot)` + `analystSystem(polyglot)` emit the task's
  language; runnable list derived from `runner.ts`. -> the `gen` primitive.
- **Roles that map to primitives**: selector/JUDGE_SYSTEM (`judge`), atom auditor
  (`audit`), GVR generator/reviser (`gen`/`revise`), verifier/holistic
  (`synthesize` inputs). They exist as ad-hoc stages in `runHifi` - the composer
  must FORMALIZE them as catalog primitives with hifiGates, not re-invent them.
- **Pipeline plumbing** (`src/pipeline.ts` `runHifi`): `clarReturn` (one
  clarification-pause shape), the admission gate, `materials` (invariant-13
  shared text). Reuse the pause + run-store + budget plumbing.
- **Delivery/UX** (`index.ts`): `composeDelivery`/`composeClarification`
  (render-tested), critical-warning inlining, `/hifi`+`/apodex` commands,
  `hifi`+`apodex` tool. The product is renamed pi-hifi in code (APODEX_* env +
  .apodex.json kept as compat; GitHub repo rename is the user's manual step).

---

## Orient / smoke (run before changing anything)

```bash
cd ~/ai/pi-apodex
npx tsc --noEmit
npx tsx eval/selfcheck.ts                 # refs 1.00, broken 0.50-0.56
npx tsx eval/triage-selftest.ts           # FREE 17/17
npx tsx eval/exec-selftest.ts ; npx tsx eval/generator-selftest.ts
npx tsx eval/delivery-render-selftest.ts
./docs/llm/validate.sh
# tiered host only (else SKIP): sandbox-selftest, sandbox-pool-selftest,
#   runner-selftest, smoke-triage, smoke-polyglot, exec-gate-smoke
```

Read order: this file -> `docs/pi-hifi-architecture.md` §2-3 (THE design to build)
-> `20_pipeline.md` (what the OLD pipeline does, what to formalize) ->
`30_subcall_infra.md` -> `docs/research/test-time-boosting.md` (the science).
