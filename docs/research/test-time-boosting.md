# Test-Time Boosting: Strengthening a Weak-Reasoning LLM at Inference Time

Literature survey, compiled 2026-06-11. Focus: 2024-2026 work (2023 classics kept as anchors) on improving a cheap, weak-reasoning model purely at inference time - no fine-tuning, no training, low cost.

## 0. Context, scope, verification status

**Target system.** pi-hifi: a verification-centric pipeline running on DeepSeek models - `deepseek-v4-flash` (cheap/weak: $0.14/$0.28 per 1M tokens in/out) as worker, `deepseek-v4-pro` ($0.435/$0.87, ~3.1× the price) for heavy roles. The pipeline already implements, per task:

1. **Selector** - N parallel candidates (generator, t=0.8), node-executed self-tests producing execution evidence, pairwise judge on comprehension/causality/grounding axes (N clamped 1..8).
2. **GVR loop** - generate->verify->revise, K rounds: a grader in a FRESH single-turn context (sees only task + candidate, never the generator's trace) emits a score plus a written critique against a hifi rubric; the generator revises against the critique; early stop at a score threshold.
3. **External verifier** - claim atoms extracted, each audited independently against task + answer + exec evidence; holistic approve/revise/reject.
4. **Assembler** - final answer rebuilt from verified atoms; contradicted claims corrected/removed, unsupported ones flagged.

**The question.** Which additional inference-time techniques mitigate weak-model failure modes - shallow reasoning, hallucinated APIs, happy-path code, sycophantic self-review - and at what cost?

**Verification legend.** Every load-bearing number in this report was checked against a primary source in June 2026:

- *(abs)* - quoted/confirmed from the arXiv abstract page, fetched during this survey (by the author or a research subagent; the ~25 most load-bearing numbers were additionally re-fetched by the author directly).
- *(body)* - from the paper's HTML/ar5iv/PDF body, fetched during this survey.
- *(secondary)* - from a search snippet, blog, or README quoting the paper; not confirmed against the primary text.
- **UNVERIFIED** - could not be confirmed; treat as a lead, not a fact.

Cost multipliers are stated relative to a single greedy pass of the same model unless noted otherwise.

---

## TL;DR - top 10 moves for the deepseek-v4-flash case, ranked by expected value per dollar

1. **Consistency-gated escalation (flash->pro cascade).** Agreement among the N candidates the pipeline already produces is a free, well-calibrated confidence signal; agree -> ship/skip rounds, disagree -> escalate grader or generator to pro. Verified anchors: GPT-4 parity at **40% of GPT-4 cost** (MoT cascades, 2310.03094), **>50% cost cut** (AutoMix), **2.5-3.5×** cheaper on agent tasks (ICD, 2512.02543). Cost: ~0 added; saves 2-3× on the pro budget. Orchestration only.
2. **Adaptive candidate budgets (early-stopping self-consistency).** Draw candidates incrementally, stop when a window agrees: **−33.8% to −84.2% samples** at comparable accuracy (ESC, 2401.10480), up to **7.9× fewer samples at <0.1% accuracy drop** (Adaptive-Consistency, 2305.11860). Cost: a multiplier *reduction* of 3-8× on the selector stage. A few lines of stopping logic.
3. **B4 Bayesian selection over the (candidate × test) pass matrix.** Replaces pass-count/consensus heuristics with the posterior-optimal rule when both code and tests are unreliable - exactly the weak-generator regime: **up to +50% relative over the strongest heuristic** there (2409.08692, code public). Zero extra LLM calls.
4. **Behavioral clustering + distinguishing inputs.** Execute candidates on shared inputs, cluster by output equivalence (AlphaCode), and on ties have the model synthesize the input where two finalists disagree, then execute it (S*, 2502.14382: enables **a 3B model to beat GPT-4o-mini**; SEP 2604.06485: HumanEval+ 0.754->0.826 at N=10). Cuts judge calls by the dedup factor; a few extra flash calls.
5. **Cross-family grading vote.** Same-family graders over-score their kin even controlling for quality (CAPA, 2502.04313: partial r=0.35-0.65 *(body)*) and flash-class judges score **below random** on hard reasoning pairs (JudgeBench, 2410.12784). A panel of 2-3 cheap judges from disjoint families beats a single GPT-4 judge on human agreement at **7-8× lower cost** (PoLL, 2404.18796). Cost: +2-3 cheap calls per grading point.
6. **Error-located, execution-grounded revision feedback.** Self-correction works only with external signal (consensus of 2310.01798, 2406.01297, CRITIC); models can fix located mistakes (+18-44 pts) but cannot find them (GPT-3.5 finds 14.78% of mistakes; Tyen 2311.08516). Feed failing-test output, property counterexamples (PGS, 2506.18315: **+13.4% pass@1**), and claim-audit contradictions verbatim into revision - never a holistic "improve this" (judge critiques measurably fail to steer generators: JETTS, 2504.15253). Cost-neutral prompt/orchestration change.
7. **Deterministic symbol gates + selective docs-RAG before generation.** Package hallucination runs **5.2% (commercial) / 21.7% (open-source)** of generations (2406.10279) - a registry existence check is near-free. Docs retrieval pays **+83-220% on rare libraries** (2503.15231) but always-on retrieval *costs* −39pp on well-known APIs; trigger on index-miss/low-confidence only (CloudAPIBench, 2407.09726). Cost: ~1.1-1.5× generation; needs a docs index.
8. **Contrastive, scaled verification on finalists.** Verification accuracy rises when the verifier compares candidates against each other instead of scoring in isolation, and when multiple verification samples are voted (Sample-Scrutinize-Scale, 2502.01839 - lifted Gemini 1.5 Pro above o1-preview). Apply pro to <=3 deduped finalists, k verification samples each. Cost: ~3-9 pro calls per task, on finalists only.
9. **Keep N small; spend the margin on verifier quality.** With imperfect verifiers, false positives bound the achievable accuracy and **optimal sampling attempts are often <10** (Inference Scaling Flaws, 2411.17501); no amount of flash resampling reaches a sufficiently strong model's single-sample accuracy. The pipeline's N<=8 clamp is already right; marginal dollars go to better tests/properties, not more candidates.
10. **The negative list (saves money outright).** Skip: homogeneous multi-agent debate (fails to beat self-consistency at matched compute - 2311.17371, 2502.08788); intrinsic self-critique without signal (degrades: GPT-4 GSM8K 95.5->91.5->89.0 over two rounds, 2310.01798); always-on RAG; rigid schema-constrained *reasoning* (reason first, format after - 2408.02442 + dottxt rebuttal); heavyweight CoT scaffolds outside math/symbolic/code (≈0 gain elsewhere - 2409.12183).

---

## 1. Test-time compute scaling laws

### 1.1 Compute-optimal test-time scaling - Snell, Lee, Xu, Kumar (2024), arXiv:2408.03314

- **What:** allocate test-time compute per-prompt between parallel search against a process reward model (PRM) and sequential revision, choosing the strategy by estimated difficulty.
- **Evidence** *(abs)*: "improve the efficiency of test-time compute scaling by more than 4x compared to a best-of-N baseline"; FLOPs-matched, "test-time compute can be used to outperform a 14x larger model" - on problems where the small base model has non-trivial success rates. MATH benchmark.
- **Cost:** reallocation at matched budget (≈4× cheaper than best-of-N for equal accuracy).
- **Verdict for flash:** the headline mechanism needs a trained PRM and difficulty estimation - not usable against a black-box API. The transferable insight is the *policy*: easy tasks -> revision (GVR), hard tasks -> parallel sampling (selector). pi-hifi already has both stages; what is missing is the difficulty-aware split (see §2.7, agreement as difficulty signal).
- **Effort:** N/A directly; policy idea is orchestration-level.

### 1.2 Large Language Monkeys - Brown et al. (2024), arXiv:2407.21787

- **What:** pure repeated sampling; coverage (fraction of problems where *any* sample is correct) scales log-linearly with sample count over four orders of magnitude.
- **Evidence** *(abs)*: SWE-bench Lite with DeepSeek-Coder-V2-Instruct (a cheap open model - directly our class): "increases from 15.9% with one sample to 56% with 250 samples, outperforming the single-sample state-of-the-art of 43%". *(body)*: Gemma-2B on CodeContests pass@1 0.02% -> pass@10k 7.1%. Critical caveat *(abs)*: "common methods for picking from a sample collection (majority voting and reward models) plateau beyond several hundred samples" - coverage converts to accuracy only where automatic verification exists.
- **Cost:** N× generation.
- **Verdict:** validates the selector stage's premise (weak model + many samples + execution selection). Not a new component - a tuning law: N is the main dial, and it only pays while the verifier can harvest it.
- **Effort:** none (already implemented). Code: github.com/ScalingIntelligence/large_language_monkeys.

### 1.3 Inference scaling laws (compute-optimal inference) - Wu et al. (2024), arXiv:2408.00724

- **What:** systematic cost-performance comparison of greedy/majority/best-of-N/weighted voting/tree search across model sizes.
- **Evidence** *(abs)*: "smaller models combined with advanced inference algorithms offer Pareto-optimal trade-offs in cost and performance"; Llemma-7B + their REBASE tree search "consistently outperforms the Llemma-34B model" on MATH across all inference strategies at matched compute.
- **Cost:** Pareto framing; tree search needs a reward model.
- **Verdict:** more small-model evidence for the weak-generator strategy; REBASE itself needs a value model - skip.

### 1.4 The counter-result: Inference Scaling Flaws - Stroebl, Kapoor, Narayanan (2024), arXiv:2411.17501

- **What:** analytical + empirical limit theorem: a verifier with non-zero false-positive rate imposes a hard accuracy ceiling on resampling, regardless of compute.
- **Evidence** *(abs)*: "no amount of inference scaling of weaker models can enable them to match the single-sample accuracy of a sufficiently strong model"; "optimal sampling attempts are often fewer than 10, as the negative utility of false positives outweighs benefits". On HumanEval/MBPP, whose unit tests have limited coverage, false positives also carry secondary defects (convention violations). Note: the paper was retitled between versions (v1 "Inference Scaling fLaws..." -> current "The Limits of Inference Scaling Through Resampling").
- **Cost:** N/A - a design constraint.
- **Verdict:** the single most important *constraint* for pi-hifi: with flash-authored self-tests as the verifier, raising N beyond ~10 buys false positives, not accuracy. The pipeline's N<=8 clamp is consistent with this. The leverage is verifier precision (better tests, properties, external audit) - which is exactly where the pipeline already invests. Escalating the *generator* to pro on hard tasks is the other escape hatch the theorem allows.
- **Effort:** none - informs budgets.

### 1.5 Sample, Scrutinize and Scale - Zhao, Awasthi, Gollapudi (2025), arXiv:2502.01839

- **What:** minimalist sampling-based search: generate many candidates, self-verify each (multiple verification samples), pick the best - scaling *verification* compute, not just generation.
- **Evidence** *(abs, qualitative)*: "elevates the reasoning capabilities of Gemini v1.5 Pro above that of o1-Preview on popular benchmarks". Two transferable findings: (i) *implicit scaling* - self-verification accuracy improves as the candidate pool grows; (ii) comparing across responses localizes errors better than judging in isolation. Also: "frontier models demonstrate remarkably weak out-of-box verification capabilities." Per-benchmark numbers not in abstract (UNVERIFIED).
- **Cost:** high in their maximal config (N candidates × k verification calls each).
- **Verdict:** composable - the *contrastive verification* principle upgrades both the pairwise judge and the grader: give them multiple candidates to compare rather than one to score. The "weak out-of-box verification" finding doubles as a warning about single-pass flash verification.
- **Effort:** prompt + orchestration.

### 1.6 PRM-guided weak-model scaling - Liu et al. (2025), arXiv:2502.06703

- **What:** compute-optimal test-time scaling with PRM-guided search as a function of policy model, PRM, and difficulty.
- **Evidence** *(abs)*: "a 1B LLM can exceed a 405B LLM on MATH-500"; "a 0.5B LLM outperforms GPT-4o, a 3B LLM surpasses a 405B LLM, and a 7B LLM beats o1 and DeepSeek-R1". Code: github.com/RyanLiu112/compute-optimal-tts.
- **Cost:** TTS budgets (typically <=N=256, UNVERIFIED detail); requires downloadable PRMs + open weights for guided search.
- **Verdict:** strongest published "weak model + verifier beats giant" datapoint, but PRM-based search is not implementable against the DeepSeek API. Cite as direction-validating; do not integrate.

### 1.7 Adjacent: s1 (arXiv:2501.19393) involves SFT - **out of scope** for a no-training pipeline; its "budget forcing" decoding trick is measured only on the fine-tuned model. Certaindex/Dynasor (arXiv:2412.20993, *(abs)*: "up to 50% compute savings and 3.3× higher throughput" with no accuracy drop) is a serving-layer system - the portable idea (answer-stabilization as an early-exit signal) is already covered by ESC-style stopping (§2.3-2.4). Survey of the field: "A Survey on Test-Time Scaling in Large Language Models" (arXiv:2503.24235).

**Thread 1 net:** weak-model + test-time compute is the literature's best-supported strategy *conditional on verifier quality*; returns saturate fast (N<10) under imperfect verifiers. pi-hifi's architecture matches the consensus; tune N adaptively rather than raising it.

---

## 2. Self-consistency and budget-aware variants

### 2.1 Self-Consistency (SC) - Wang et al. (2022), arXiv:2203.11171

- **What:** sample N diverse CoT paths at temperature, majority-vote the final answer.
- **Evidence** *(abs)*: +17.9% GSM8K, +11.0% SVAMP, +12.2% AQuA, +6.4% StrategyQA, +3.9% ARC-challenge (absolute, over CoT-greedy, 2022-era large models).
- **Cost:** N× (5-40 typical). Multiple API calls only; no logprobs.
- **Verdict:** subsumed by the selector for code mode. Relevant for design/incident modes where execution evidence does not exist - but see USC (§2.2), which handles free-form outputs.
- **Effort:** trivial.

### 2.2 Universal Self-Consistency (USC) - Chen et al. (2023), arXiv:2311.17311

- **What:** concatenate all N candidates and ask the LLM itself to pick the most consistent one - majority voting for free-form outputs where exact-match voting is impossible.
- **Evidence** *(abs, qualitative)*: matches standard SC on math; matches *execution-based voting on code without executing*. No numbers in abstract.
- **Cost:** N samples + 1 long-context selection call.
- **Verdict:** **directly composable** - pi-hifi's design and incident buckets have no execution evidence; USC is the matching selector there (currently the pipeline's pairwise judge plays this role; USC is the cheaper one-call variant, the pairwise tournament the more thorough one).
- **Effort:** prompt-only.

