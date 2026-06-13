---
id: devlog-04
kind: devlog
---

# Devlog 04 - triage wired + sandbox admission gate (2026-06-13)

## Why

The sandbox foundation (cell + scheduler + runner + exec routing) existed and
was verified, but two things were unfinished: `src/triage.ts` was written and
never tested (and nothing consumed its CompositionPlan), and the exec path's
bare-host fallback ran model-generated code UNSANDBOXED and SILENTLY on a
tier-less host. The session goal was to bring triage into the verified set,
make it actually gate the pipeline, and close the silent-unsandboxed gap -
each as a separately verified, committed milestone.

## What was built

### 1. triage verified (94d1bc2)

`eval/triage-selftest.ts`: FREE tests of `parseTriage` (well-formed,
mega+roadmap, malformed-JSON regex recovery, out-of-vocab enum, garbage), the
fail-safe coercions, `fallbackPlan`, and `runTriage` control flow (first-good,
retry-then-good, transport-fail-then-good, both-fail, both-garbage) via a stub
client; plus a flag-gated LIVE flash check. Critic (sonnet) found that the
malformed-JSON "safe defaults" were an emergent artifact of `obj={}`, not a
guaranteed invariant - fixed by making the `!parsedOk` branch FORCE
needsDialog/confidence to the safe side, and corrected a log-honesty bug
(runTriage said "unparseable" on a transport failure).

### 2. triage wired into the pipeline (e6d3761)

Stage T at the start of `runApodex`. Key decision: the ONLY gate acted on is
`scale === "mega"`, which early-returns a roadmap (new `Clarification` kind
`"roadmap"`) instead of solving - the budget guard. oracle/archRisk/needsDialog
for non-mega scales are RECORDED (`ApodexResult.composition`) but deferred, to
keep the change additive and avoid the brief-stage double-pause friction. The
mega early-return mirrors the brief clarification pause (invariant 17 -> 19).
Triage disabled in `run-eval.ts` for comparability with the published runs.
Observed: `smoke-triage` mega -> roadmap in 1 call ($0.0003), micro -> full
pipeline ($0.0027).

### 3. sandbox admission gate, fail-closed (4afb8dc)

`execAdmission(tier, allowUnsandboxed)` (pure, unit-tested) centralizes the
tier -> {sandbox, bare-host, disabled} decision. `runApodex` enforces it in
code mode (flips a local `execEnabled`), so selector/GVR/final-selftest all
skip exec on "disabled"; "bare-host" emits a loud SECURITY warning. exec.ts
keeps the bare-host fallback for the trusted eval scorer.

The load-bearing decision was the DEFAULT. The prior handoff called the
bare-host fallback "backward-compatible" (default would be allow=true). The
opus critic (this is a security boundary) argued, and proved empirically (a
candidate writing to $HOME succeeded on a forced-degraded tier, was blocked on
rootless), that for an untrusted-input boundary whose warning reaches a MODEL
(not a human) on the tool path, fail-closed is the correct default. Flipped to
`allowUnsandboxed=false`: a tier-less host ships flagged "not executed" unless
the operator opts in. This degrades into the project's existing ship-and-flag
mode and aligns with the fail-safe philosophy (1.9). On tiered hosts (dev,
eval) nothing changes - exec runs sandboxed regardless.

## Deferred (opus critic, documented in 30_subcall_infra)

- The security decision lives in two places (`execAdmission` + `runCell`'s
  `untrusted` refusal); `runExperiment` (unused) is one `untrusted:false` from
  an ungated path. Unify on a single door before wiring it in.
- `__setSandboxTier` is an exported process-global override (test-only intent);
  guard before any in-process multi-run embed.

## Verification discipline

Every milestone: tsc clean -> FREE selftest -> cheap LIVE observation -> selfcheck
unchanged (refs 1.00, broken 0.50-0.56) -> critic -> commit with what-was-verified.
The full pro `smoke-pipeline` ran clean end-to-end with all three changes
integrated (score 100, all atoms verified, $0.0238). Total live spend this
session well under $0.10.
