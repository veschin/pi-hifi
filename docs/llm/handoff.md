---
id: handoff
kind: guide
---

# Handoff - pi-hifi: make the composer the working default (PRODUCTION-READY)

## THE ONLY DEFINITION OF DONE - STATUS: MET (2026-06-14)

**DONE = a fresh, real run of the extension uses the COMPOSER as its engine and
returns a usable, grounded answer for EVERY task mode the tool advertises (code,
design, incident, general), observed with your own eyes - not the old linear
pipeline, not behind a flag, not "tests pass".**

This is MET and OBSERVED. All runs go through `runComposerHifi` (the real entry
point; `config.composer.enabled` default true; run.json `"path":"composer"`):

- **CODE** (pro models, real rootless sandbox): decompose N=1 -> gen -> run
  **exit 0 OBSERVED** -> synthesize, hifi=true; plus a forced N=2 gen×2 -> run×2
  -> judge (evidence-grounded, `sawEvidence=true`) -> synthesize.
- **DESIGN** (flash): gen×2 -> judge -> audit(14 atoms) -> synthesize; answer
  carried architecture + data layout + a failure-mode table + 6 rejected
  alternatives + a verified/unverified split (audit grounding the assembly).
- **INCIDENT** (flash): correct root cause (release-leak on the early-return
  path) + a 5-link evidence chain + a competing-hypotheses table that dismissed
  the planted red herrings + a safe pre-fix verification step.
- **GENERAL** (flash): 5 ranked causes each with confirm/refute evidence + a
  phased plan, every causal claim flagged unverified (audit discipline on an
  oracle-less task).
- Mode-sweep guaranteed-invariant assertions: **26/26** in
  `eval/smoke-composer.ts` (no throw, non-empty, path=composer, mode preserved,
  graph ends in synthesize). Content quality OBSERVED by eye, never asserted.
- **CONTEXT grounding**: live run, context ON, scout gathered the real
  `src/sandbox.ts` (14.2 KB, 2 rounds); answer quoted the file-only token
  `bare-host` + the exact `execAdmission` returns - grounded, not guessed.
- **CLEAN delivery**: `ComposerSummary {hifi, orderCount, flaggedCount, depth}`;
  `summaryLines` / `renderHandoff` / tool `details` now report composer grounding
  instead of the dead linear `n/a` fields. Observed live - a real composer
  delivery + handoff.md carry NO "best grader score: n/a", "claim atoms: 0/0/0",
  "external verifier: n/a". FREE-locked in `delivery-render-selftest`. opus critic
  cleared it: no false-green grounding (hifi cannot render while flagged),
  fail-closed admission untouched, observation gates untouched.

- **CLARIFICATION (T4)** - VERIFIED LIVE through the composer, 9/9 shape
  assertions: a mega task -> triage scale=mega -> 13-milestone roadmap
  clarification, finalAnswer "", run.json status "needs-clarification"; an
  ambiguous interactive task -> brief paused with 5 questions, finalAnswer "";
  re-invoke with a `# Approved brief` section -> analyst skipped, decompose ->
  composer -> a full 11k-char answer (run.json path=composer / completed /
  brief=approved). Stateless re-invoke honored end to end.

Every advertised AC (code/design/incident/general modes, context grounding,
clean delivery, clarification) is now OBSERVED live through the composer.

> If the human says this DONE definition is wrong, rewrite ONLY this block from
> his one-line correction; everything below still applies.

---

## STOP-LIST - forbidden until DONE passes (these ratholes burned 4 sessions)

You may NOT do any of the following before the DONE acceptance run is green:
- Add primitives beyond the existing 6 (gen/run/judge/audit/synthesize/decompose).
  The 23-primitive catalog in the architecture doc is ASPIRATIONAL, NOT required.
- Write or extend eval harnesses / parity measurements / scoring.
- Write new docs or refactor existing ones (you MAY update THIS handoff to DONE).
- Rename anything. Refactor the duplicated front (prepareRun/finishRun). Add
  cheap-gen / per-primitive model knobs. Wire checkpoint resume.
- Measure parity, run the full eval, or gate the finish on "prove it's better".

If a task seems to need any of these to reach DONE, you are wrong about the task.
Re-read the DONE block. The composer already works; you are verifying and fixing,
not building.

---

## FIRST ACTION (do this before reading more, planning, or building)

Run the composer on a real task and WATCH it, end to end:

```bash
cd ~/ai/pi-hifi
npx tsx eval/smoke-composer.ts        # code mode, already-proven baseline
```

Then immediately do the same for design + incident + general (Task T2). Outcome
first. Do not spend the session reading and planning; the code is known to you
below.

---

## REAL PROGRESS (honest - what is true, what is NOT)

Branch `feat/sandbox`, ahead of main, NOT pushed. tsc clean; full FREE suite green.