### 2.3 Adaptive-Consistency - Aggarwal et al. (2023), arXiv:2305.11860

- **What:** incremental sampling with a Dirichlet/Beta stopping rule on the majority answer's stability.
- **Evidence** *(abs)*: "reduces sample budget by up to 7.9× with an average accuracy drop of less than 0.1%" (17 datasets, 3 LLMs). Code: github.com/Pranjal2041/AdaptiveConsistency.
- **Cost:** ~N/3 to N/8 of fixed-N.
- **Verdict:** composable upstream of execution selection - generate candidates incrementally, stop early when they behaviorally agree.
- **Effort:** small orchestration (closed-form Beta test).

### 2.4 Early-Stopping Self-Consistency (ESC) - Li et al. (2024), arXiv:2401.10480

- **What:** sample in small windows; stop when a window is unanimous.
- **Evidence** *(abs)*: sampling reduced by −33.8% (MATH), −80.1% (GSM8K), −76.8% (StrategyQA), −78.5% (CommonsenseQA), −84.2% (Coin Flip), −67.4% (Last Letters) at comparable accuracy.
- **Cost/effort:** as §2.3; even simpler.

### 2.5 Soft Self-Consistency - Wang et al. (2024), arXiv:2402.13212

- **What:** replace discrete voting with continuous likelihood scores (sum/mean token logprobs), for tasks where answers rarely repeat exactly (agent action spaces).
- **Evidence** *(abs)*: +1.3% bash, +6.6% WebShop, +4.7% ALFWorld over SC at fixed samples; half the samples for comparable performance. **Needs logprobs** - the DeepSeek API exposes `logprobs`/`top_logprobs` (checked against api-docs.deepseek.com this session), so this is available. Code: github.com/HanNight/soft_self_consistency.
- **Verdict:** optional refinement if free-form consistency voting is added; not first-priority.

### 2.6 Difficulty-adaptive and 2025-26 successors

DSC (arXiv:2408.13457) adds a difficulty prior to ESC/ASC (*(abs)* qualitative: beats both on cost; numbers UNVERIFIED). CGES (arXiv:2511.02603, *(abs)*): Bayesian posterior stopping cuts calls **58% (16.0->6.7)** within 0.4pp of SC; also names SC's failure mode - majority vote fails when the correct answer is infrequent (the hard tail where a weak model's modal answer is wrong). 2026 leads (titles found, abstracts not fetched - UNVERIFIED): 2601.02970 (reliability-aware adaptive SC), 2602.05395 (optimal Bayesian stopping), 2603.08999 (confidence-aware SC), 2605.05873 ("CITE", anytime-valid stopping). Direction: ESC-style rules rebuilt on formal statistical guarantees.

### 2.7 Consistency as a *confidence signal* - Lyu et al. (2024), arXiv:2402.13904

- **What:** derive calibrated confidence from the distribution of N samples (agreement, entropy, first-second distance).
- **Evidence** *(abs)*: consistency-based calibration "outperform[s] existing post-hoc approaches" (logit-based, verbalized confidence) across open and closed models on nine reasoning datasets. No logprobs needed for the agreement/FSD variants. Code: github.com/veronica320/Calibrating-LLMs-with-Consistency.
- **Verdict:** **the highest-leverage free signal in this whole survey for pi-hifi**: the selector already produces N candidates; their (behavioral) agreement rate is a calibrated difficulty/confidence estimate that can gate everything downstream - GVR round count, escalation to pro, external-verification depth.
- **Effort:** orchestration only.

### 2.8 ModelSwitch - Chen et al. (2025), arXiv:2504.00762

- **What:** repeated sampling across *multiple weak models*: if model A's samples agree internally, stop; if chaotic, switch to model B.
- **Evidence** *(body)*: MATH 81% with 35 samples vs Gemini 1.5 Flash 79.8% with 512 samples (14× more efficient; pair: Gemini 1.5 Flash + GPT-4o-mini); MathBench 75% @48 vs Gemma-2-9B 73.7% @512 (10×); a 9B+8B combo reaches 69% ≈ a 70B model with only 7 samples.
- **Cost:** tens of samples; worst case ~2× single-model SC.
- **Verdict:** composable if a second cheap non-DeepSeek model is added (which §5 independently recommends for grading): on low agreement, switching the *generator* family beats burning more flash samples.
- **Effort:** orchestration + second API key.

**Thread 2 net:** the budget-aware SC family is mature and directly portable: incremental sampling with agreement-based stopping (3-8× cheaper selector), agreement as calibrated confidence for gating/escalation (free), USC for non-executable buckets.

---

## 3. Critique/revise loops: when self-correction works vs fails

This is the thread with the sharpest apparent contradiction in the literature; the reconciliation (§3.9) matters more than any single paper.

### 3.1 Self-Refine - Madaan et al. (2023), arXiv:2303.17651

- **What:** same model generates -> self-feedback -> refines, iterating; no external signal.
- **Evidence** *(abs)*: "~20% absolute on average" across 7 tasks (GPT-3.5/ChatGPT/GPT-4). *(body, Table 1)*: the average hides extreme variance - Dialogue +49.2, Sentiment Reversal +32.4, Code Optimization +8.7 (GPT-4), but **Math Reasoning (GSM8K) +0.0-0.2 across all models**. Gains concentrate in preference/style tasks with no single correct answer. Model dependence *(body)*: Vicuna-13B "was not able to consistently generate the feedback in the required format ... even when provided with Oracle ... feedback, it often failed to adhere to the prompts for refinement" - weak models fail at *both* roles.
- **Cost:** ~3-9× (up to 4 feedback+refine iterations).
- **Verdict:** for a flash-class model on correctness-critical tasks, intrinsic Self-Refine is not supported by its own paper's data. Style/readability polish is the one defensible use.
- **Effort:** prompt-only (but see verdict).

### 3.2 Reflexion - Shinn et al. (2023), arXiv:2303.11366

