---
id: devlog-06
kind: devlog
---

# Devlog 06 - two-model usability fix (2026-06-14)

## Problem
Live runs showed the host model misusing hifi in two opposite ways:
- **glm-5.2** (thinking=high) delegated monoliths; the generator (maxTokens 16384)
  burned the whole budget on reasoning and returned EMPTY (stopReason length);
  retries repeated identically -> 3 empty attempts -> non-answer (~14 min).
  Evidence: `~/ai/game2/.hifi/runs/run-20260614-180128-nsa42t` (gen.0/1/2
  out=49152 across 3 attempts, respLen=0).
- **deepseek-v4-pro** delegated a multi-file scaffold slice; triage re-classified
  the approved brief as mega -> sub-roadmap -> the model recursed and bailed. The
  roadmap NEXT STEP told it to re-delegate the milestone.

## Diagnosis
Two distinct root causes:
1. **Capacity**: `maxTokens` is the TOTAL for thinking + answer; a high-thinking
   model can spend all of it reasoning and emit nothing, and the retries were
   identical (so they repeated the failure).
2. **Wrong-shape delegation + recursion**: hifi's envelope is ONE self-contained
   testable artifact (one `solution` block + one `selftest` block). A
   scaffold/glue/multi-feature task is outside it; triage should roadmap it ONCE
   and the message should redirect to atom-extraction, not invite re-delegation.

A first attempt (triage "multiple files => mega") was WRONG - it would have
worsened the recursion: a 7-file scaffold for ONE running result is bounded by
deliverable count, not file count. Corrected to "independent testable
deliverables".

## Fix (commit 2a027ba, PR #2 -> main)
- Self-heal: empty reply -> next attempt steps thinking down + raises tokens
  (capped 2x initial). Pure helpers, unit-tested (`eval/llm-selftest.ts`).
- generator maxTokens 16384 -> 32768.
- triage scale reworded around the envelope (deliverables, not files).
- mega-roadmap message: build glue yourself, delegate atoms, never re-delegate a
  whole milestone.
- Bundled skill `hifi-verified-slices` via `resources_discover`, replacing the
  removed `before_agent_start` directive.

## Verified
tsc + free suite green; opus critic x2 (both SHOULD-FIX applied: role-bounded
self-heal cap; self-heal on any empty reply, not only stopReason length). E2E on
the real pi: a Factorio MVP -> mega; the deepseek scaffold slice -> mega (was
bounded->recurse); mulberry32 + a determinism test -> bounded -> gen non-empty ->
sandbox exit 0 -> a real verified PRNG.

## Lesson
hifi's value is execution-grounded best-of-N on ONE testable artifact. Both
failures were tasks OUTSIDE that envelope. The fix is to make the in-envelope path
reliable (capacity) and to teach + enforce the envelope (skill + triage + the
redirect message), NOT to make hifi build bigger things. Triage by INDEPENDENT
testable deliverables, never by file count.
