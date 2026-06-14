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

**Abstraction:** `SandboxPool` - a set of resource-capped, fs-confined,
no-net-by-default execution cells, sized from **detected** host capacity, with
admission control dispatching many work-units into it. (Implemented as admission
control - `cellSem` / `ramReserve` / `gpuSem`, src/sandbox-pool.ts - over per-job
rootless scopes; the always-warm live-cell pool described below is a docker-tier
optimization, deprioritized along with that backend.)

**Backends, chosen by `detectSandbox()` at startup. DECISION (2026-06-13): the
rootless tier is PRIMARY/default; Docker is demoted to a niche backend for
genuinely docker-specific tasks, not the general path:**
1. **Rootless cells (PRIMARY - implemented, src/sandbox.ts):** `systemd-run
   --user --scope` (cgroup v2: MemoryMax / MemorySwapMax / CPUQuota / TasksMax,
   fully unprivileged) `+ bwrap` (mount + net namespaces). Needs cgroup v2 +
   bubblewrap + user-slice cpu/memory/pids delegation. Verified: OOM-kill, fs
   confinement, net isolation, size-capped RAM-backed tmpfs `/work`.
2. **Docker/Podman (niche, not built):** a pre-built warm image with runtimes
   baked in (`--memory --cpus --pids-limit --network none --read-only` + tmpfs
   workdir). Reserved for genuinely docker-specific work; the rootless tier
   covers the general case, so this backend is deprioritized.
3. **Degraded:** no isolation boundary - REFUSES untrusted work. The exec layer
   then either runs on the bare host behind an explicit opt-in
   (`exec.allowUnsandboxed`, loud SECURITY warning) or disables self-tests; see
   `execAdmission` in [llm/30_subcall_infra.md](llm/30_subcall_infra.md).

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

**Honest privilege note:** the primary rootless tier is fully unprivileged (no
daemon). `io` limits may not be delegated to the user cgroup; disk-thrash is
bounded instead by the size-capped, RAM-backed tmpfs workdir (a `/work` write
beyond the cap hits MemoryMax and OOM-bounds, never the host disk).

---

## 5. How it lands on the current code (to-be)

| current | becomes |
|---|---|
| roles `scout/worker/generator/grader/judge/verifier/assembler` | **executors** for primitives (scout->`read/grep/list`, generator->`gen`, judge->`judge`, verifier->`audit`, assembler->`synthesize`) |
| `exec.ts runNodeScript` (bare host node) | the `run/test/bench/...` executor, via the **SandboxPool** (node = one argv) |
| `SubCallClient` | unchanged - isolated gateway for every model-primitive |
| `Budget` | unchanged - caps total work-orders + pool spend |
| `RunStore` | the **collect-point** implementation |
| `pipeline.ts runHifi` (linear) | the **composer** over the DAG |
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