- **What:** agent acts, receives a *task feedback signal* (test execution, environment reward), verbally reflects, stores the reflection, retries.
- **Evidence** *(abs)*: 91% pass@1 on HumanEval (vs GPT-4's 80%). The load-bearing detail *(body)*: for coding, Reflexion generates and **executes** its own unit tests; ablation on the 50 hardest problems - base 0.60, *without* test generation 0.52 (worse than base), self-reflection without tests 0.60 (no gain), full 0.68 (single-extraction figures; flagged). The 91% headline is an **external-feedback** result, not a self-critique result.
- **Cost:** ~3-10× (k trials × generate + test + execute + reflect).
- **Verdict:** pi-hifi's GVR with execution evidence *is* the Reflexion pattern done right. The ablation is the strongest argument for never running the revise loop without a grounded signal.
- **Effort:** already implemented in spirit.

### 3.3 Chain-of-Verification (CoVe) - Dhuliawala et al. (2023), arXiv:2309.11495

- **What:** draft -> plan verification questions -> answer them **independently, without the draft in context** -> revise.
- **Evidence** *(body, Llama-65B)*: Wikidata list precision 0.17->0.36; MultiSpanQA F1 0.39->0.48; biography FActScore 55.9->71.4. Factored variants (each question answered in a clean context) consistently beat joint ones (60.8 joint vs 63.7 factored vs 71.4 factor+revise) - *quantified* evidence that decoupling verification from the generation context is what buys the gain.
- **Cost:** ~3-6× (draft + plan + per-question call + rewrite).
- **Verdict:** pi-hifi's claim-atom audit in fresh contexts is CoVe-factored already. The one importable refinement: ensure atom audits never see the full draft, only the atom + task + evidence.
- **Effort:** prompt audit of the existing verifier.

### 3.4 CRITIC - Gou et al. (ICLR 2024), arXiv:2305.11738

- **What:** verify-then-correct where critiques come from **external tools** (search, interpreter, scoring APIs).
- **Evidence** *(body/PDF)*: ChatGPT +7.7 F1 (QA), +7.0 (math), −79.2% toxicity. The paper's own key negative: "exclusive reliance on self-correction without external feedback may yield modest improvements or even deteriorate performance" - e.g. text-davinci-003 GSM8K PoT 70.1 -> 68.3 with tool-less self-critique (worse than doing nothing). "Typically, 2-3 rounds of corrections yield most of the benefits." Works better with stronger models (LLaMA-2 7B/13B/70B gains +4.7/+9.4/+16.0 even *with* tools).
- **Cost:** ~3-8× + tool latency.
- **Verdict:** validates the external-verifier stage and the bounded-K design; the 2-3-rounds finding suggests default K=3, not higher.

### 3.5 The skepticism line (the other side of the contradiction)

- **Huang et al. (ICLR 2024), arXiv:2310.01798** *(abs)*: "LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction." *(body)*: GPT-4 GSM8K 95.5->91.5->89.0 over two intrinsic correction rounds; GPT-3.5 CommonSenseQA 75.8->38.1. Earlier positive results used oracle labels to decide when to stop (leakage). Also *(body)*: multi-agent debate with 6 agents (83.2%) loses to plain self-consistency with 6 samples (85.3%).
- **Kamoi et al. (TACL 2024), arXiv:2406.01297** *(abs)* - the closest thing to a field consensus: "(1) no prior work demonstrates successful self-correction with feedback from prompted LLMs, except for studies in tasks that are exceptionally suited for self-correction, (2) self-correction works well in tasks that can use reliable external feedback, (3) large-scale fine-tuning enables self-correction."
- **Tyen et al. (2024), arXiv:2311.08516** *(abs)*: "poor self-correction performance stems from LLMs' inability to *find* logical mistakes, rather than their ability to correct a known mistake." *(body)*: mistake-location accuracy on objective CoT traces - GPT-4 52.87%, **GPT-3.5-Turbo 14.78%**; given the ground-truth error location, correction lifts originally-wrong traces by **+18 to +44 points**. A small trained classifier beats few-shot prompting of a much larger model at mistake *finding*.

### 3.6 LLM-as-judge reliability (grader-choice evidence)

- **JudgeBench - Tan et al. (ICLR 2025), arXiv:2410.12784** *(abs)*: on objective-correctness response pairs, "many strong models (e.g., GPT-4o) performing just slightly better than random guessing." *(body/PDF)*: with order-swap consistency required, vanilla GPT-4o 50.86% overall / 47.96% on reasoning (random = 50%); **flash-class judges land far below random - Claude-3-Haiku 33.14%, Gemini-1.5-Flash 39.71%, Llama-3.1-8B 40.86%**; reasoning-class judges work: o1-preview 75.43%, o3-mini-high 80.86%, DeepSeek-R1 73.14%. Judge accuracy mirrors solver accuracy; in coding, solvers beat judges - verification is not uniformly easier than generation.
- **Self-preference - Panickssery et al. (2024), arXiv:2404.13076** *(abs/body)*: "LLM evaluators recognize and favor their own generations"; GPT-4 self-recognition 73.5% out of the box; fine-tuned self-recognition correlates linearly with self-preference (causal evidence).
- **Wataoka et al. (2024), arXiv:2410.21819** *(abs)*: the mechanism is **perplexity/familiarity** - judges over-score low-perplexity-to-them text regardless of authorship. Consequence: a same-family grader (pro grading flash) inherits a measurable bias because flash outputs are low-perplexity to pro.
- **JETTS - Zhou et al. (ICML 2025), arXiv:2504.15253** *(abs)*: across reranking/beam-search/refinement, judges ≈ outcome reward models at reranking, but "their natural language critiques are currently ineffective in guiding the generator towards better responses."
- **Zheng et al. (2023), arXiv:2306.05685**: canonical position/verbosity/self-enhancement biases; order-swap with inconsistency-as-no-verdict is the standard mitigation.
- **Do LLM evaluators prefer themselves for a reason? - Chen et al. (2025), arXiv:2504.03846** *(abs)*: harmful self-preference concentrates where the evaluator erred as a generator; forcing long CoT before the verdict reduces it.

### 3.7 Verification asymmetry / generation-verification gap

- **Jason Wei, "Asymmetry of verification and verifier's law" (blog, 2025-07)**: some tasks are far easier to verify than solve (test-executed code - right side); free-form factual review can be *harder* to verify than generate (Brandolini's law - wrong side, which is why claim decomposition is needed).
- **Mind the Gap - Song et al. (2024), arXiv:2412.02674** *(abs)*: formalizes self-improvement capability as the generation-verification gap; "a variant of the generation-verification gap scales monotonically with the model pre-training flops." Flash-class models sit low on this curve - there is little verification surplus to harvest by self-critique.
- **Variation in Verification - Zhou et al. (2025), arXiv:2509.17995** *(abs)*: "weak generators produce errors that are easier to detect than strong generators"; with a fixed decent verifier, a weak generator closes most of the gap to a stronger one (Gemma2 9B->27B gap shrinks 75.7%); but verifier scaling alone cannot overcome verification failures on the hardest problems.
- **Small LMs Need Strong Verifiers - Zhang et al. (ACL Findings 2024), arXiv:2404.17140** *(abs)*: <=13B models can produce useful refinements only when a strong verifier decides *when* to correct; with the small model's own self-verifier the pipeline degrades. Directly: do not let flash gate its own accept/reject.
- **Weaver - Saad-Falcon et al. (2025), arXiv:2506.18203** *(abs)*: aggregating many weak verifiers (judges + RMs <=70B) via weak supervision turns them into a strong selection signal - Llama-3.3-70B generator reaches 87.7% avg on reasoning/math (o3-mini-level). (Distillation-to-400M figures: *(secondary)*, partially verified.) Weak verifiers are individually unreliable but aggregatable.

### 3.8 Fresh-context grading and sycophancy (validates the pipeline's core design)

- **Kim & Khashabi (EMNLP Findings 2025), arXiv:2509.16533** *(abs)*: models "are more likely to endorse a user's counterargument when framed as a follow-up from a user, rather than when both responses are presented simultaneously for evaluation." Same content, different framing: conversational continuation -> sycophantic flip; separate evaluative context -> mostly correct adjudication. This is the direct experimental support for pi-hifi's fresh-context grader.
- **SycEval - Fanous et al. (2025), arXiv:2502.08177** *(secondary)*: sycophancy in 58.19% of evaluation cases; regressive (correct->incorrect) flips 14.66%.
- **Authorship obfuscation - Mahbub & Feng (2025), arXiv:2512.05379** *(abs)*: perturbations that reduce self-recognition "predictably reduce self-preference" - but the bias partially survives stylistic neutralization (it is multi-level familiarity). Fresh context helps; a different-family grader helps more; nothing eliminates it fully.

### 3.9 Reconciliation and consensus (2026)

Self-Refine's "+20%" and Huang's "self-correction degrades" do not actually conflict once three confounds are separated:

1. **Task type.** Self-Refine's average is dominated by style/preference tasks; on the one objective benchmark both share (GSM8K) Self-Refine's own table shows ≈0 and Huang shows negative. They agree.
2. **Evaluation hygiene.** Positive self-correction papers systematically used weak initial baselines or oracle stop conditions (Kamoi; Huang).
3. **Feedback source.** Every robust positive result routes through a grounded signal: executed tests (Reflexion; Self-Debugging arXiv:2304.05128 - up to +12% with unit tests, matching baselines that sample >10× more), interpreter/tool output (CRITIC), search evidence, checklists (RefineBench, arXiv:2511.22173 *(abs)*: self-refinement scores 31.3% even for Gemini 2.5 Pro and DeepSeek-R1 *declines* −0.1%, while **targeted feedback gets >70B models to near-perfect within five turns**), or error locations (Tyen: +18-44 pts).

**Consensus:** external/grounded feedback => revision loops reliably help and are sample-efficient; intrinsic self-critique on objective reasoning => neutral-to-harmful, and *worse* the weaker the model (GV-gap scales with pretraining compute; flash-class judges below random on JudgeBench). Two 2025-26 refinements: (a) verification capacity can be *manufactured* at inference time - contrastive comparison, verification-vote, weak-verifier aggregation - rather than assumed intrinsic; (b) reasoning-class models have internalized some self-correction, so bolted-on critique loops add little there (CorrectBench arXiv:2510.16062; Self-Verification Dilemma arXiv:2602.03485 *(abs)*: the "vast majority" of self-verification steps in long traces are confirmatory, and suppressing them cuts up to 20.3% of tokens at equal accuracy) - while flash-class non-reasoning models still benefit, but only from grounded signals.

**Thread 3 net (verdict for pi-hifi):** the GVR design (fresh-context grader + execution evidence + bounded K + written critique) is the configuration the literature converges on. The weak points the evidence flags: (i) a flash-or-even-pro *holistic* correctness verdict is the least reliable element - constrain the grader to rubric/checklist verification (already done) and contrastive comparison; (ii) critique must carry **error locations and evidence** (failing test output, contradicted atom), not prose advice; (iii) same-family grader bias is real - see §5.

---

## 4. Execution-grounded selection for code

### 4.1 CodeT - Chen et al. (2022), arXiv:2207.10397

- **What:** the model generates both code candidates and test cases; dual execution agreement (consensus sets ranked by |solutions|×|tests passed|) selects the winner.
- **Evidence** *(abs)*: HumanEval pass@1 65.8% with code-davinci-002 - "+18.8% absolute over the code-davinci-002 model and more than 20% absolute over the previous SOTA"; gains consistent across five models of varying size. Code: github.com/microsoft/CodeT.
- **Cost:** ~(N + tests)× generation + N×T sandbox executions.
- **Verdict:** pi-hifi's selector is CodeT-family already (self-tests + exec evidence). Headroom is in the selection *math* (->B4) and test *quality* (->§4.6).

### 4.2 AlphaCode - Li et al. (2022), arXiv:2203.07814 / Science

- **What:** massive sampling -> filter by provided example tests (removes >99% of samples) -> **cluster survivors by behavior** on generated inputs -> submit one per largest cluster.
- **Evidence** *(abs/body)*: top 54.3% in Codeforces competitions; avg 2.4 submissions per solved problem.
- **Cost:** extreme (10⁵-10⁶ samples) - the existence proof, not the recipe.
- **Verdict:** the **clustering idea is separable and cheap**: execute all candidates on shared inputs (inputs need no asserted outputs - dodges the wrong-oracle problem), group by output equivalence, carry one representative per cluster to the pairwise judge. Cuts judge calls by the dedup factor and decorrelates finalists.

### 4.3 MBR-Exec - Shi et al. (2022), arXiv:2204.11454

- **What:** select the candidate whose execution behavior agrees with the most other candidates (majority vote over behavior; no assertions needed).
- **Evidence** *(body, 25 samples, codex-davinci-001)*: MBPP 47.3->58.2; Spider 50.8->63.6.
- **Verdict:** same family as the existing selector; subsumed.

### 4.4 B4 - Chen et al. (ASE 2024), arXiv:2409.08692

- **What:** treats both candidates *and* self-generated tests as unreliable; derives the posterior-optimal selection rule over the observed pass/fail matrix (strict generalization of CodeT's heuristic).
- **Evidence** *(abs)*: "relative performance improvement by up to 50% over the strongest heuristic and 246% over random selection in the most challenging scenarios" (i.e., few correct candidates + noisy tests - precisely the weak-generator regime); ~12% average relative over the strongest heuristic *(body)*. Code: github.com/ZJU-CTAG/B4.
- **Cost:** **zero extra LLM calls** - post-processing of the same pass matrix.
- **Verdict:** the cheapest upgrade in this survey: drop-in replacement for the selector's evidence-scoring. Highest value exactly when flash is at its worst.
- **Effort:** port/wrap the published algorithm.

### 4.5 Test-time scaling for code, 2025-26

- **CodeMonkeys - Ehrlich et al. (2025), arXiv:2501.14723** *(abs)*: SWE-bench Verified 57.4% at ≈$2,300 total (~$4.6/issue *(secondary)*); their selection stage applied to an *ensemble of others' submissions* reaches 66.2% - selection machinery generalizes beyond own candidates. Code: github.com/ScalingIntelligence/codemonkeys.
- **S\* - Li et al. (2025), arXiv:2502.14382** *(abs)*: hybrid parallel sampling + sequential debugging, then selection via **adaptively synthesized distinguishing inputs** - the model generates the input where two finalists disagree, both are executed, observed behavior decides. "Enabling a 3B model to outperform GPT-4o-mini"; "GPT-4o-mini with S* outperforms o1-preview by 3.7% on LiveCodeBench"; R1-Distill-32B reaches 85.7% (o1-high: 88.5%). Code: github.com/NovaSky-AI/SkyThought (`test-time-scaling`).
- **SEP - Cho et al. (2026), arXiv:2604.06485** *(abs)*: symbolic execution partitions candidates into bounded functional-equivalence classes; pick from the dominant class. HumanEval+ 0.754->0.826, LiveCodeBench 0.565->0.647 at N=10, "without auxiliary test generation, learned verifiers, or additional LLM inference". Key sentence: "consensus alone is not sufficient for correctness, because models can also produce correlated wrong solutions."
- **Incoherence - Valentin et al. (AAAI 2026), arXiv:2507.00057** *(abs)*: mutual behavioral disagreement of a candidate set gives a provable lower bound on error probability; "can automatically identify about two-thirds of incorrect programs without reports of false positives for the average task". Sandbox-only cost. **The cleanest abstain/escalate gate in the literature.**

### 4.6 Self-generated tests: the reliability problem (the happy-path failure mode)

- B4's premise *(abs)*: with plausible (unreliable) tests, heuristic selection breaks.
- Wrong assertions dominate generated-test failures (>85% in one 2025 benchmark - *(secondary)*, attribution UNVERIFIED); LLMs write tests mirroring the *given code's* behavior rather than the spec, so tests generated from buggy code confirm the bug (*(secondary)*, confirmation-bias cluster). This is exactly "weak model writes happy-path tests its own code passes."
- Oracle quality is steerable: full class context improves test-oracle quality by 12.9% (arXiv:2601.05542, *(secondary)*).
- **Property-based feedback - PGS, He et al. (2025), arXiv:2506.18315** *(abs)*: check high-level *properties* over generated inputs and feed back the minimal failing counterexample: pass@1 up to +13.4% vs TDD-style baselines, >64% fix rate on initially-failed problems, bug-fix rate 1.4-1.6× the strongest debugging baselines. Properties avoid predicting exact outputs - they dodge the wrong-assertion problem.
- Mirror failure for graders: LLM reviewers also *over-reject* correct code (arXiv:2603.00539, title-level, UNVERIFIED).
- **Budget Reallocation - Hassid et al. (2024), arXiv:2404.00725** *(abs)* - the boundary condition for everything above: at matched compute, "repeated use of smaller models can yield consistent improvements, with gains of up to 15% across five tasks" **when unit tests select** - but with ranking-based (LLM) selection, small-model sampling "falls short of the performance of a single output from larger ones." The entire weak-generator advantage is conditional on execution-grounded selection.

**Thread 4 net:** pi-hifi's selector architecture is right; the upgrades are math (B4), structure (cluster -> distinguish -> judge), test quality (properties, behavior-only inputs), and an incoherence-based escalation gate.

---

## 5. Multi-agent debate, judge ensembles, error correlation

### 5.1 Debate: claims and measured limits

- Anchors: Du et al. (arXiv:2305.14325; 3 agents × 2 rounds ≈ 6×+ cost, no compute-matched baseline) and Liang et al. MAD (arXiv:2305.19118; its own abstract already flags judge bias).
- **Smit et al. (ICML 2024), arXiv:2311.17371** *(abs)*: "multi-agent debating systems, in their current form, do not reliably outperform other proposed prompting strategies, such as self-consistency and ensembling using multiple reasoning paths"; MAD is hyperparameter-sensitive.
- **Zhang et al. (2025), arXiv:2502.08788** (retitled "Stop Overvaluing Multi-Agent Debate...") *(abs)*: across 5 MAD methods × 9 benchmarks × 4 models, "MAD often fail to outperform simple single-agent baselines such as Chain-of-Thought and Self-Consistency, even when consuming significantly more inference-time computation." Their fix - **Heter-MAD** (agents drawn from heterogeneous model families) - "a universal antidote" that consistently improves MAD frameworks. (Win-rate-vs-CoT under ~20%: *(secondary)*.)
- **Wynn et al. (2025), arXiv:2509.05396** *(abs)*: "debate can lead to a decrease in accuracy over time - even in settings where stronger models outnumber their weaker counterparts"; models flip correct->incorrect to agree with peers (conformity/sycophancy).
- **Kaesberg et al. (2025), arXiv:2502.19130** *(abs)*: protocol matters more than discussion - voting +13.2% on reasoning, consensus +2.8% on knowledge; **more discussion rounds before voting hurts**.
- **MAST - Cemri et al. (2025), arXiv:2503.13657** *(abs/body)*: taxonomy from 1,600+ annotated traces across 7 frameworks: failure rates of SOTA open-source multi-agent systems span 41-86.7%; **~23.5% of all failures are verification failures** (incorrect/incomplete/missing verification). Verifier quality, not agent count, is the binding constraint.
- Selective debate: iMAD (arXiv:2511.11306, *(abs)*) triggers debate only when a classifier predicts a flip - up to 92% token reduction and up to +13.5% accuracy vs always-debate (needs a light trained classifier).
- Huang et al. *(body)*, independently: SC with 6 samples (85.3%) beats 6-agent debate (83.2%) - debate as a costlier consistency estimator.

**Verdict: do not add debate to pi-hifi.** The pipeline already has diversity (parallel candidates) and error-checking (GVR + external audit) in stronger, grounded forms. If anything debate-shaped is ever tried, it must be selective (uncertainty-triggered) and heterogeneous (different model family) - the only configurations with positive evidence.

### 5.2 Judge ensembles - PoLL, Verga et al. (2024), arXiv:2404.18796

- **What:** replace one large judge with a panel of small judges from **disjoint model families**, aggregated by voting.
- **Evidence** *(abs/body)*: panel (Command R + Claude-3-Haiku + GPT-3.5) vs GPT-4 judge - Cohen's κ with humans 0.763 vs 0.627 (NQ), 0.906 vs 0.841 (TriviaQA); "over seven times less expensive". Successor tooling: Verdict library (arXiv:2502.18018).
- **Cost:** 3 cheap calls ≈ 1/7-1/8 the cost of one frontier-judge call.
- **Verdict:** composable at two points: the selector's pairwise judge and the GVR grader's accept/reject vote. See §5.3 for *why* family diversity is the point.
- **Effort:** orchestration + 1-2 extra API providers.

### 5.3 Error correlation - the same-family-grader risk, quantified

- **CAPA - Goel et al. (2025), arXiv:2502.04313** *(abs)*: "LLM-as-a-judge scores favor models similar to the judge" *after controlling for accuracy* (partial r = 0.35-0.65 across 351 judge-model pairs, *(body)*); weak-to-strong training gains shrink as teacher-student similarity rises; and across 130 models, "model mistakes are becoming more similar with increasing capabilities, pointing to risks from correlated failures."
- Combined with the perplexity-familiarity mechanism (§3.6, Wataoka) the implication is direct: **pro grading flash is not an independent grader** - they share lineage, data, and tokenizer; expect inflated pass rates precisely on family-typical confident errors.
- **Multi-Agent Verification / BoN-MAV (2025), arXiv:2502.20379** *(abs, qualitative)*: best-of-N scored by multiple prompt-only "aspect verifiers" shows stronger scaling than self-consistency or reward models, with weak-to-strong generalization (combining weak verifiers improves stronger generators). Numbers not in abstract (UNVERIFIED).
- **Verdict:** the cheapest meaningful decorrelation for pi-hifi: add one or two cheap non-DeepSeek voters (per PoLL) at the grader's accept/reject decision and/or the pairwise judging stage, and keep the retrieval-grounded external verifier (which shares no model prior) as the final arbiter. The fully-grounded signals already in the pipeline (execution evidence) are immune to this failure class - another reason to maximize their share of the decision.

**Thread 5 net:** skip debate; keep the diversity and the checking, drop the conversation. Adopt the jury pattern for grading decisions and decorrelate the grader family - same-family graders are measurably not independent.

---

## 6. Weak generator + strong verifier; weak-to-strong at inference

- **The boundary condition (repeat of §4.6 because it is the thread's core):** Budget Reallocation (arXiv:2404.00725) *(abs)* - weak×N beats strong×1 at matched compute *with unit-test selection* (up to +15%); inverts with LLM-ranking selection. Large Language Monkeys (§1.2) supplies the coverage law; Smaller-Weaker-Yet-Better (arXiv:2408.16737, *(abs/body)*) the compute-matched diversity argument (Gemma2-9B vs 27B: +11% coverage, +86% diversity, **+7% false positives** - the quantified warning) - nominally about training data, but the sampling insight transfers: at fixed cost, flash-many explores more solution space than pro-few, *iff* selection absorbs the extra false positives.
- **Weak-to-strong generalization (Burns et al. 2023, arXiv:2312.09390)** is training-time - anchor only. Inference-time analogues exist but do not fit: Weak-to-Strong Search (arXiv:2405.19262) needs logprobs of a tuned/untuned small-model pair and targets alignment/preference quality, not correctness; Weak-to-Strong Decoding (arXiv:2506.07434) needs prefill control; logits fusion (arXiv:2406.15480) needs per-step logits of both models. All low-applicability for correctness-centric API pipelines.
- **PRMs as downloadable verifiers** (Math-Shepherd arXiv:2312.08935; PRM-transfer study arXiv:2506.00027 *(abs)*: math-trained PRMs ≈ code-tailored PRMs - cross-domain transfer better than expected, contradicting the common assumption, though absolute usefulness vs execution signals on realistic code is not quantified in the abstract): require GPU hosting and mostly help math-style step traces. Weak fit; execution evidence dominates for code.
- **GenRM (arXiv:2408.15240)** *(abs)*: trained generative verifier - CoT verification + majority vote over verification chains lifts best-of-N from 73%->93.4% (GSM8K) for its models. Training-bound, but both design ideas port to a *prompted* pro verifier: verify with CoT; sample multiple verifications and vote.
- **Weaver (arXiv:2506.18203)** (§3.7): weak verifiers aggregate into a strong signal without fine-tuning the generator. Same recipe, programmatic flavor: "Aggregating LLM-Based Weak Verifiers" (arXiv:2606.05268 *(abs)*) - an LLM synthesizes many cheap verifier *programs*, aggregated weak-supervision-style from ~10 labeled examples, F1 up to 7× over direct LLM judges (spatial-layout domain; the recipe transfers to rubric-style checks).
- **Thread 6 net (verdict for the flash/pro pair):** the literature's optimum is exactly the pipeline's shape - flash generates wide, grounded signals select, pro verifies narrow. Concrete additions: pro as **scaled contrastive verifier on finalists only** (verification-vote, comparison framing); pro as **test curator** (reviewing flash-written tests against the spec raises the quality of the pass matrix every other mechanism consumes); never pro as a single-pass holistic judge of one candidate (JudgeBench: even GPT-4o-class judges hover at random on hard pairs).

---

## 7. Cascades, routing, uncertainty estimation

### 7.1 Routers and cascades

- **FrugalGPT - Chen et al. (2023), arXiv:2305.05176** *(abs)*: cascade + learned answer-scorer; "match the performance of the best individual LLM (e.g. GPT-4) with up to 98% cost reduction or improve the accuracy over GPT-4 by 4% with the same cost." **Flag:** the scorer is a small *trained* model, per-task labeled data; the 98% is the best case on short-output classification-like tasks. Not transferable training-free.
- **RouteLLM - Ong et al. (2024), arXiv:2406.18665** *(body)*: preference-data-trained binary router; at 95% of GPT-4 quality on MT-Bench, **3.66× cost reduction** (MMLU 1.41×, GSM8K 1.49×); routers transfer across model pairs. **Discrepancy flag:** the widely-quoted ">85% cost reduction" is from early publicity, absent from the current paper. Code: github.com/lm-sys/RouteLLM. Needs training data - borderline fit.
- **Training-free cascades (the fit):**
  - **MoT cascades - Yue et al. (ICLR 2024), arXiv:2310.03094** *(abs)*: weak model answers in two representations (CoT + program-of-thought); answer consistency across samples/representations is the deferral signal. "Performance comparable to using solely the stronger LLM but require only 40% of its cost" (GPT-3.5->GPT-4, six reasoning benchmarks).
  - **AutoMix - Aggarwal et al. (NeurIPS 2024), arXiv:2310.12963** *(abs)*: few-shot self-verification as a noisy observation inside a POMDP router; >50% cost reduction at comparable performance. (Self-verification is noisy - that is *why* they wrap it in a POMDP.)
  - **ICD - Sarukkai et al. (2025), arXiv:2512.02543** *(abs)*: agent setting; teacher demos retrieved in-context by the cheap student; "when multiple student samples agree, we proceed; when they diverge, we fall back to the teacher" - ALFWorld: teacher accuracy at 2.5× lower cost; AppWorld: 3.5× cheaper at 79% of teacher accuracy.
  - Semantic deferral for open-ended outputs (Soiffer et al., ICML 2025 workshop): semantic agreement among weak-model samples beats token-level confidence as the deferral signal (numbers UNVERIFIED).
- **Operating points across verified systems:** roughly 60-75% of queries stay on the weak model at 92-100% of strong-model quality; full parity typically still saves 40-60% of cost.

### 7.2 Uncertainty estimation that works for black-box APIs

- **Semantic entropy - Kuhn et al. (ICLR 2023), arXiv:2302.09664; Farquhar et al., Nature 630:625 (2024)**: sample N≈5-10 generations, cluster by bidirectional entailment, entropy over meaning-classes detects confabulations. Average AUROC 0.790 across 30 task×model combos *(body via subagent; Nature page paywalled - method superiority and the no-logprob discrete variant confirmed via the authors' OATML post)*. The **discrete variant needs no logprobs**. Code: github.com/jlko/semantic_uncertainty.
- **SelfCheckGPT (arXiv:2303.08896)**: the same consistency idea at sentence level for long-form text; zero-resource, black-box.
- **Verbalized confidence - Xiong et al. (ICLR 2024), arXiv:2306.13063** *(abs)*: "LLMs, when verbalizing their confidence, tend to be overconfident" - usable only as one feature among several, never as the gate.
- **P(True) - Kadavath et al. (2022), arXiv:2207.05221**: self-evaluation of one's own answer; improves when the model sees several of its own samples first; needs logprobs (DeepSeek exposes them - verified against api-docs.deepseek.com, June 2026); found inferior to semantic entropy for confabulation detection (Nature 2024 comparison).
- **Consistency-based calibration (§2.7)** beats both logit-based and verbalized post-hoc methods.
- Surveys: arXiv:2503.15850; ACL 2025 Findings survey; arXiv:2412.05563. Consistent ranking: sampling-consistency > logit-based > verbalized.

**Thread 7 net:** the flash->pro consistency-deferral cascade is the best-supported cost mechanism available to pi-hifi, and the signal (candidate agreement) is already being produced. For free-form buckets, discrete semantic entropy (NLI-clustering by a cheap call) is the matching signal. Verified expectation: pro-parity output at ~40-60% of an all-pro pipeline.

---

## 8. Prompt-level scaffolds with measured gains

### 8.1 The anchors (gains real, but measured on 2022-23 base models)

| Scaffold | Mechanism (1 line) | Verified gain | Cost | Source |
|---|---|---|---|---|
| Plan-and-Solve+ | plan subtasks, then execute plan | GSM8K 59.3 vs 56.4 zero-shot-CoT; avg over six math sets 76.7 vs 70.4 *(body)* | ~1× | arXiv:2305.04091 |
| Least-to-Most | decompose into ordered subproblems, solve sequentially | SCAN 16% -> >=99% (code-davinci-002) *(abs)* | >=2× | arXiv:2205.10625 |
| Program-of-Thoughts | reason as executable Python; interpreter computes | ~+12% avg over CoT on math/financial QA *(abs)* | ~1× + sandbox | arXiv:2211.12588 |
| PAL | same family as PoT | GSM8K +15% absolute over PaLM-540B CoT *(abs)* | ~1× + sandbox | arXiv:2211.10435 |
| Self-planning (code) | plan steps from intent, then code step-by-step | up to +25.4% relative pass@1 vs direct; +11.9% vs CoT *(abs)* | ~2× | arXiv:2303.06689 |
| PlanSearch | search over diverse NL plans before coding | LiveCodeBench pass@200 77.0 vs 60.6 (Claude 3.5 Sonnet) *(abs)* | hundreds of samples | arXiv:2409.03733 |
| Agentless | fixed localize->repair->validate pipeline, no agent loop | SWE-bench Lite 32.0% at $0.70/issue; later 40.7% Lite / 50.8% Verified with Claude 3.5 *(abs + README)* | multi-call but cost-optimized | arXiv:2407.01489 |

### 8.2 The counter-evidence (scope limits)

- **To CoT or not to CoT - Sprague et al. (ICLR 2025), arXiv:2409.12183** *(abs)*: meta-analysis of 100+ papers + 20 datasets × 14 models: "CoT gives strong performance benefits primarily on tasks involving math or logic, with much smaller gains on other types of tasks"; on MMLU, no-CoT ≈ CoT "unless the question or model's response contains an equals sign". Where computation is the bottleneck, a symbolic solver beats CoT.
- **Decreasing value of CoT on reasoning models** (Prompting Science Report 2, arXiv:2506.07142, *(secondary)*): o3-mini +2.9%, o4-mini +3.1% on GPQA at +20-80% latency.
- **DeepSeek-R1's own guidance** (arXiv:2501.12948 *(body)*): "Few-shot prompting consistently degrades its performance" - zero-shot direct description recommended for long-CoT models.
- **CoT brittleness** (arXiv:2508.01191 *(abs)*): "CoT reasoning is a brittle mirage when it is pushed beyond training distributions."
- **Structured output:** "Let Me Speak Freely?" (arXiv:2408.02442 *(abs)*: "significant decline in LLMs reasoning abilities under format restrictions") vs the dottxt rebuttal (matched prompts, constrained decoding actually won on all three re-run tasks). Practical consensus: **reason in free text first, format/extract after**; constrained decoding per se is safe.

**Thread 8 net:** flash is a weak non-reasoning-mode-by-default model - exactly the population where the anchors still pay, *within scope* (math/symbolic/code). Concretely: plan-then-implement for code-mode generation (~2 calls, +11.9-25.4% relative in its measured regime); PoT-style "compute, don't recite" for any numeric claim (composes with the existing sandbox); skip elaborate scaffolds in design/incident prose; if flash runs with `thinking: high`, drop few-shot exemplars (R1 finding, family-plausible - UNVERIFIED for v4-flash specifically). Agentless validates the meta-design: fixed decomposed pipelines beat free-form agency per dollar - pi-hifi is already on this side.

---

## 9. RAG, tool-grounding, and claim verification (the unknown-unknowns)

### 9.1 The problem, measured

- **Package hallucination - Spracklen et al. (USENIX Security 2025), arXiv:2406.10279** *(abs)*: "the average percentage of hallucinated packages is at least 5.2% for commercial models and 21.7% for open-source models, including a staggering 205,474 unique examples of hallucinated package names" (16 LLMs, 576k samples, Python+JS). RAG mitigation cuts DeepSeek-Coder-6.7B from 16.14%->12.24% *(secondary)* - helpful, not sufficient; a deterministic registry check remains necessary.
- **CloudAPIBench - Jain et al. (2024), arXiv:2407.09726** *(abs)*: GPT-4o produces valid *low-frequency* API invocations only 38.58% of the time (and does not abstain); documentation-augmented generation raises it to 47.94%; **but always-on retrieval with suboptimal retrievers costs −39.02pp absolute on high-frequency APIs**; selective triggering restores the balance (+8.20% overall). The single most decision-relevant result for docs-RAG design.
- **SelfAware (arXiv:2305.18153)** and **Sufficient Context (ICLR 2025, arXiv:2411.06037** *(abs)*: large models answer instead of abstaining when context is insufficient; *small* models "hallucinate or abstain often, even with sufficient context") - for a weak generator, retrieval alone does not guarantee grounded use.
- Hallucination taxonomy (arXiv:2510.24476 *(abs)*): knowledge-based vs logic-based; RAG addresses the former, reasoning/verification the latter. Clean datapoint: Search-o1 (arXiv:2501.05366 *(body)*) gains on GPQA (63.6 vs 58.1) but **zero on LiveCodeBench** - retrieval does not fix code reasoning.

### 9.2 Mitigations with numbers

- **DocPrompting - Zhou et al. (ICLR 2023), arXiv:2207.05987** *(abs)*: retrieving docs improves weak models most - CodeT5 +2.85pp pass@1 (52% relative) on CoNaLa; up to +6.9pp exact-match on tldr (CodeT5/GPT-Neo ~0.2-2.7B). Strongest evidence that docs retrieval helps precisely the weak-model class.
- **When LLMs Meet API Documentation (2025), arXiv:2503.15231** *(abs)*: "RAG helps improve LLMs' performance by 83%-220%" on less-common libraries; "example code contributes the most", not descriptions/parameter lists. Retrieve usage examples, not just signatures.
- **De-Hallucinator - Eghbali & Pradel (2024), arXiv:2401.01701** *(abs)*: draft -> mine its (possibly fake) API references -> retrieve real similar signatures from the project index -> re-prompt: completion edit-distance +23.3-50.6%, API-usage recall +23.9-61.0%. The pattern composes with pi-hifi's GVR loop (a "symbol audit" between rounds).
- **CodeRAG-Bench (arXiv:2406.14497)** *(abs)*: retrieval gains are real but bottlenecked by retriever quality and by weak generators' limited ability to integrate context - keep injected contexts short and example-centric.
- **FreshLLMs/FreshPrompt (arXiv:2310.03214)** *(body)*: injecting ~15 search-engine evidences lifts GPT-4 by +47pp absolute (STRICT) on fast-changing facts. Cheap: 1 search call + a bigger prompt.
- Context7-style MCP docs servers: industry practice, the productionized DocPrompting; no benchmark paper.

### 9.3 Claim-level verification (validates and refines the external verifier)

- **FActScore - Min et al. (EMNLP 2023), arXiv:2305.14251** *(abs)*: atomic-claim decomposition + retrieval verification; ChatGPT bios score only 58%; the automated estimator tracks human FActScore within <2%.
- **SAFE - Wei et al. (NeurIPS 2024), arXiv:2403.18802** *(abs, all three numbers verified)*: LLM agent + Google Search per atomic claim: "agrees with crowdsourced human annotators 72% of the time, and on a random subset of 100 disagreement cases, SAFE wins 76% of the time", ">20 times cheaper than human annotators." Code: github.com/google-deepmind/long-form-factuality.
- **VERIFY/FactBench (ACL 2025, arXiv:2410.22257)** *(secondary)*: adds the third label - supported / unsupported / **undecidable** - and weights claim verifiability. Importable refinement: pi-hifi's verifier should distinguish "contradicted" from "unverifiable" (the assembler already flags "Unverified:" - keep that tri-state).
- **ClaimCheck (2025), arXiv:2510.01226** *(secondary)*: a 4B model in a structured pipeline hits 76.4% on AVeriTeC, beating prior GPT-4o pipelines - claim verification does not need a frontier judge if the pipeline is structured. Direct validation of running the atom auditor on flash/worker.
- **"Argus-style evidence assembly"** resolves to **Argus - Zhang et al. (2026), arXiv:2605.16217** *(abs)*: deep-research agent assembling complementary evidence into a navigator-maintained evidence graph (Searcher+Navigator); +5.5 points single-searcher, +12.7 averaged over 8 benchmarks with 8 parallel searchers; 86.2 on BrowseComp with 64. It is a research-agent architecture, not a post-hoc claim checker; relevant only if pi-hifi's verifier grows its own web-search loop. No other 2024-26 "Argus" claim-verification paper exists (searched; not found).
- Adaptive retrieval without training: FLARE (arXiv:2305.06983, logprob-triggered), AdaRAGUE (ACL 2025, arXiv:2501.12835 *(secondary)*: plain uncertainty estimators match complex adaptive-RAG), TARG (arXiv:2511.09803 *(secondary)*: gate from a short no-context draft's entropy). Self-RAG (arXiv:2310.11511) and CRAG (arXiv:2401.15884) need training - pattern-only relevance.

**Thread 9 net:** post-hoc claim audit (present) and pre-generation grounding (absent) are complementary, not redundant: the audit catches false claims; docs-RAG and registry gates *prevent* the API-hallucination class, which is cheaper than catch-and-revise. The planned v2 "web-verifying verifier" (Brave key already available) is exactly SAFE's shape; import its decontextualization step and VERIFY's tri-state label.

---

## 10. Contradictions in the literature and current consensus

1. **Self-correction optimism (Self-Refine, +20%) vs skepticism (Huang et al., degradation).** Reconciled - not a real conflict (§3.9): gains live in style/preference tasks or leak oracle signals; on objective reasoning, intrinsic self-critique is ≈0 to negative, and *more* negative for weaker models. **Consensus:** revision helps iff feedback is external/grounded (tests, tools, retrieval, checklists, error locations); the field has moved from "can models self-correct?" to "how do we manufacture verification signal at inference time?"
2. **Test-time-scaling optimism (coverage log-linear; 1B>405B with PRMs) vs the resampling ceiling (optimal N<10).** Both true: coverage numbers assume oracle or high-quality verification; with imperfect verifiers, false positives bend the curve down. **Consensus:** returns to N are bounded by selector/verifier precision, not generation; spend marginal compute on verification quality and adaptive allocation before raising N.
3. **Debate gains (2023) vs null results (2024-26).** Systematic re-evaluations (Smit; Zhang; Wynn; Kaesberg) find homogeneous-model debate <= self-consistency at matched compute, with conformity actively destroying correct answers. **Consensus:** debate's residual value = answer diversity + aggregation (voting captures it) + model heterogeneity; the argumentative exchange itself adds nothing reliable.
4. **Self-generated tests help (CodeT +18.8pp) vs are unreliable (wrong-assertion rates, confirmation bias).** **Consensus:** never treat self-tests as oracles; use them as noisy evidence inside aggregation (B4), prefer behavior-only inputs (clustering, distinguishing inputs) and properties over asserted outputs.
5. **Structured output harms reasoning vs doesn't.** Methodological artifact; **consensus:** reason free-form, then format; constrained decoding with matched prompts is safe.
6. **Scaffold gains: large on 2022 base models, near-zero on reasoning models** (and few-shot actively harmful for R1-class). **Consensus:** scaffold value is inversely proportional to native CoT ability and scoped to math/symbolic/code - still positive for flash-class non-reasoning operation.
7. **Math-PRM->code transfer:** one 2025 study says math PRMs ≈ code-tailored PRMs (arXiv:2506.00027); the CodePRM line argues code needs execution-aware PRMs. Unresolved; moot for an API-only pipeline (execution evidence dominates anyway).
8. **Marketing vs paper numbers:** RouteLLM "85% cost reduction" (blog) vs 3.66× (paper); FrugalGPT "98%" is best-case with a per-task trained scorer. Use the paper numbers.

---

## 11. Concretely adoptable in pi-hifi v2, ranked by expected value per dollar

Pricing anchor: flash $0.14/$0.28, pro $0.435/$0.87 per 1M tokens (3.1×). "Free" = no new LLM calls.

1. **Agreement-gated budgets and escalation** (selector -> everything downstream). Compute behavioral agreement over the existing N candidates. Code mode: exec-output equivalence - this is exactly the incoherence signal measured for code (arXiv:2507.00057: ~2/3 of incorrect programs caught at ~zero false positives, sandbox-only cost). Design/incident (no execution): semantic agreement among candidates - consistency-derived confidence beats logit- and verbalized-confidence baselines (arXiv:2402.13904), and the discrete semantic-entropy variant needs no logprobs (Nature 2024); note this free-form variant is supported by the consistency-calibration literature, not by the incoherence paper, which is code-only. Then: high agreement -> K=1, skip deep verification; low -> full K, escalate generator or grader to pro; pathological disagreement -> flag for the user. Cascade economics: §7.1. Expected effect: 2-3× cost cut at equal quality, or quality gain at equal cost. Effort: orchestration in `pipeline.ts`/`selector.ts`; no new dependencies.
2. **Incremental candidate generation with early stopping** (selector). Generate 2 candidates; if they behaviorally agree, stop; else continue to N. 3-8× selector-cost reduction at <0.5pp loss (ESC/Adaptive-Consistency). Effort: small loop change + Beta-test stopping rule (reference implementation public).
3. **B4 scoring in the selector** (replaces/augments pass-count + pairwise-tournament evidence weighting). Posterior over the (candidate × self-test) pass matrix; documented +12% avg, up to +50% relative in the noisy-test/weak-generator regime; zero extra LLM calls. Effort: port published algorithm (github.com/ZJU-CTAG/B4) into `selector.ts`.
4. **Cluster -> distinguish -> judge** (selector). Execute candidates on shared flash-generated *inputs* (no asserted outputs), cluster by output equality, run the pairwise judge only across cluster representatives; on close ties, S*-style: ask flash for an input where the two finalists disagree, execute, decide on observed behavior. Cuts judge calls by the dedup factor; measured mechanism behind "3B beats GPT-4o-mini". Effort: moderate orchestration in `selector.ts` + `exec.ts`.
5. **Property-based self-tests + verbatim evidence in critiques** (GVR). Shift flash's test generation toward properties/invariants with generated inputs (counters happy-path assertion bias; PGS +13.4% pass@1, 1.4-1.6× fix rate); pipe failing-test output and contradicted atoms verbatim into the revision prompt as *error locations* (Tyen: correction works once location is known; JETTS: prose critiques don't steer). Effort: prompt changes in `prompts.ts`; no new calls.
6. **Deterministic symbol gates** (new micro-stage before/inside GVR). Registry existence check for every imported package (npm/PyPI API or local cache) and project-index check for API names; on miss -> De-Hallucinator-style re-prompt with the real nearest signatures. Targets the 5.2-21.7% package-hallucination class deterministically. Effort: small `exec.ts`-adjacent utility; no LLM cost.
7. **USC selection for non-executable buckets** (selector, design/incident/general modes). One long-context flash call over all candidates picks the most consistent answer (arXiv:2311.17311 - matches execution-based voting on code *without* executing; abstract-level qualitative evidence only). Cheaper complement to the pairwise tournament: USC at small N or as tie-breaker, the tournament when budget allows. Effort: prompt-only.
8. **Cross-family second vote at decision points** (grader accept/reject; optionally pairwise judge). One or two cheap non-DeepSeek judges (PoLL pattern) voting alongside the DeepSeek grader; order-swapped pairs, inconsistency = no-verdict (already in the v1 deferred list as position-bias control). Counters the quantified same-family bias (CAPA r=0.35-0.65; perplexity-familiarity). Effort: `roles.ts` already provider-agnostic; +1 API provider; ~+10-20% of grading cost (cheap models).
9. **Pro as test curator** (selector/GVR). Before the pass matrix feeds B4/clustering, one pro call reviews flash-written self-tests against the task spec - drop or fix wrong assertions, add missing edge cases. Rationale: test wrongness is the dominant noise source in the matrix (§4.6) and oracle quality is steerable by context (+12.9%, *(secondary)*); recommended in §6 because it compounds with items 3-5. Effort: prompt + orchestration; ~1 pro call per task.
10. **Selective docs-RAG before generation** (generator context). Trigger only on unknown/rare symbols (index miss or low agreement), inject short example-centric snippets (Context7-style MCP server or local docs index). +83-220% in the rare-library regime; always-on injection is measurably harmful. Effort: needs a docs source; medium.
11. **Web evidence for the external verifier** (already-planned v2 item; the literature ranks it high). SAFE-shaped: decontextualize each atom (self-contained claim), search (Brave key available), audit per-atom, tri-state verdict (supported/contradicted/undecidable per VERIFY). A flash-class auditor is sufficient when the pipeline is structured (ClaimCheck: 4B hits 76.4% AVeriTeC). FreshPrompt-style pre-generation search injection for fast-changing topics in incident/design modes. Effort: medium (search tool + prompts); ~1 search + 1-2 flash calls per atom.
12. **Pro as scaled contrastive verifier on finalists** (GVR/verifier). For the 1-3 surviving candidates on low-agreement tasks: k=3-5 pro verification samples each, framed as cross-candidate comparison, majority-voted (GenRM-prompted + SSS implicit-scaling evidence; CodeMonkeys' selection stage lifted an external ensemble 57.4 -> 66.2, both figures *(abs)*, an 8.8pp delta). Effort: prompts + orchestration; ~3-10 pro calls only on the hard tail.
13. **Plan-then-implement prompt for code mode** (generator). Two-phase generation (plan -> code) inside one call or two; +11.9-25.4% relative in its measured regime; drop few-shot exemplars when `thinking: high` is on. Effort: prompt-only.
14. **Negative list (do not build):** multi-agent debate stage; intrinsic self-refine rounds without new evidence; always-on retrieval; PRM/trained-router components (training or hosting violates constraints); raising N beyond 8.

Items 1-6 are the high-certainty core: each is backed by >=2 independent verified results, costs little or saves money, and slots into an existing module. Items 7 and 9 rest on single-paper or derived-pattern evidence; item 8 is multi-paper-evidenced but needs a second API provider; items 10-13 carry moderate effort or scope-limited gains.

---

## 12. Bibliography

Test-time scaling: [1] Snell, Lee, Xu, Kumar. "Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters." 2024. arXiv:2408.03314. [2] Brown, Juravsky, Ehrlich, Clark, Le, Ré, Mirhoseini. "Large Language Monkeys: Scaling Inference Compute with Repeated Sampling." 2024. arXiv:2407.21787. [3] Wu, Sun, Li, Welleck, Yang. "Inference Scaling Laws: An Empirical Analysis of Compute-Optimal Inference..." 2024. arXiv:2408.00724. [4] Stroebl, Kapoor, Narayanan. "The Limits of Inference Scaling Through Resampling" (v1: "Inference Scaling fLaws"). 2024. arXiv:2411.17501. [5] Zhao, Awasthi, Gollapudi. "Sample, Scrutinize and Scale: Effective Inference-Time Search by Scaling Verification." 2025. arXiv:2502.01839. [6] Muennighoff et al. "s1: Simple test-time scaling." 2025. arXiv:2501.19393 (SFT - out of scope). [7] Liu et al. "Can 1B LLM Surpass 405B LLM? Rethinking Compute-Optimal Test-Time Scaling." 2025. arXiv:2502.06703. [8] Zhang et al. "A Survey on Test-Time Scaling in Large Language Models." 2025. arXiv:2503.24235. [9] Fu et al. "Efficiently Scaling LLM Reasoning with Certaindex." 2024/25. arXiv:2412.20993.

Self-consistency: [10] Wang et al. "Self-Consistency Improves Chain of Thought Reasoning in Language Models." 2022. arXiv:2203.11171. [11] Chen et al. "Universal Self-Consistency for Large Language Model Generation." 2023. arXiv:2311.17311. [12] Aggarwal, Madaan, Yang, Mausam. "Let's Sample Step by Step: Adaptive-Consistency..." 2023. arXiv:2305.11860. [13] Li et al. "Escape Sky-high Cost: Early-stopping Self-Consistency..." 2024. arXiv:2401.10480. [14] Wang et al. "Make Every Penny Count: Difficulty-Adaptive Self-Consistency... (DSC)." 2024. arXiv:2408.13457. [15] Wang, Prasad, Stengel-Eskin, Bansal. "Soft Self-Consistency Improves Language Model Agents." 2024. arXiv:2402.13212. [16] Lyu et al. "Calibrating Large Language Models with Sample Consistency." 2024. arXiv:2402.13904. [17] Chen et al. "Do We Truly Need So Many Samples? Multi-LLM Repeated Sampling... (ModelSwitch)." 2025. arXiv:2504.00762. [18] Aghazadeh et al. "CGES: Confidence-Guided Early Stopping..." 2025. arXiv:2511.02603. 2026 leads (titles only, unverified): arXiv:2601.02970, 2602.05395, 2603.08999, 2605.05873, 2603.20975.

Critique/revise + judging: [19] Madaan et al. "Self-Refine: Iterative Refinement with Self-Feedback." NeurIPS 2023. arXiv:2303.17651. [20] Shinn et al. "Reflexion: Language Agents with Verbal Reinforcement Learning." NeurIPS 2023. arXiv:2303.11366. [21] Dhuliawala et al. "Chain-of-Verification Reduces Hallucination in Large Language Models." 2023. arXiv:2309.11495. [22] Gou et al. "CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing." ICLR 2024. arXiv:2305.11738. [23] Huang et al. "Large Language Models Cannot Self-Correct Reasoning Yet." ICLR 2024. arXiv:2310.01798. [24] Kamoi et al. "When Can LLMs Actually Correct Their Own Mistakes? A Critical Survey." TACL 2024. arXiv:2406.01297. [25] Tyen et al. "LLMs cannot find reasoning errors, but can correct them given the error location." ACL Findings 2024. arXiv:2311.08516. [26] Chen et al. "Teaching Large Language Models to Self-Debug." ICLR 2024. arXiv:2304.05128. [27] Olausson et al. "Is Self-Repair a Silver Bullet for Code Generation?" ICLR 2024. arXiv:2306.09896. [28] Zheng et al. "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena." NeurIPS 2023. arXiv:2306.05685. [29] Panickssery, Bowman, Feng. "LLM Evaluators Recognize and Favor Their Own Generations." NeurIPS 2024. arXiv:2404.13076. [30] Wataoka, Takahashi, Ri. "Self-Preference Bias in LLM-as-a-Judge." 2024. arXiv:2410.21819. [31] Tan et al. "JudgeBench: A Benchmark for Evaluating LLM-based Judges." ICLR 2025. arXiv:2410.12784. [32] Zhou et al. "Evaluating Judges as Evaluators: The JETTS Benchmark..." ICML 2025. arXiv:2504.15253. [33] Chen et al. "Do LLM Evaluators Prefer Themselves for a Reason?" 2025. arXiv:2504.03846. [34] Song et al. "Mind the Gap: Examining the Self-Improvement Capabilities of LLMs." 2024. arXiv:2412.02674. [35] Saad-Falcon et al. "Weaver: Shrinking the Generation-Verification Gap with Weak Verifiers." 2025. arXiv:2506.18203. [36] Zhou et al. "Variation in Verification..." 2025. arXiv:2509.17995. [37] Zhang et al. "Small Language Models Need Strong Verifiers to Self-Correct Reasoning." ACL Findings 2024. arXiv:2404.17140. [38] Lin et al. "CriticBench: Benchmarking LLMs for Critique-Correct Reasoning." ACL Findings 2024. arXiv:2402.14809. [39] Kim, Khashabi. "Challenging the Evaluator: LLM Sycophancy Under User Rebuttal." EMNLP Findings 2025. arXiv:2509.16533. [40] Fanous et al. "SycEval: Evaluating LLM Sycophancy." AIES 2025. arXiv:2502.08177. [41] Mahbub, Feng. (authorship obfuscation vs self-preference). 2025. arXiv:2512.05379. [42] Lee et al. "RefineBench: Evaluating Refinement Capability... via Checklists." 2025. arXiv:2511.22173. [43] Tie et al. "CorrectBench..." 2025. arXiv:2510.16062. [44] Long et al. "Self-Verification Dilemma..." 2026. arXiv:2602.03485. [45] Wei, J. "Asymmetry of verification and verifier's law." Blog, jasonwei.net, 2025-07-15.

Code selection: [46] Chen et al. "CodeT: Code Generation with Generated Tests." 2022. arXiv:2207.10397. [47] Li et al. "Competition-Level Code Generation with AlphaCode." Science 2022. arXiv:2203.07814. [48] Shi et al. "Natural Language to Code Translation with Execution (MBR-Exec)." 2022. arXiv:2204.11454. [49] Chen et al. "B4: Towards Optimal Assessment of Plausible Code Solutions with Plausible Tests." ASE 2024. arXiv:2409.08692. [50] Ehrlich et al. "CodeMonkeys: Scaling Test-Time Compute for Software Engineering." 2025. arXiv:2501.14723. [51] Li et al. "S*: Test Time Scaling for Code Generation." 2025. arXiv:2502.14382. [52] Cho, Wang, Sui, Grama. "Inference-Time Code Selection via Symbolic Equivalence Partitioning." 2026. arXiv:2604.06485. [53] Valentin, Madadi, Sapia, Böhme. "Incoherence as Oracle-less Measure of Error in LLM-Based Code Generation." AAAI 2026. arXiv:2507.00057. [54] He et al. "Effective LLM Code Refinement via Property-Oriented and Structurally Minimal Feedback (PGS)." 2025. arXiv:2506.18315. [55] Lahiri et al. "Interactive Code Generation via Test-Driven User-Intent Formalization (TiCoder)." 2022. arXiv:2208.05950. [56] Jain et al. (test-oracle context study). 2026. arXiv:2601.05542 *(secondary)*. [57] Kim et al. "Parallel Test-Time Scaling with Multi-Sequence Verifiers (MSV)." 2026. arXiv:2603.03417. [58] Hassid et al. "The Larger the Better? Improved LLM Code-Generation via Budget Reallocation." 2024. arXiv:2404.00725.

Weak/strong, verifiers: [59] Burns et al. "Weak-to-Strong Generalization..." 2023. arXiv:2312.09390. [60] Zhou et al. "Weak-to-Strong Search..." NeurIPS 2024. arXiv:2405.19262. [61] "Well Begun is Half Done: Weak-to-Strong Decoding." 2025. arXiv:2506.07434; related: "On Giant's Shoulders" (dynamic logits fusion). 2024. arXiv:2406.15480 *(secondary)*. [62] Wang et al. "Math-Shepherd..." 2023. arXiv:2312.08935. [63] Chen et al. (math-PRM->code transfer). 2025. arXiv:2506.00027. [64] Zhang et al. "Generative Verifiers: Reward Modeling as Next-Token Prediction (GenRM)." ICLR 2025. arXiv:2408.15240. [65] Bansal et al. "Smaller, Weaker, Yet Better..." 2024. arXiv:2408.16737. [66] Zhang, Jones, Wu, Agrawala. "Aggregating LLM-Based Weak Verifiers." 2026. arXiv:2606.05268.

Debate/ensembles/correlation: [67] Du et al. "Improving Factuality and Reasoning... through Multiagent Debate." 2023. arXiv:2305.14325. [68] Liang et al. "Encouraging Divergent Thinking... (MAD)." 2023. arXiv:2305.19118. [69] Smit et al. "Should we be going MAD?..." ICML 2024. arXiv:2311.17371. [70] Zhang et al. "Stop Overvaluing Multi-Agent Debate..." 2025. arXiv:2502.08788. [71] Cemri et al. "Why Do Multi-Agent LLM Systems Fail? (MAST)." 2025. arXiv:2503.13657. [72] Wynn, Satija, Hadfield. "Talk Isn't Always Cheap..." 2025. arXiv:2509.05396. [73] Kaesberg et al. "Voting or Consensus? Decision-Making in Multi-Agent Debate." 2025. arXiv:2502.19130. [74] Fan, Yoon, Ji. "iMAD: Intelligent Multi-Agent Debate." 2025. arXiv:2511.11306. [75] Verga et al. "Replacing Judges with Juries (PoLL)." 2024. arXiv:2404.18796. [76] Goel et al. "Great Models Think Alike and this Undermines AI Oversight (CAPA)." ICML 2025. arXiv:2502.04313. [77] Lifshitz, McIlraith, Du. "Multi-Agent Verification (BoN-MAV)." 2025. arXiv:2502.20379. [78] "The Confident Liar." 2026. arXiv:2606.10296. [79] "M3MAD-Bench." 2026. arXiv:2601.02854. [80] Kalra et al. "Verdict: A Library for Scaling Judge-Time Compute." 2025. arXiv:2502.18018.

Cascades/uncertainty: [81] Chen, Zaharia, Zou. "FrugalGPT..." 2023. arXiv:2305.05176. [82] Ong et al. "RouteLLM: Learning to Route LLMs with Preference Data." ICLR 2025. arXiv:2406.18665. [83] Yue et al. "LLM Cascades with Mixture of Thoughts Representations..." ICLR 2024. arXiv:2310.03094. [84] Aggarwal et al. "AutoMix: Automatically Mixing Language Models." NeurIPS 2024. arXiv:2310.12963. [85] Sarukkai et al. "Inference-Time Distillation... (ICD)." 2025. arXiv:2512.02543. [86] Kuhn, Gal, Farquhar. "Semantic Uncertainty..." ICLR 2023. arXiv:2302.09664. [87] Farquhar, Kossen, Kuhn, Gal. "Detecting hallucinations in large language models using semantic entropy." Nature 630:625, 2024. [88] Manakul, Liusie, Gales. "SelfCheckGPT..." EMNLP 2023. arXiv:2303.08896. [89] Xiong et al. "Can LLMs Express Their Uncertainty?..." ICLR 2024. arXiv:2306.13063. [90] Kadavath et al. "Language Models (Mostly) Know What They Know." 2022. arXiv:2207.05221. [91] UQ surveys: arXiv:2503.15850; arXiv:2412.05563; ACL 2025 Findings 1101.

Scaffolds: [92] Wang et al. "Plan-and-Solve Prompting..." ACL 2023. arXiv:2305.04091. [93] Zhou et al. "Least-to-Most Prompting..." ICLR 2023. arXiv:2205.10625. [94] Chen et al. "Program of Thoughts Prompting..." TMLR 2023. arXiv:2211.12588. [95] Gao et al. "PAL: Program-aided Language Models." ICML 2023. arXiv:2211.10435. [96] Sprague et al. "To CoT or not to CoT?..." ICLR 2025. arXiv:2409.12183. [97] Schulhoff et al. "The Prompt Report." 2024. arXiv:2406.06608. [98] Meincke et al. "Prompting Science Report 2..." 2025. arXiv:2506.07142. [99] DeepSeek-AI. "DeepSeek-R1..." 2025. arXiv:2501.12948. [100] Zhao et al. "Is Chain-of-Thought Reasoning of LLMs a Mirage?..." 2025. arXiv:2508.01191. [101] Jiang et al. "Self-planning Code Generation..." TOSEM 2024. arXiv:2303.06689. [102] Wang et al. "Planning In Natural Language Improves LLM Search For Code Generation (PlanSearch)." 2024. arXiv:2409.03733. [103] Xia et al. "Agentless: Demystifying LLM-based Software Engineering Agents." 2024. arXiv:2407.01489. [104] Tam et al. "Let Me Speak Freely?..." 2024. arXiv:2408.02442. [105] dottxt. "Say What You Mean." blog.dottxt.ai, 2024.

RAG/grounding/claims: [106] Spracklen et al. "We Have a Package for You!..." USENIX Security 2025. arXiv:2406.10279. [107] Jain et al. "On Mitigating Code LLM Hallucinations with API Documentation (CloudAPIBench)." 2024. arXiv:2407.09726. [108] Zhou et al. "DocPrompting: Generating Code by Retrieving the Docs." ICLR 2023. arXiv:2207.05987. [109] Eghbali, Pradel. "De-Hallucinator..." 2024. arXiv:2401.01701. [110] Wang et al. "CodeRAG-Bench..." 2024. arXiv:2406.14497. [111] Chen et al. "When LLMs Meet API Documentation..." 2025. arXiv:2503.15231. [112] Liu et al. "Beyond Functional Correctness: Exploring Hallucinations in LLM-Generated Code." TSE 2025. arXiv:2404.00971. [113] Min et al. "FActScore..." EMNLP 2023. arXiv:2305.14251. [114] Wei et al. "Long-form factuality in large language models (SAFE/LongFact)." NeurIPS 2024. arXiv:2403.18802. [115] Bayat et al. "FactBench/VERIFY." ACL 2025. arXiv:2410.22257. [116] "ClaimCheck." 2025. arXiv:2510.01226. [117] Wang et al. "OpenFactCheck." COLING 2025. arXiv:2405.05583. [118] Asai et al. "Self-RAG..." ICLR 2024. arXiv:2310.11511. [119] Yan et al. "Corrective Retrieval Augmented Generation (CRAG)." 2024. arXiv:2401.15884. [120] Jiang et al. "FLARE: Active Retrieval Augmented Generation." EMNLP 2023. arXiv:2305.06983. [121] "AdaRAGUE." ACL 2025. arXiv:2501.12835. [122] "TARG." 2025. arXiv:2511.09803. [123] Yao et al. "SeaKR." ACL 2025. arXiv:2406.19215. [124] Li et al. "Search-o1: Agentic Search-Enhanced Large Reasoning Models." 2025. arXiv:2501.05366. [125] Vu et al. "FreshLLMs..." ACL Findings 2024. arXiv:2310.03214. [126] Yin et al. "Do Large Language Models Know What They Don't Know? (SelfAware)." ACL Findings 2023. arXiv:2305.18153. [127] Joren et al. "Sufficient Context..." ICLR 2025. arXiv:2411.06037. [128] Li et al. (hallucination taxonomy survey). 2025. arXiv:2510.24476. [129] Zhang et al. "Argus: Evidence Assembly for Scalable Deep Research Agents." 2026. arXiv:2605.16217.

DeepSeek API logprobs support: api-docs.deepseek.com (checked June 2026 - `logprobs`/`top_logprobs` exposed on the v4 chat-completion line).
