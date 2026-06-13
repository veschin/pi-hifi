---
id: handoff
kind: guide
---

# Handoff

## Operating mode (the user's standing directive for this project)

Work **autonomously and continuously** - do NOT stop for check-ins; take the
backlog all the way to the finish at **production-hifi quality**. Spending on real
pi runs (cheap-flash classification, live smokes, paid eval) to VERIFY is
sanctioned - do not ask before spending on verification. The bars are
non-negotiable: verify FREE first (selftests, no LLM) before paying; "done" means
OBSERVED behavior, never "looks right"; commit each verified slice to
`feat/sandbox` with what-was-verified in the body; critic before the completion
message, with `model:opus` for any sandbox/isolation/security change. Only stop to
ask the user when a decision is genuinely his and unresolvable from context (e.g.
D1's benchmark-vs-mode-aware choice, §3) - and even then, do the safely-completable
work first. Never cram a large item into exhausted context (a half-done broken
state is worse than a clean pause); break it into committed green slices. See the
`pi-hifi-autonomous-mode` memory note.

State as of 2026-06-13 (long autonomous session). Branch **feat/sandbox**, ~16
commits ahead of `main`, NOT pushed, do NOT touch `main`. Product is now
**pi-hifi** in code: the `/hifi` command (+ `/apodex` legacy alias), the `hifi`
tool, package.json, `.hifi/runs`, and the `runHifi`/`HifiConfig`/`HifiResult`
identifiers are renamed; `APODEX_*` env vars + `.apodex.json` are KEPT as compat;
`apodex` survives as the internal validate+select step name; the GitHub repo
rename is the user's manual step. Design target: `docs/pi-hifi-architecture.md`;
per-stage invariants: `20_pipeline.md`.

This session's verified milestones (each: tsc + FREE selftest + live smoke +
critic + committed):
```
d6a63d6 refactor(rename): runApodex/ApodexConfig/ApodexResult -> Hifi* [2/2]
0867eeb refactor(rename): pi-hifi product surface (command/tool/package/dir) [1/2]
68d631e harden(sandbox): single-door exec admission + guard __setSandboxTier
a4711c3 feat(prompts): stack-agnostic code generation (polyglot), default on
6a7d846 feat(triage): needsDialog backstop + clarReturn; defer oracle
4414f40 fix(ux): surface critical warnings inline in the delivery text
a93976a test: cover the extension's clarification + delivery rendering
4afb8dc feat(sandbox): admission gate for candidate exec; fail-closed default
e6d3761 feat(pipeline): wire triage into the pipeline; mega -> roadmap
94d1bc2 feat(triage): finish & verify the triage gate-driver
599dc31/7d91b3f/cab82cc  <- sandbox foundation (prior session)
```

## What exists (verified this session, observed)

- **Sandbox foundation** (`src/sandbox.ts`, `sandbox-pool.ts`, `runner.ts`,
  `exec.ts`): rootless cell (systemd-run --user --scope cgroup v2 + bwrap) +
  admission scheduler + stack-agnostic runner (node + python) + live exec path.
  Selftests skip without the tier; PASS on a tiered host.
- **Triage** (`src/triage.ts`): one analyst call -> `CompositionPlan
  {type,scale,oracle,archRisk,needsDialog,confidence,roadmap}` (fixed vocabulary,
  1.7). Fail-safe coercions. Acted-on gates in `runHifi`: `scale==="mega"` ->
  early-return a `"roadmap"` clarification (budget guard, no solve); `needsDialog`
  BACKSTOP (`shouldBackstopDialog`) -> pause when brief is OFF + interactive +
  uncertain. All clarification exits share one `clarReturn` helper. `oracle` is
  DEFERRED on purpose (see below). 20_pipeline invariant 19.
- **Stack-agnostic generation** (`config.polyglot`, default ON): both
  `generatorSystem(mode,polyglot)` and `analystSystem(polyglot)` emit/scope the
  language the task requires; runnable-language list derived from runner.ts
  (js + python) so it cannot drift; no-runner languages ship flagged "not
  executed". The eval pins polyglot OFF for comparability. LIVE-proven: a Python
  task generates a `python` block AND runs its selftest in the sandbox.
- **Sandbox admission gate**, fail-closed: `execAdmission(tier, allowUnsandboxed)`
  is the SINGLE authority (runCell + execFiles both consult it). `config.exec
  .allowUnsandboxed` default FALSE - a tier-less host refuses model code (ships
  flagged) unless the operator opts in (then warns loudly). `__setSandboxTier` is
  guarded (throws unless APODEX_TEST_HOOKS=1). opus-reviewed.
