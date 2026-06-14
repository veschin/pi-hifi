# pi-hifi

A verification extension for the [Pi coding agent](https://github.com/badlogic/pi-mono).

You hand it one hard, well-scoped task. It runs a multi-step, execution-grounded
process instead of a single model pass, and returns a **verified answer plus
apply steps** - not edits to your files. The host agent then applies the steps.

- **Engine:** a *composer* - the task is broken into a small graph of work
  steps (generate, run, judge, audit, synthesize). Each step is checked against
  an **observation** (a real exit code, real output, a parsed fact), never the
  model's own claim. The result is "fully grounded" or honestly flagged.
- **Provider-agnostic:** heavy roles default to your Pi session model; the cheap
  worker role defaults to `deepseek/deepseek-v4-flash`. Every role is overridable.
- **Default on:** the composer is the default path. A linear fallback exists
  (`HIFI_COMPOSER=0`).

---

## Contents

- [When to use it](#when-to-use-it)
- [Install](#install)
- [Use](#use)
- [How it works](#how-it-works)
- [Modes](#modes)
- [Output](#output)
- [Configuration](#configuration)
- [Security](#security)
- [Measured results](#measured-results)
- [Repository layout](#repository-layout)
- [Credits](#credits)

---

## When to use it

`pi-hifi` produces **one verified artifact per run** (a solution block, a design,
a diagnosis). Use it when a single model pass is unreliable and verification is
worth the extra cost.

**Good fit**

- A tricky, self-contained function or algorithm where correctness is uncertain.
- A system design that must list failure modes and rejected alternatives.
- An incident diagnosis (root cause + evidence chain).
- A focused analysis or comparison.

**Not a fit**

- Building a whole application or multi-file project in one call. The composer
  emits a single artifact, not a codebase.
- Open-ended or very large tasks. These are classified **mega** and returned as
  a milestone roadmap to slice - they are not solved in one run (see
  [Modes](#modes) and the note below).

**For large builds:** let the host agent build the project (it has read/write/
bash tools) and delegate only the hard, verifiable pieces to `pi-hifi`. Example:
the agent scaffolds a game, then asks `pi-hifi` to "implement deterministic
greedy meshing for 16³ voxel chunks; here is the spec" and drops the verified
result in.

> A "mega" task keeps returning a roadmap rather than a solution **by design**.
> Slice it, or hand the build to the agent and delegate the bounded sub-problems.

---

## Install

Requirements:

- Pi `>= 0.79` with at least one configured model provider.
- For in-session use, **no `npm install`** is needed - Pi resolves the SDK
  imports via its own runtime.
- For the standalone evaluation harness, a dev install (`npm install`) and
  Node.js (developed on v24).

| Method | Command | Scope |
|---|---|---|
| From GitHub | `pi install git:github.com/veschin/pi-hifi` | global, persists |
| From a local path | `pi install ./pi-hifi -l` | project-local (`.pi/settings.json`) |
| One session only | `pi -e ./pi-hifi/index.ts` | not saved |
| Manual symlink | `ln -s "$PWD/pi-hifi" ~/.pi/agent/extensions/pi-hifi` | global, persists |

Pi auto-loads extensions from `~/.pi/agent/extensions/`. Verify a load with
`/hifi-config` inside a session, or `pi list` for settings-registered packages.

---

## Use

Two entry points, same pipeline:

```text
/hifi <task text>          run the pipeline directly from the prompt
hifi  (tool)               the session model delegates a hard task on its own
/hifi-config               print the effective configuration
```

`/apodex` and `/apodex-config` are kept as legacy aliases.

A run takes minutes. Progress shows in the widget above the editor and in the
status bar; the result arrives as a chat message.

### Clarification pauses

A run can pause before doing any solution work and ask for input. You answer,
then re-invoke with the answer appended under a documented heading.

| Trigger | What you get back | How to continue |
|---|---|---|
| Mega task | A milestone **roadmap** | Re-invoke `/hifi` on **one** slice as a self-contained task |
| Ambiguous task | Numbered **brief questions** | Re-invoke with the original task + a `# Clarification answers` section |
| Draft brief for review | A proposed **brief** | Re-invoke with the original task + an `# Approved brief` section |

State lives entirely in the chat text - the paused run is closed; the re-invoke
is a fresh run that reads your appended section.

---

## How it works

One task flows through shared front stages, then the composer:

```text
triage      classify the task (type, scale, needs-input?)  -> mega: stop, return roadmap
brief       analyst restates the task (interactive: may pause with questions)
context     scout reads relevant repo files, read-only (no need to paste them)
classify    pick the mode: code | design | incident | general
admission   code mode: check for a sandbox tier (fail-closed; see Security)
decompose   task -> a validated work-graph; the model picks DEPTH only
composer    run the graph: gen -> run -> judge -> [audit] -> synthesize
delivery    write final.md + handoff.md, return a summary + apply steps
```

### Work-primitives

The composer draws only from a fixed catalog. The model never invents a step; it
only chooses how many candidates to compare and whether to add an audit.

| Step | Tier | Produces | Gate (what is checked) |
|---|---|---|---|
| `gen` | worker | a candidate | code candidate ships a runnable self-test; non-code is non-empty |
| `run` | worker | execution result | the self-test **actually ran**. A failing test passes the gate (the failure is real evidence); only "nothing ran" fails |
| `judge` | strong | a winner | a winner exists and is grounded in the run evidence; an all-tie is flagged, never a silent pick |
| `audit` | worker | claim verdicts | each load-bearing claim is checked; an execution claim needs run evidence |
| `synthesize` | strong | the final answer | non-empty; the winner's solution block is preserved verbatim |
| `decompose` | strong | the work-graph | drawn only from the catalog; on doubt it orders *more* work, never less |

### Graph shapes

The default graph is deterministic and validated before it runs:

```text
code, N >= 2:  gen ×N  ->  run ×N  ->  judge  ->  [audit]  ->  synthesize
code, N == 1:  gen     ->  run     ->            [audit]  ->  synthesize
non-code:      gen ×N  ->  [judge] ->            [audit]  ->  synthesize
```

If a gate fails, the result is flagged and still passed downstream (the run is
marked "partially grounded"), never silently dropped. On budget or abort, the
best result so far is returned.

---

## Modes

The mode is auto-classified (or set explicitly). It changes what the graph does
and what a good answer contains.

| Mode | Runs code? | A good answer contains |
|---|---|---|
| `code` | yes - self-tests execute in a sandbox | a runnable solution + observed run evidence (exit code) |
| `design` | no | architecture, failure modes, rejected alternatives, a verified/unverified split |
| `incident` | no | a root cause, an evidence chain, competing hypotheses |
| `general` | no | a coherent answer; claims that were not verified are marked as such |

---

## Output

The result the agent (or you) sees:

```text
run: run-<id> (mode code)
composer: 2 candidate(s) -> 6 gated work-order(s); run fully grounded (hifi)
workspace context: 1 file(s), 14.2 KB via 2 scout round(s)
spent: $0.02 | 7 sub-calls | tokens 21k in / 4k out | wall 40s
artifacts: .hifi/runs/run-<id>/
answer: .hifi/runs/run-<id>/final.md
handoff: .hifi/runs/run-<id>/handoff.md
---
<the answer inline if short, else a preview + a path to final.md>

NEXT STEP: <apply the steps, present the answer, or relay a clarification>
```

Every run writes a full artifact tree under `.hifi/runs/<id>/`:

| File | Contents |
|---|---|
| `final.md` | the verified answer |
| `handoff.md` | summary, apply steps, open items, grounding |
| `run.json` | status, path, mode, budget, warnings |
| `triage.json` / `decompose.json` / `composer.json` | the plan and each step's gate result |
| `progress.jsonl` | the stage timeline |
| sub-call records | every prompt, response, model, token count, timing |

The pipeline returns a verified answer, **not** workspace changes. The host
agent applies the steps; the division of labor is deliberate.

---

## Configuration

Precedence: defaults ← `.hifi.json` (project root) ← `HIFI_*` env ← tool
parameters. The deprecated `APODEX_*` prefix and `.apodex.json` still work.

```jsonc
// .hifi.json
{
  "roles": {
    "generator": "session",                 // "session" or "provider/model-id"
    "worker":    "deepseek/deepseek-v4-flash",
    "analyst":   { "model": "deepseek/deepseek-v4-pro", "thinking": "high", "temperature": 0 }
  },
  "candidates": 4,                           // N, code mode, 1..8
  "rounds": 4,                               // K, linear-fallback GVR, 1..10
  "scoreThreshold": 92,
  "exec": { "enabled": true, "timeoutMs": 10000, "allowUnsandboxed": false },
  "triage": { "enabled": true },
  "brief": { "enabled": true },
  "context": { "enabled": true, "maxRounds": 2, "maxFiles": 16 },
  "composer": { "enabled": true },
  "budget": { "maxSubCalls": 60, "maxCostUsd": 5, "maxWallTimeMs": 1800000 },
  "runsDir": ".hifi/runs"
}
```

### Roles and their defaults

| Role | Job | Default model |
|---|---|---|
| `analyst` | triage, brief, decompose | session |
| `generator` | candidates, final assembly | session |
| `verifier` | holistic audit | session |
| `grader` | scoring (linear fallback) | session |
| `judge` | compare candidates | worker model (`flash`) |
| `worker` | classify, run, claim audit | `deepseek/deepseek-v4-flash` |
| `scout` | gather workspace files | worker model (`flash`) |

### Common env knobs

| Variable | Default | Effect |
|---|---|---|
| `HIFI_COMPOSER` | `1` | `0` falls back to the linear pipeline |
| `HIFI_CANDIDATES` | `4` | parallel candidates (code mode), 1..8 |
| `HIFI_EXEC_ENABLED` | `1` | `0` disables running self-tests |
| `HIFI_EXEC_ALLOW_UNSANDBOXED` | `0` | `1` opts into bare-host exec (see Security) |
| `HIFI_CONTEXT_ENABLED` | `1` | `0` skips workspace file gathering |
| `HIFI_TRIAGE_ENABLED` / `HIFI_BRIEF_ENABLED` | `1` | `0` skips that front stage |
| `HIFI_MAX_COST_USD` | `5` | per-run spend cap (0.01..50) |
| `HIFI_MAX_WALL_TIME_MS` | `1800000` | per-run wall-time cap |
| `HIFI_RUNS_DIR` | `.hifi/runs` | artifact directory |
| `HIFI_GENERATOR`, `HIFI_WORKER`, ... | - | bind a role to `provider/model-id` or `session` |

Out-of-range numbers are clamped with a warning; budget exhaustion returns the
best answer so far flagged `budgetExhausted`. Loops cannot run away.

---

## Security

Self-tests in `code` mode run model-generated code. Execution is **fail-closed**:
the pipeline refuses to run untrusted code unless a real isolation tier is
present, or you explicitly opt into bare-host execution.

`detectSandbox()` probes the host at startup and picks a tier; `execAdmission`
then maps tier + opt-in to an outcome:

| Detected tier | `allowUnsandboxed` | Outcome | Behavior |
|---|---|---|---|
| `rootless` (cgroup v2 + bubblewrap) | any | `sandbox` | self-tests run, kernel-isolated |
| `degraded` (no isolation) | `false` (default) | `disabled` | self-tests **do not run**; answer ships flagged "not executed" |
| `degraded` (no isolation) | `true` | `bare-host` | self-tests run **unsandboxed**, with a loud SECURITY warning each run |

The rootless tier confines the cell: no host filesystem mount, memory cap
(OOM-kill), process cap (no fork-bomb), no network, and a wall-clock timeout. It
is stack-agnostic - it wraps any command, so no language is special.

Default posture: no sandbox tier and no opt-in means **code is not executed**,
never run on the bare host silently.

---

## Measured results

The published benchmark measures the **linear pipeline** (the benchmark pins the
composer off for a stable comparison against earlier runs). The composer is the
default engine and is verified to run correctly across all four modes, but is not
yet scored on this suite.

Nine tasks (design / code / incident), each with a programmatic check the models
never see. Run of 2026-06-11; artifacts in
[`docs/eval-results/20260611-164416/`](docs/eval-results/20260611-164416/).

| Engine (heavy roles) | Bucket | Baseline (mean of 3) | Pipeline |
|---|---|---:|---:|
| flash | design | 0.89 | **1.00** |
| flash | code | 1.00 | 1.00 |
| flash | incident | 1.00 | 1.00 |
| flash | **overall** | **0.96** | **1.00** |
| pro | overall | 0.99 | 0.99 |

Reading: on a weak engine, verification lifts the unstable bucket (design) to
parity with a strong engine's single pass, at roughly twice the cost of one
strong-engine pass. On the strong engine the suite is already saturated; that
null result is reported as-is.

Reproduce:

```bash
git clone https://github.com/veschin/pi-hifi && cd pi-hifi
npm install
npx tsx eval/selfcheck.ts                 # validate the hidden tests themselves
npx tsx eval/run-eval.ts --engine both --concurrency 3
```

---

## Repository layout

```text
index.ts                 extension entry: the hifi tool + /hifi, /hifi-config
src/
  composer.ts            the work-graph executor (validate + run, gated, parallel)
  primitives.ts          the fixed catalog + each step's observation gate
  decompose.ts           task -> validated work-graph (catalog-bound)
  composer-pipeline.ts   front stages + composer + delivery (the default path)
  pipeline.ts            the linear fallback path
  triage.ts brief.ts context.ts delivery.ts   front stages
  sandbox.ts exec.ts     tier detection, admission, isolated execution
  llm.ts roles.ts budget.ts config.ts store.ts   sub-calls, roles, caps, config, artifacts
eval/                    free self-tests + the paid evaluation harness
docs/
  llm/                   operational specs (read before changing a subsystem)
  research/              test-time-compute literature survey
  eval-results/          published benchmark artifacts
```

---

## Credits

The verification approach draws on one published method and a broader survey:

- **Apodex-1.0** (Apodex Team, 2026) - the agent-team verification idea
  (parallel candidates, execution-grounded selection, generate-verify-revise,
  claim-level auditing). One input, not the whole design; the composer engine is
  this project's own work.
  [page](https://www.apodex.com/pdf/20260608)
- **Test-time-compute survey** -
  [`docs/research/test-time-boosting.md`](docs/research/test-time-boosting.md)
  (~130 sources, each load-bearing claim checked against its primary source).

License: [MIT](LICENSE).
