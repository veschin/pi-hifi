# pi-hifi - modular work-primitive system (design)

Status: **design**, 2026-06-13. Host-agnostic. Grounded on the current code;
"executor" names the *intended* grounding, not a built component. Supersedes the
stage-based rev.2 (the work-primitive model below is the evolution).

---

## 0. Core idea

A task is decomposed into a DAG of small **work-primitives**. Each primitive has
a typed, **hard-to-fake** I/O contract and a **checklist**.

> **hifi = every primitive's checklist passed.** It lives in the primitives, not
> the orchestrator - so no matter how the model composes or how deep it goes, the
> output is hifi (or honestly flagged).

Cheap models run the bulk (the observation-heavy 90%); the strong session does
only **decompose -> judge -> synthesize** (10%). The model picks **depth** (how
deep the DAG). Experiments run in a **pre-warmed, resource-capped sandbox pool**.

---

## 1. Hard-to-fake I/O - the trust principle (your point 1)

Every primitive output has two channels:
- **claim** - what the work-model *says*. Cheap to fake.
- **observation** - what the *system* did: an orchestrator-performed read, a
  sandbox-executed run, a fetched page, a real `file:line`, an exit code. The
  model **cannot author** this channel.

A primitive is *hard-to-fake* when its load-bearing output sits on the
**observation** channel. Design rule: **maximize primitives whose output is
observation-dominant.** The 90% (research / experiment / factcheck) are built
that way; the model-authored primitives (decompose / generate / judge) are
**grounded downstream** by observation primitives. More crisp observation-I/O
primitives => more of the work is un-fakeable => better.

---

## 2. Primitive catalog (more is better)