- **Delivery UX**: critical warnings (SECURITY/UNSANDBOXED/DISABLED) are inlined
  in the delivery text the host model reads (not just a count); the roadmap /
  questions / brief-review / normal renders are covered by a free selftest.
- **Full pro pipeline** end-to-end with all the above (smoke-pipeline): score
  100, 11/11 atoms verified, approve, $0.0166.
- Prior brief / scout-context / GVR / causal selection / claim audit / delivery
  - unchanged, still hold.

## What remains (the backlog - each is a SUBSTANTIAL effort, not a quick win)

Honest sizing after this session's analysis - none of these is a safe cram:

- **3.4 / D1 pin generator -> flash** (thesis-core but RISKY without a benchmark):
  generator defaults to SESSION_MODEL today. Flipping it to flash is the
  cheap-workers premise (1.5), BUT the weak-model advantage is CONDITIONAL on an
  objective oracle (1.12): safe for code (exec-grounded), risky for design/
  incident (no oracle to rescue weak output). The current eval saturates at pro,
  so it cannot measure this. Doing D1 safely needs either a harder benchmark to
  measure the oracle-conditional effect, or a mode-aware generator model
  (flash for code, strong for design). Do not flip blind.
- **3.3 primitive layer** (needs a source channel / a composer to be worth it):
  factcheck-over-materials already exists (the atom auditor); research-over-repo
  exists (the scout); but a general `research` primitive wants a web/source
  channel the project does not have (and 10_scope may forbid). Formalizing the
  existing roles as named primitives is cosmetic until a composer consumes them.
- **3.6 probe stage** (probe-first design grounding, 1.6): a generate->run->
  observe loop that builds a PoC in the sandbox before a design solve. Buildable
  (reuses generator + runCandidateSelfTest + the GVR pattern) BUT non-trivial:
  the PoC is model-generated code, so it needs the SAME admission gate the code
  path has (today the gate only fires for mode==="code"); plus materials
  injection, a convergence/budget policy, and it is speculative (PoC-grounding
  improving designs is an untested hypothesis). Additive + gated when built.

## Deferred (documented, lower priority)

- oracle routing (3.2b): acting on `oracle=none` to pre-skip exec would suppress
  execution grounding when triage misclassifies (a cheap model tagged an
  off-by-one JS fix oracle=none) and is redundant with the exec layer's
  ship-and-flag. Revisit when repo-suite/bench/web grounding exists.
- oomKilled heuristic; docker warm-pool (niche); cross-run statelessness;
  README predates analyst/triage/sandbox/polyglot.
- Rename cosmetic tail: `APODEX_*` env vars still named APODEX (compat; a
  HIFI_* alias layer is optional, not in the 1.1 scope) and the doc PROSE in
  some specs (40_extension, 30, 10) still says "apodex" for product-level
  mentions - a careful per-occurrence sweep (keeping `.apodex.json`/`APODEX_*`/
  the apodex-step/the Apodex-paper references) is the remaining cosmetic bit.

## Smoke test (run before touching anything)

```bash
cd ~/ai/pi-apodex
npx tsc --noEmit                          # no output
npx tsx eval/selfcheck.ts                 # refs 1.00, broken 0.50-0.56
npx tsx eval/triage-selftest.ts           # FREE 17/17
npx tsx eval/exec-selftest.ts             # FREE (admission + guard + exec path)
npx tsx eval/generator-selftest.ts        # FREE (polyglot + analyst convention)
npx tsx eval/delivery-render-selftest.ts  # FREE (clarification + normal render)
# tiered host only (else SKIP): sandbox-selftest, sandbox-pool-selftest,
#   runner-selftest, smoke-triage, smoke-polyglot, exec-gate-smoke
./docs/llm/validate.sh                      # OK: ... links valid
```

## Read order

1. This file.
2. [20_pipeline.md](20_pipeline.md) - invariant 19 (triage stage + gates).
3. [30_subcall_infra.md](30_subcall_infra.md) - exec runner / execAdmission gate +
   single-door hardening + config (triage, exec.allowUnsandboxed, polyglot).
4. [../pi-hifi-architecture.md](../pi-hifi-architecture.md) - the design target.
5. [devlog/04_devlog_triage_sandbox_gate.md](devlog/04_devlog_triage_sandbox_gate.md).
