---
id: handoff
kind: guide
---

# Handoff

State as of 2026-06-13. Branch **feat/sandbox**, 7 commits ahead of `main`
(the 6 below + this handoff commit), NOT pushed, do NOT touch `main`. Product is mid-rename to `pi-hifi` (repo still
named pi-apodex; `apodex` is being demoted to one internal step). The design
target is `docs/pi-hifi-architecture.md`; the per-stage invariants are
`20_pipeline.md`.

This session (3 verified milestones, all committed to feat/sandbox):
```
4afb8dc feat(sandbox): admission gate for candidate exec; fail-closed default
e6d3761 feat(pipeline): wire triage into the pipeline; mega tasks return a roadmap
94d1bc2 feat(triage): finish & verify the triage gate-driver
599dc31 feat(exec): route live execution through the sandbox, stack-agnostic   <- sandbox foundation
7d91b3f feat(runner): stack-agnostic experiment runner over the sandbox        <-   (prior session)
cab82cc feat(sandbox): cell + admission scheduler                              <-
```

## What exists (verified this session, observed)

- **Sandbox foundation** (`src/sandbox.ts`, `src/sandbox-pool.ts`,
  `src/runner.ts`, `src/exec.ts`): a kernel-enforced rootless cell
  (`systemd-run --user --scope` cgroup v2 + `bwrap`) with an admission
  scheduler (cellSem / ramReserve / gpuSem), a stack-agnostic experiment
  runner (node + python), and the live exec path routed through it. Selftests:
  `sandbox-selftest`, `sandbox-pool-selftest`, `runner-selftest`,
  `exec-selftest` (all SKIP gracefully without the rootless tier; PASS on a
  tiered host - exercised this session via exec-selftest + the smokes).
- **Triage gate-driver** (`src/triage.ts`, milestone 94d1bc2): one analyst
  classification call -> `CompositionPlan {type, scale, oracle, archRisk,
  needsDialog, confidence, roadmap}` from a FIXED vocabulary (1.7). Fail-safe:
  malformed / low-confidence / roadmap-less-mega -> coerced to needsDialog;
  budget/abort propagate; any other failure -> fail-safe plan. FREE
  `triage-selftest` 16/16 + LIVE flash (mega->mega, micro->micro).
- **Triage wired into the pipeline** (milestone e6d3761): Stage T at the very
  start of `runApodex`, gated by `config.triage.enabled` (default ON; OFF in
  `run-eval.ts` for comparability). The ONLY acted-on gate today is
  `scale === "mega"`: it early-returns `ApodexResult.clarification` kind
  `"roadmap"` with `finalAnswer:""` (the budget guard - the solve pipeline
  never fires on a whole system), mirroring the brief clarification pause.
  `ApodexResult.composition` records the plan on every post-triage exit path.
  20_pipeline invariant 19. FREE + LIVE `smoke-triage` (mega->roadmap, 1 call;
  micro->full pipeline).
- **Sandbox admission gate** (milestone 4afb8dc): `execAdmission(tier,
  allowUnsandboxed)` (src/sandbox.ts, pure/unit-tested). `config.exec
  .allowUnsandboxed` default **FALSE / fail-closed** (opus critic): a tier-less
  host REFUSES to run model code (ships flagged "not executed") unless the
  operator opts in, in which case the pipeline warns loudly each run. Enforced
  in `runApodex` (code mode) via a local `execEnabled`. Closes the prior
  silent-unsandboxed gap. FREE `exec-selftest` (8/8) + LIVE `exec-gate-smoke`
  (both arms) + opus critic proved escape containment.
- **Full pro pipeline works end-to-end with all the above** (smoke-pipeline,
  this session): chunk task -> mode code, score 100, all 10 atoms verified,
  holistic approve, $0.0238 / 19 calls. Triage ran (non-mega -> proceeded),
  exec sandboxed.
- Prior brief stage (`src/brief.ts`), scout context (`src/context.ts`), GVR,
  causal selection, claim audit, delivery - unchanged, still hold.

## What does NOT exist yet (remaining backlog, roughly dependency-ordered)

- **3.2b oracle routing**: triage's `oracle` (execute/repo-suite/bench/web/none)
  and `archRisk`/`needsDialog` are RECORDED but only `scale==="mega"` is acted
  on. Wire oracle -> grounding choice; `none` = ship flagged (the Three.js
  incident). archRisk -> probe (needs 3.6). Caveat: oracle gating overlaps the
  existing exec/mode handling - design the hook carefully.
- **3.3 primitive layer**: research / factcheck as typed modules over
  SubCallClient, each with a `hifiGate` checklist (spec: architecture §2).
  experiment ~= done (runExperiment); generate/judge/synthesize exist as roles
  to formalize.
