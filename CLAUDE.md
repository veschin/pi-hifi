# pi-hifi

Verification-centric inference-time reasoning layer for the Pi coding agent:
an open replication of the Apodex-1.0 agent-team method (parallel candidates
-> execution-grounded selection -> generate-verify-revise -> claim-level audit ->
evidence-disciplined assembly), shipped as a Pi extension. TypeScript strict,
ESM, runs under pi's jiti loader (in-session) and tsx (standalone eval).

State: tsc clean; FREE selftests green. The work-primitive COMPOSER (the designed
engine) is built and proven LIVE on code (`docs/llm/25_composer.md`) and is now
the DEFAULT execution path (`config.composer.enabled` default true; linear
`runHifi` is the reversible fallback, pinned OFF in the eval). PRODUCTION-READY
gate: the composer must be verified across every advertised mode (code/design/
incident/general) and the real entry points - see the DONE block in
`docs/llm/handoff.md`. Reported eval `docs/eval-results/20260611-164416` (linear
arm: flash 0.96->1.00, pro 0.99->0.99); published at
https://github.com/veschin/pi-hifi.

## Session start

1. Read `docs/llm/handoff.md` first - current state, live problems, next
   options, smoke-test commands.
2. Run the smoke test from the handoff before changing anything.

## Known issues - NEVER repeat (non-negotiable; these cost the project sessions)

These are permanent. A violation is a session failure, not a style nit. Consequence
tiers (the project owner's terms, operationalized) are in `docs/llm/handoff.md`
"HARD RULES": deferring/scope-drift = STOP (session failed); degrading the design
toward less grounding or default-open security = hard revert on the spot;
cumulative deviations that defer the finish = total failure.

1. **Deliver the OUTCOME, not green pieces.** "Done" means observable product
   behavior the owner can use end-to-end - never "tests pass", "commit is green",
   or a finished sub-step. Do not write "done/ready/working/proven" about anything
   that is not the actual deliverable. Piece-level "done" while the product goal is
   unmet reads as lying; it is the project's #1 recurring failure.
2. **Drive at the core the owner asked for; never substitute breadth.** Do not
   spend a session on perimeter, renames, extra docs, eval/parity harnesses,
   measurement, refactors, or catalog breadth when the asked-for deliverable is
   unfinished. If you are not working directly on the owner's outcome, you are
   failing. The architecture's full primitive catalog is ASPIRATIONAL, not the bar.
3. **Do not hedge the owner's own design behind self-imposed caution.** If the
   design says X is the engine, ship X as the DEFAULT - not behind a flag
   "until I prove parity". The owner designing it IS the authorization; do not
   invent gates (parity proofs, discriminating evals) the owner did not ask for as
   preconditions to shipping the thing they asked for.
4. **Gates read the OBSERVATION channel only, never the model's claim**
   (`src/primitives.ts`). The load-bearing output must be un-fakeable (exit code,
   real output, parsed fact). A gate must NEVER fire against the thesis: `run`
   PASSES a failed-but-executed test (failure observed verbatim is valid
   grounding); it fails only when nothing ran. Never weaken observation-grounding.
5. **Security boundary is fail-CLOSED.** No sandbox tier + `!allowUnsandboxed` ->
   exec DISABLED (answer ships flagged "not executed"); never default-open. Any
   sandbox/isolation/admission change requires a `model:opus` critic.
6. **Tests assert GUARANTEED invariants, never emergent artifacts** (no false
   green - a test that passes by accident of construction is worse than no test).
7. **A behavior flag/field must reach EVERY consumer stage** - grep the assumption
   across all sites, not the one obvious one (e.g. `materials` must reach decompose
   AND gen; `execEnabled` must thread into `PrimitiveContext`). tsc does not catch
   non-propagation.
8. **Eval comparability is pinned by single lines** in `eval/run-eval.ts`
   `pinnedConfig` (triage/brief/context/delivery/polyglot/composer all OFF).
   Removing any silently diverges from the published baseline. Do not disturb.
9. **Verify FREE before paying** (tsc + selftests, no LLM); spending on live runs
   to OBSERVE behavior is sanctioned and expected - do not ask before paying to
   verify. "Done" = the run you observed.
10. **Do not cram a broken half-state into exhausted context - and do not use
    "don't cram" as an excuse to defer the finish.** Committed green slices, but
    the finish is the job.
11. `__setSandboxTier` is test-only (throws without `HIFI_TEST_HOOKS=1`); never
    call it from product code.

## Reference docs (load on demand)

- `docs/llm/10_scope.md` - what this project is NOT; read before adding any
  capability.
- `docs/llm/20_pipeline.md` - stage invariants; read before touching
  src/{pipeline,gvr,selector,verifier,prompts,context,delivery}.ts.
- `docs/llm/25_composer.md` - work-primitive layer + composer (the designed
  core); read before touching src/{primitives,composer,decompose}.ts.
- `docs/llm/30_subcall_infra.md` - sub-call/retry/budget/config/store
  contracts; read before touching src/{llm,roles,budget,config,store,exec,json}.ts.
- `docs/llm/40_extension.md` - pi integration + packaging facts (jiti
  aliasing, devDependencies decision); read before touching index.ts or
  package.json.
- `docs/llm/50_eval.md` - protocol and the selfcheck/analyzer disciplines;
  read before running or trusting any measurement.
- `docs/llm/90_lessons.md` - measured post-mortems; the rules there are
  enforced in code, do not regress them.
- `NOTES.md` - Pi SDK integration research; `DEVLOG.md` - decision log;
  `docs/research/test-time-boosting.md` - literature survey behind the
  roadmap.

## Update rule

Public-contract changes update the matching `docs/llm/` spec in the same
commit. `docs/llm/handoff.md` is rewritten at session end; devlogs and
lessons are append-only. After adding/renaming any doc:
`./docs/llm/validate.sh` must exit 0.