BUILT and PROVEN:
- The composer engine: `src/primitives.ts` (the two-channel contract: gates read
  the OBSERVATION channel only, never the model's claim), `src/composer.ts`
  (validateGraph + topological parallel runComposer), `src/decompose.ts`
  (task -> validated catalog DAG), `src/composer-pipeline.ts` (`runComposerHifi`).
- 6 primitives with real hifi gates: gen, run, judge, audit, synthesize, decompose.
- Proven LIVE end-to-end on CODE: decompose -> gen -> run -> judge -> synthesize,
  with a REAL sandbox exit code load-bearing (eval/smoke-composer.ts, 11/11).
- `config.composer.enabled` now defaults TRUE; index.ts dispatches
  `composer.enabled ? runComposerHifi : runHifi`. runHifi is the reversible
  fallback (NOT deleted; eval pins composer OFF for comparability).
- FREE selftests: primitives 35, composer 26, decompose 16 - all green.

NOW VERIFIED this session (evidence in the DONE block above):
- The composer on DESIGN / INCIDENT / GENERAL modes - live, observed on-shape.
- Workspace-context tasks through the composer - live (scout gathered a real
  file; the answer quoted its content - grounded, not guessed).
- Delivery rendering for composer results - clean: `ComposerSummary` replaces the
  null linear fields; no "n/a / null" noise. FREE-locked + observed live. opus
  critic cleared (no false-green, fail-closed admission + observation gates intact).

ALSO VERIFIED LIVE this session (T4 clarification through the composer):
- mega -> 13-milestone roadmap (finalAnswer "", run.json needs-clarification);
  ambiguous interactive -> brief paused with 5 questions; re-invoke with a
  `# Approved brief` section -> analyst skipped -> full 11k answer (run.json
  path=composer / completed / brief=approved). 9/9 shape assertions.

NOT built - ASPIRATIONAL, OUT OF SCOPE FOR DONE (do not touch this session):
- Research tier (read/grep/list/web), the rest of experiment/factcheck, revise,
  select, probe; cheap-gen; checkpoint resume; front unification.

---

## TASKS (each with BINARY, OBSERVABLE acceptance criteria)

### T1 - Composer is the default and routes from the real entry points
Largely done in code; VERIFY, don't rebuild.
- AC1: `loadConfig` returns `composer.enabled === true` by default (no env/file).
- AC2: `index.ts` `execute()` dispatches to `runComposerHifi` when enabled; the
  `hifi` tool and `/hifi` + `/apodex` commands all flow through `execute()`.
- AC3: a live run via the standalone composer path returns a HifiResult whose
  run.json shows `"path":"composer"`.

### T2 - The composer works on EVERY advertised mode (the core of DONE)
- AC1: a live composer run on a CODE task returns a non-empty answer that
  preserves a runnable solution block AND has observed run evidence (exit code).
- AC2: a live composer run on a DESIGN task returns a complete design answer
  (architecture + failure modes + a rejected alternative); no crash; gates pass
  or are honestly flagged.
- AC3: a live composer run on an INCIDENT task returns a diagnosis (root cause +
  evidence chain); no crash.
- AC4: a live composer run on a GENERAL task returns a coherent answer; no crash.
- AC5: ANY breakage found in AC1-AC4 is FIXED in src/ (not worked around, not
  deferred), and the run re-passes.
- Verify by extending eval/smoke-composer.ts to drive one real task per mode
  through runComposerHifi (reuse eval/tasks/*), asserting non-empty + on-shape +
  no throw. (This edits an existing smoke; it is NOT a new harness.)

### T3 - Workspace context is gathered and grounds the answer
- AC1: a live composer run on a task that names a real repo file (context ON)
  gathers that file via the scout front and the final answer reflects its real
  content (grounded, not guessed).
- AC2: no crash when context is enabled; materials reach decompose AND gen.

### T4 - Clarification + stateless re-invoke through the composer
- AC1: a mega-scale task returns `clarification.kind === "roadmap"`, finalAnswer
  "", run.json status "needs-clarification" - same shape as runHifi.
- AC2: an ambiguous task in interactive mode returns brief questions; re-invoking
  with a `# Clarification answers` / `# Approved brief` section proceeds to a
  full answer.
- AC3: composeClarification renders each pause correctly (it already handles the
  shapes; verify the composer produces them).

### T5 - Delivery output is clean for composer results
- AC1: composeDelivery / summaryLines produce no misleading "n/a" or "null" lines
  caused by the null gvr/selection/verification on the composer path; the summary
  reflects the composer (e.g. show decompose depth / composer hifi, or omit the
  linear-only lines) rather than printing dead fields.
- AC2: handoff.md and final.md render correctly on the composer path.
- AC3: the NEXT STEP directive is correct for the task shape.
- This MAY require small edits to index.ts summaryLines (allowed: it is part of
  the DONE surface, not forbidden breadth).

### T6 - No regression
- AC1: `npx tsc --noEmit` clean.
- AC2: full FREE suite green: selfcheck (refs 1.00), primitives, composer,
  decompose, triage, exec, generator, delivery-render. `./docs/llm/validate.sh` 0.
- AC3: the eval still pins composer OFF (comparability with the published linear
  runs intact); do NOT run the full eval.

### T7 - Close it
- AC1: critic with `model:opus` on the production integration (it touches the
  exec/admission security boundary on every code run) - confirm fail-closed
  admission, observation-grounded gates, clean delivery; fix findings.
- AC2: commit to feat/sandbox with what-was-OBSERVED in the body (the live runs).
- AC3: rewrite the DONE block of this handoff to state DONE is met, with the
  evidence (the four mode runs + their observed outputs).

---

## IMPLEMENTATION PLAN (ordered, outcome-first)

1. FIRST ACTION (above): run smoke-composer.ts; confirm code mode still works as
   default. (T1 AC3, T2 AC1.)
2. T2: extend smoke-composer.ts to drive design + incident + general live; run;
   FIX every breakage in src/ until all four modes return on-shape answers.
   This is where the unknowns are - budget most of the session here.
3. T3: run one workspace-context task through the composer; fix grounding/wiring.
4. T4: run a mega + an ambiguous task; confirm the clarification shapes; fix.
5. T5: read index.ts summaryLines/composeDelivery; remove dead-field noise for
   composer results; verify handoff.md/final.md.
6. T6 regression sweep, then T7 critic + commit + mark this handoff DONE.

Spending on live runs to VERIFY is sanctioned - do not ask before paying for
verification. Verify FREE (tsc + selftests) before each paid run. "Done" = the
run you observed, never "looks right".

---

## MISTAKES - DO NOT REPEAT (every known one; also pinned in CLAUDE.md)

1. Built perimeter / breadth / docs / harnesses instead of the deliverable. The
   deliverable is the DONE block. Everything else is the STOP-LIST.
2. Reported piece-level "done/proven" while the product goal was unmet. That
   reads as lying. Only the DONE block is "done".
3. Hedged the user's own design behind self-imposed caution (kept the composer
   OFF behind a flag "until parity"). The composer is the design; ship it ON.
4. False-green tests: assert GUARANTEED invariants, never emergent artifacts.
5. A gate must never fire against the thesis: `run` PASSES a failed-but-executed
   test (failure observed verbatim is grounding); it fails only when nothing ran.
6. A behavior flag/field must reach EVERY stage - grep the assumption, not one
   site (materials must reach decompose AND gen; execEnabled must thread into
   PrimitiveContext).
7. Security boundary is fail-CLOSED: no sandbox tier + !allowUnsandboxed ->
   exec DISABLED, answer ships flagged "not executed". Never default-open.
8. Eval comparability is pinned by single lines (triage/brief/context/delivery/
   polyglot/composer all OFF in run-eval.ts pinnedConfig). Do not disturb.
9. `__setSandboxTier` is test-only (throws without HIFI_TEST_HOOKS=1).
10. Do not cram a broken half-state into an exhausted context. But also do not
    use "don't cram" as an excuse to defer the finish (see consequences).

---

## HARD RULES - consequences (the human's terms; zero tolerance)

| Offense | Verdict | Operational meaning |
|---|---|---|
| Deferring a task ("next session"), or drifting to STOP-LIST work | **amputation** | STOP. The deferral/drift IS the session's failure. Do the task now or it did not happen. No "I'll do X later" - there is no later. |
| Degrading the design in the worse direction (default-open gate, a gate that reads the claim channel, an ungrounded "pass", dumbing a primitive, deleting observation-grounding) | **quartering** | Hard revert on the spot. Never weaken observation-grounding or fail-closed security. The design only moves toward MORE grounding, never less. |
| Cumulative deviations that push the finish past this session | **death / network disconnection** | The session has betrayed its only purpose. Production-ready was achievable; failing to deliver it is total failure. |

There is little work here. The engine exists and is proven. Verify it across the
modes, fix what breaks, clean the output, ship it as the default. That is the
whole job.

---

## ORIENT / VERIFY COMMANDS

```bash
cd ~/ai/pi-hifi
npx tsc --noEmit
npx tsx eval/smoke-composer.ts            # composer end-to-end, code (PAID, ~$0.02)
# T2: extend this smoke to design+incident+general, then run.
npx tsx eval/primitives-selftest.ts        # FREE 35
npx tsx eval/composer-selftest.ts          # FREE 26
npx tsx eval/decompose-selftest.ts         # FREE 16
npx tsx eval/selfcheck.ts ; npx tsx eval/triage-selftest.ts
npx tsx eval/exec-selftest.ts ; npx tsx eval/generator-selftest.ts
npx tsx eval/delivery-render-selftest.ts
./docs/llm/validate.sh
```

Code map: `src/composer-pipeline.ts` (runComposerHifi - the path, READ FIRST),
`src/composer.ts` (engine), `src/primitives.ts` (the 6 gates),
`src/decompose.ts`, `index.ts` (dispatch + delivery rendering - T5).