Tier: **W** = cheap worker, **S** = strong session. "Output" is the *observation*
the system records (not the model's prose). Each primitive is one isolated
sub-call or one orchestrator/sandbox action.

**RESEARCH - acquire info (W, parallel, bulk, observation-dominant):**
| primitive | input -> observed output | checklist (gate) | executor |
|---|---|---|---|
| `read` | path,range -> content+sha | content is the real file; sha re-checkable | orchestrator FS read |
| `grep` | pattern -> [{file,line,text}] | matches are real hits | ripgrep |
| `list` | glob -> [paths] | paths exist in the listing | git ls-files / walk |
| `web.search` | query -> [{url,snippet,at}] | real fetchable URLs, dated | search API |
| `web.fetch` | url -> {status,content,at} | HTTP status from a real fetch | fetcher |
| `api.contract` | lib/symbol -> signatures | extracted from real source/types | read+parse |

**EXPERIMENT - produce a fact by running (W, parallel, sandbox, hardest-to-fake):**
| primitive | input -> observed output | checklist | executor |
|---|---|---|---|
| `run` | argv,files -> {exit,stdout,stderr,oom,ms} | observed, not predicted; failure verbatim | sandbox pool |
| `test` | testCmd -> {pass,fail,names} | ran the real suite | sandbox pool |
| `bench` | argv,n -> {p50,p99,samples} | >=n samples, warm-discarded | sandbox pool |
| `build` | target -> {ok,errors} | real compiler output | sandbox pool |
| `typecheck` | files -> {errors} | real tsc/compiler | sandbox pool |
| `render` | html/url -> {screenshot,console,errors} | real headless render | sandbox pool (browser img) |
| `repro` | bug-spec -> {reproduced,output} | failure observed before any fix | sandbox pool |
| `probe` | contract-question,poc -> {behavior} | ran against the REAL api, representative | sandbox pool |

**FACTCHECK - verify a claim against evidence (W/S, parallel, isolated):**
| primitive | input -> observed output | checklist | executor |
|---|---|---|---|
| `audit` | claim,evidence -> verdict+citation | exec-claims need run-evidence; default unsupported | isolated sub-call |
| `cross` | claim,k-sources -> agreement | k independent sources/runs | k isolated calls |
| `invariant` | before,after,prop -> preserved? | prop ran on both sides | sandbox pool |

**GENERATE - author a candidate (W under D1, parallel-diverse):**
| primitive | input -> output | checklist | executor |
|---|---|---|---|
| `gen` | spec,criteria -> solution+selftest | ships a falsifiable selftest; lanes diverse | sub-call |
| `revise` | attempt,located-failure -> revised | revision re-run after | sub-call |

**ORCHESTRATE - the strong 10% (S, isolated):**
| primitive | input -> output | checklist | executor |
|---|---|---|---|
| `decompose` | task,materials -> work-order DAG | only catalog primitives; fail-safe->ask | strong sub-call |
| `judge` | A,B,evidence -> winner+axes | sees experiment evidence; isolated; tie!=silent pick | strong sub-call |
| `select` | candidates,pass-matrix -> winner | B4 when matrix exists, else `judge` | deterministic / strong |
| `synthesize` | verified-atoms -> final | only verified; unsupported flagged; blocks verbatim | strong sub-call |

Catalog is **fixed and extensible by us** - the model composes from it, never
invents a primitive. Adding a primitive = adding a row with an executor + a
checklist (one place, audited).

---

## 3. Composer

- A **WorkOrder** = `{ primitive, input, deps, checkpoint?, collect? }`.
- `decompose` (strong) emits a **DAG** of work-orders. **Depth = how far it
  decomposes** - the model's only real freedom, bounded by the fixed catalog +
  the global budget guard.
- The composer executes the DAG: typed I/O wires only compatible primitives;
  independent orders run **in parallel** (dispatched to the sandbox pool /
  sub-call concurrency); each order's output must **pass its checklist** before
  feeding downstream (the per-primitive hifi gate).
- **checkpoint** (your "точки остановки", pre-marked): an order may declare "after
  me the run may pause for the user and resume stateless" - reuses the existing
  clarification contract.
- **collect** (your "точки сбора", pre-marked): an order declares what it
  snapshots into the run store + exposes downstream.
- Not a free DAG-builder: predictable because primitives + checklists + costs are
  fixed; budgetable because every order is one guarded call/cell.

---

## 4. Sandbox - pre-warmed pool, host-agnostic (your point 2)

**Abstraction:** `SandboxPool` - a set of **always-warm**, resource-capped,
fs-confined, no-net-by-default execution cells. The orchestrator **provisions the
pool in advance** (at session start), sizes it from **detected** host capacity,
and dispatches many work-units into it (warm = a job is exec-into-a-live-cell +
a clean workdir, no cold start).

**Backends, chosen by `detectSandbox()` at startup (preference order):**
1. **Container pool (preferred - your idea):** a lightweight pre-built image with
   the common runtimes baked in; `N` containers kept warm. Native caps:
   `--memory --cpus --pids-limit --network none --read-only` + a per-job tmpfs
   workdir, no host FS mount. Docker or Podman, whichever `detect` finds.
2. **Rootless cells:** `systemd-run --user --scope` (cgroup mem/cpu/pids) `+ bwrap`
   (fs/net) - for hosts without a usable container daemon. Colder per-job.
3. **Degraded:** `prlimit + timeout` only - flagged, no isolation boundary.

**Scheduler / admission (governs "many models into the pool"):**
- `cellSem` = pool size `N` (sized to detected cores/RAM) -> caps concurrency.
- `ramReserve`: Σ(running cells' memMax) <= host fraction -> no memory over-commit.
- `gpuSem` = small separate pool; only `gpu:true` cells take a GPU ticket -> **a
  burst of agents cannot all land on the GPU**, they queue.
- a cell runs only after `acquire(cell ∧ ram [∧ gpu])`; releases on exit.

**This is what makes I/O trustworthy AND safe:** runaway prevention is structural,
kernel-enforced - a job can't grep the host (no FS mount), can't exhaust RAM (cap
-> OOM-kill), can't fork-bomb (pids cap), can't reach network (none), can't run
forever (wall timeout). Stack-agnostic: a cell wraps **any argv** - node/python/
go/browser/`sh -c "<test cmd>"` - so **no language is special**.

**Honest privilege note:** a Docker daemon implies some privilege; rootless
Docker/Podman or backend #2 cover unprivileged hosts. `io` limits are
backend-dependent (rootless cgroup may not delegate `io`); disk-thrash is bounded
instead by the tmpfs-sized workdir.

---

## 5. How it lands on the current code (to-be)

| current | becomes |
|---|---|
| roles `scout/worker/generator/grader/judge/verifier/assembler` | **executors** for primitives (scout->`read/grep/list`, generator->`gen`, judge->`judge`, verifier->`audit`, assembler->`synthesize`) |
| `exec.ts runNodeScript` (bare host node) | the `run/test/bench/...` executor, via the **SandboxPool** (node = one argv) |
| `SubCallClient` | unchanged - isolated gateway for every model-primitive |
| `Budget` | unchanged - caps total work-orders + pool spend |
| `RunStore` | the **collect-point** implementation |
| `pipeline.ts runApodex` (linear) | the **composer** over the DAG |
| `classifyMode` (4 modes) | the `decompose` primitive (richer) |

Backbone (isolation-by-construction, roles, budget, store) is kept. New: the
**primitive catalog** (typed + checklisted), the **composer**, the **warm
SandboxPool**.

---

## 6. Not yet verified (honest)

- Pool warm-up cost + per-job `exec` latency: not measured.
- Rootless `io` limiting: backend-dependent; mitigated by tmpfs workdir size.
- `decompose` reliability is the dominant risk (mis-decompose -> wrong work
  ordered; checklists catch unit errors, not "wrong unit chosen") -> fail-safe to
  ask / order more, never silent-cheap.
- The catalog above is a starting set; primitives are meant to grow.