- **3.4 D1 - pin generator -> flash + measure**: `src/config.ts` generator
  defaults to SESSION_MODEL (strong), contradicting the "cheap workers"
  premise. Pin to flash, then re-point the eval metric to "hifi + strong
  session vs strong single-pass on HARD tasks" (needs the harder benchmark;
  the current eval saturates).
- **3.5 generator prompt generalization** (`src/prompts.ts`): still forces
  `js solution`/`js selftest`, so the pipeline GENERATES node even though the
  runner RUNS any language. Generalize to language-tagged blocks; gate behind a
  flag (the eval pins js for comparability).
- **3.6 probe stage**: probe-first design grounding (GVR-class generate->run->
  read-failure->fix loop building a PoC in the sandbox before committing a
  design). Needs a convergence/budget policy.
- **Rename pi-apodex -> pi-hifi** (1.1): package.json, `/apodex`->`/hifi`
  (+alias), `.apodex/runs`, docs, identifiers. One scoped commit; grep every
  call site (the wiring lesson, 90_lessons).

## Deferred hardening (opus critic, 2026-06-13 - documented in 30_subcall_infra)

- **Single-door exec admission**: the security decision lives in TWO places -
  `execAdmission` (exec.ts bare-host gate) and `runCell`'s degraded+`untrusted`
  refusal (sandbox.ts). `runExperiment` (runner.ts) calls the scheduler
  directly, gated only by the latter (fails closed today via `untrusted` default
  true, but is one `untrusted:false` from an ungated path). Unify before wiring
  runExperiment into the pipeline.
- **`__setSandboxTier`** is exported from src/sandbox.ts (a process-global tier
  override, test-only intent). Guard / isolate before any in-process multi-run
  embed; the smokes reset it in `finally`.

## Honest gaps (carried, still true)

- `oomKilled` in CellEvidence is a documented heuristic (a payload can fake
  exit 137); not load-bearing - the selector gates on exit==0. A robust fix
  reads the cgroup `memory.events`, deprioritized for the threat model.
- Docker warm-pool backend NOT built (now niche per the rootless-primary
  decision; architecture §4 flipped this session).
- Cross-run statelessness (the "имплементируй диздок" incident): runs are
  stateless and the calling model may not inline prior outputs. Mitigations
  pending in the tool/param descriptions.
- README predates analyst/brief/triage/sandbox.

## Smoke test (run before touching anything)

```bash
cd ~/ai/pi-apodex
npx tsc --noEmit                          # no output
npx tsx eval/selfcheck.ts                 # refs 1.00, broken 0.50-0.56; "SELFCHECK PASSED"
npx tsx eval/triage-selftest.ts           # FREE 16/16; "TRIAGE-SELFTEST PASSED (free)"
npx tsx eval/exec-selftest.ts             # FREE 8/8 (admission + exec path)
# tiered host only (else they SKIP):
npx tsx eval/sandbox-selftest.ts          # 5/5
npx tsx eval/sandbox-pool-selftest.ts     # 5/5
npx tsx eval/runner-selftest.ts           # node+python pass/fail
./docs/llm/validate.sh                     # OK: ... links valid
```

Paid (optional, ~cents): `APODEX_TRIAGE_LIVE=1 npx tsx eval/triage-selftest.ts`
(mega/micro live); `npx tsx eval/smoke-triage.ts` (mega gate end-to-end);
`npx tsx eval/exec-gate-smoke.ts` (gate both ways, forces degraded tier);
`npx tsx eval/smoke-pipeline.ts` (full pro pipeline).

## Read order

1. This file.
2. [20_pipeline.md](20_pipeline.md) - invariant 19 (triage stage) is new.
3. [30_subcall_infra.md](30_subcall_infra.md) - the exec runner / `execAdmission`
   gate + config (triage, exec.allowUnsandboxed) + the deferred hardening note.
4. [../pi-hifi-architecture.md](../pi-hifi-architecture.md) §4 (rootless-primary)
   for the sandbox design; [50_eval.md](50_eval.md) before any measurement.
5. [devlog/04_devlog_triage_sandbox_gate.md](devlog/04_devlog_triage_sandbox_gate.md)
   for this session's reasoning.

## Agent errors to log

1. (carried, still open) The final critic round over the publication batch
   (README/LICENSE/packaging) was interrupted on 2026-06-11 and never re-run.
2. (carried) The shared-value wiring lesson (grep every call site BEFORE the
   critic) - applied cleanly this session (triage `composition` reached all
   ApodexResult literals; tsc enforced completeness).
