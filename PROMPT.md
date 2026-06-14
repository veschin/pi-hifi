# Build: pi-hifi — a verification-centric reasoning extension for Pi

You are an autonomous senior engineer. Build the project end to end in `~/ai/pi-hifi`. Work to completion without asking for permission or confirmation — you have everything you need below. Make reasonable engineering decisions, document them, and proceed. The only acceptable reason to halt is a destructive, irreversible action OUTSIDE this project folder.

## Mission

Build a reusable **Pi extension** that adds a verification-centric deep-reasoning layer on top of *any* active model in a Pi session. It must measurably raise reasoning quality on engineering work — system/architecture design, code, and incident diagnosis — by structuring the work as an agent team with **external** verification, not single-pass generation.

The method is taken from the Apodex-1.0 verification-centric agent-team approach. Its core thesis: reliability comes not from a bigger model or longer context, but from a team that engages the problem and audits its own conclusions with an independent verifier before committing. You will replicate the *inference-time* portion (no training). Optional reference (reading is not required — the method is fully specified below): https://framerusercontent.com/images/us2FrK69YXqcWwu2AAUVAVCnK0.pdf

## Step 0 — research the harness before writing any code

Do NOT write integration code from memory. First investigate and write a short `NOTES.md` on:
- The Pi SDK package `@earendil-works/pi-coding-agent` (inspect `node_modules`, its types/dts, exported APIs). Find how extensions, tools, hooks, and skills are declared, and — critically — whether the SDK can spawn a nested model/agent call with a FRESH, isolated context from inside an extension. That nested-fresh-context call is the backbone of this whole system.
- `pi --help`, `pi config`, `pi --list-models`, and any existing extensions/skills on disk as worked examples of the extension format.
- If the SDK exposes no clean nested-agent primitive, fall back to calling the configured `deepseek` provider directly via its OpenAI-compatible endpoint from tool code. Prefer the SDK path if it exists.

Only after NOTES.md do you design and implement.

## Environment (verified — do not re-discover, do not modify)

- Target folder: `~/ai/pi-hifi` (create it). Stay inside it; you may READ `node_modules` and run `pi` to learn the SDK.
- Pi 0.79.1, package `@earendil-works/pi-coding-agent`. Pi is already configured for headless use.
- Model engine: DeepSeek, already wired into Pi (provider `deepseek`). Use `deepseek-v4-pro` for generation, verification, and grading; use `deepseek-v4-flash` for cheap high-volume sub-calls (atomic fact-checks, parallel candidates). Context is 1M, output up to 384K, thinking supported.
- API keys are already configured and injected headlessly. Do NOT search for, read, print, or touch any credentials.
- DeepSeek tokens are cheap — spend freely. Run as many sub-calls as the method needs.
- Brave Search is available if you wire web fact-checking (key is configured like the model key — never read it; call through whatever Pi/SDK mechanism is idiomatic). Web verification is optional, not required for v1.
- Git: run `git init` and make conventional commits at each verified milestone (e.g. `feat:`, `test:`, `chore:`). Commit only after you have observed the milestone working.

## What to build — the method, in priority order

Implement these as composable, programmatic loops (real control flow in code — NOT a single mega-prompt). Each sub-call MUST run in its own fresh, isolated context; a verifier must never see the author's reasoning trace it audits.

1. **GVR — generate → verify → revise (highest ROI, build first).**
   Loop, K rounds (default K=4, configurable up to ~10):
   - generate an attempt, conditioned on the task + the previous attempt + the previous written critique;
   - a grader in a FRESH context, given ONLY the task and the candidate (never a reference answer, never history), returns a numeric score AND a written critique;
   - the next attempt is steered by that written critique, not just the score.
   Return the highest-scoring attempt. The written critique is the load-bearing part — without it this degenerates into dumb best-of-K.

2. **External verifier agent.** An independent reviewer, fresh context, its own prompt and (optionally) its own search tool, that did not produce the work. It audits claims against evidence rather than continuing the reasoning. This is what makes the system better than same-context self-reflection (a well-known weak baseline).

3. **Causal-evidence candidate selector (for code).** Sample N candidates in parallel (default 4), then pairwise-compare them on three axes, picking the one most strongly supported by evidence and least likely to be "pseudo-correct":
   - Comprehension — did it identify the real problem, not pattern-match the surface?
   - Causality — does it fix the actual cause across the whole input distribution, not just the visible slice?
   - Empirical grounding — is success backed by observed execution (tests, repro, logs), not asserted?
   Judge on execution evidence, never on which patch "looks nicer".

4. **Evidence discipline.** Every claim in a final answer is an atom with a traceable source/justification; the final answer is assembled from the pool of verified atoms, not narrated freely by one agent.

5. **Small agent team.** 3–10 concurrent sub-calls is plenty for local use. Do NOT build async orchestration, a 150-agent swarm, or a custom runtime kernel — that is for datacenter scale and is out of scope.

## The verifier rubric IS the hifi standard

The grader/verifier's definition of "good" must encode high-fidelity engineering. Score a candidate down when it fails any of:
- error paths unhandled (only the happy path covered);
- edge cases ignored (empty/null input, empty collections, limits exceeded, concurrency/races where relevant);
- no validation at trust boundaries;
- a `try/except` that swallows an error and continues (that is a hidden bug, not a handled edge case);
- a TODO that hides undone work claimed as complete;
- correctness only asserted, never observed (no repro/test/execution);
- for design tasks: failure modes, scaling limits, and at least one rejected alternative not articulated.
A candidate is "verified" only when behavior was observed, not when it merely reads as correct.

## Provider-agnostic requirement

The extension must work with whatever model is active in the Pi session — read the active model/provider from the SDK; default to DeepSeek only when nothing is set. Roles (generator / verifier / grader / cheap-worker) should be configurable so any of the user's models can fill any role.

## Eval harness (mandatory — this is how we prove it works)

Build `eval/` with a small set of engineering tasks across three buckets, each with a programmatic/objective check:
- **design** — "design system X under constraints Y"; score against a locked rubric of required failure-mode handling;
- **code** — a non-trivial bug or task with a hidden test/repro that deterministically passes or fails;
- **incident** — given a symptom + logs, produce a diagnosis; check against the known root cause, penalizing confident wrong diagnoses.
Run every task two ways: single-pass baseline vs. the full pipeline, same engine. Report the delta (pass-rate / rubric-score). Target a large relative uplift on tasks where single-pass frequently fails; be honest where it doesn't move. Print a summary table.

## Engineering requirements (hifi applies to your own code too)

- Concrete, specific types; validate inputs at boundaries.
- Robust sub-call handling: timeouts, bounded retries, and hard budgets on token spend, recursion depth, and round count so loops can never run away.
- Deterministic, inspectable runs: persist each run's reasoning/verdict/evidence pool to disk (a research-history artifact), so any conclusion is auditable.
- No hidden TODOs passed off as done. If you defer something, list it explicitly in the README.
- If the same step fails twice, stop and diagnose the root cause — do not stack workarounds.

## Definition of done

- The extension loads in a Pi session and is invokable on any model.
- The eval harness runs and shows a measured uplift vs. single-pass baseline, with a printed summary.
- `README.md` (architecture, how to invoke, how to run eval, configuration, deferred work) and `NOTES.md` (SDK findings) exist.
- Clean git history of conventional commits at verified milestones.
"Done" means observed working behavior — you ran it and saw the numbers — not "code written".

## Working agreement

- Full autonomy: decide and proceed; do not pause for approval. Keep a short running `DEVLOG.md` of decisions and why.
- All code, comments, docs, commit messages: English. Any status report addressed to the human: Russian (the user is Russian-speaking); keep identifiers, commands, and paths verbatim.
- Stay within `~/ai/pi-hifi`. Do not touch other projects, remote hosts, or credentials.

Begin with Step 0, then build. Work until the Definition of done is met.
