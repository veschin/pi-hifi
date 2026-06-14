// SubCallClient - the single gateway for every nested LLM call.
//
// Guarantees:
//  - fresh, isolated context per call (one system prompt + one user message,
//    constructed from scratch - a sub-agent can never see another's reasoning);
//  - hard budgets (calls / tokens / cost / wall time) enforced before each call;
//  - per-call timeout and bounded retries with backoff;
//  - every call persisted to the run store for auditability.

import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Budget } from "./budget.ts";
import type { RoleResolver } from "./roles.ts";
import type { RunStore } from "./store.ts";
import type { SubCallOutcome, SubCallRecord, SubCallRequest, UsageTotals } from "./types.ts";

const RETRY_BACKOFF_MS = [1_000, 4_000, 10_000];

// Severity-ordered reasoning levels (mirrors config THINKING_LEVELS). A reasoning
// model can spend its ENTIRE token budget on thinking and return empty text with
// stopReason "length"; the self-heal steps it DOWN this ladder toward "off" so the
// answer budget is freed instead of repeating the identical empty call.
const THINKING_LADDER: readonly ModelThinkingLevel[] = ["xhigh", "high", "medium", "low", "minimal", "off"];
export function stepDownThinking(level: ModelThinkingLevel): ModelThinkingLevel {
  const i = THINKING_LADDER.indexOf(level);
  if (i < 0 || i >= THINKING_LADDER.length - 1) return "off";
  return THINKING_LADDER[i + 1]!;
}

/** The next attempt's budget after an empty length-capped response: step thinking
 * down one level and double the token ceiling, bounded by `cap`. Pure - this is
 * the self-heal decision, unit-tested in eval/llm-selftest.ts. The thinking
 * step-down is the real recovery lever (it frees the existing budget for the
 * answer); the token bump is secondary and deliberately capped (see selfHealCap). */
export function nextAttemptBudget(
  curThinking: ModelThinkingLevel,
  curMaxTokens: number,
  cap: number,
): { thinking: ModelThinkingLevel; maxTokens: number } {
  return { thinking: stepDownThinking(curThinking), maxTokens: Math.min(curMaxTokens * 2, cap) };
}

export interface SubCallClientOptions {
  resolver: RoleResolver;
  budget: Budget;
  store: RunStore;
  timeoutMs: number;
  maxRetries: number;
  /** External abort (Esc in pi, Ctrl+C in eval). */
  signal?: AbortSignal;
  onNote?: (note: string) => void;
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function usageOf(message: AssistantMessage): UsageTotals {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    costUsd: message.usage.cost.total,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SubCallClient {
  private readonly opts: SubCallClientOptions;
  private callCounter = 0;

  constructor(opts: SubCallClientOptions) {
    this.opts = opts;
  }

  /**
   * Run one isolated sub-call. Never throws on model-level failure (returns
   * ok:false with diagnostics); throws BudgetExhaustedError when budgets are
   * spent and AbortError when externally aborted.
   */
  async call(req: SubCallRequest): Promise<SubCallOutcome> {
    this.opts.budget.checkBeforeCall();

    const resolved = await this.opts.resolver.resolve(req.role);
    if (resolved.fallbackNote) this.opts.onNote?.(resolved.fallbackNote);

    const spec = resolved.model;
    const id = ++this.callCounter;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const baseOptions: SimpleStreamOptions = {
      temperature: req.temperature ?? this.cfgTemperature(req),
      timeoutMs: this.opts.timeoutMs,
      // completeSimple's own client retries stay off; retry policy lives here
      // so attempts are visible in the run record.
      maxRetries: 0,
    };
    if (resolved.apiKey !== undefined) baseOptions.apiKey = resolved.apiKey;
    if (resolved.headers !== undefined) baseOptions.headers = resolved.headers;
    // Per-attempt reasoning budget. maxTokens is the TOTAL for thinking + answer;
    // a reasoning model can burn all of it thinking and emit empty text (observed:
    // glm-5.2 @ thinking=high hit the cap with 0 answer tokens, three attempts in a
    // row). The self-heal in the loop below steps `curThinking` down and raises
    // `curMaxTokens` toward `ceiling` after such an empty length-capped attempt.
    let curMaxTokens = Math.min(req.maxTokens ?? this.cfgMaxTokens(req), spec.maxTokens);
    let curThinking = this.cfgThinking(req);
    // Bound self-heal escalation to 2x the initial budget, NOT the model max: the
    // thinking step-down is the real recovery lever; doubling the token ceiling all
    // the way to the model max just yields a final attempt too large to finish
    // inside the per-attempt timeout, burning wall time for nothing (critic
    // 2026-06-14). A bounded artifact that needs >2x is out of envelope (-> mega).
    const selfHealCap = Math.min(curMaxTokens * 2, spec.maxTokens);

    let lastError = "";
    let response: AssistantMessage | null = null;
    let attempts = 0;
    // Budget accounting must cover EVERY attempt, not just the final one -
    // a retried call costs real tokens on each try.
    const cumulativeUsage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    const accumulate = (message: AssistantMessage) => {
      const u = usageOf(message);
      cumulativeUsage.input += u.input;
      cumulativeUsage.output += u.output;
      cumulativeUsage.cacheRead += u.cacheRead;
      cumulativeUsage.cacheWrite += u.cacheWrite;
      cumulativeUsage.costUsd += u.costUsd;
    };

    const maxAttempts = this.opts.maxRetries + 1;
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      if (this.opts.signal?.aborted) {
        lastError = "aborted by caller";
        break;
      }
      // Timeout escalation: a retry of a TIMED-OUT call gets more time
      // (1x, 1.5x, 2x), otherwise a healthy-but-slow generation is aborted
      // again at the same mark and the retries only burn the wall budget.
      const attemptTimeoutMs = Math.round(this.opts.timeoutMs * (1 + 0.5 * (attempts - 1)));
      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
      const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeoutSignal]) : timeoutSignal;
      const attemptOptions: SimpleStreamOptions = {
        ...baseOptions,
        maxTokens: curMaxTokens,
        signal,
        timeoutMs: attemptTimeoutMs,
      };
      if (curThinking !== "off") attemptOptions.reasoning = curThinking;
      try {
        const message = await completeSimple(
          spec,
          {
            systemPrompt: req.systemPrompt,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: req.userText }],
                timestamp: Date.now(),
              },
            ],
          },
          attemptOptions,
        );
        accumulate(message);
        // completeSimple reports failures in-band via stopReason/errorMessage.
        if (message.stopReason === "aborted") {
          response = message;
          lastError = message.errorMessage ?? "aborted";
          if (this.opts.signal?.aborted) break; // external abort: do not retry
          // else: per-attempt timeout - retryable
        } else if (message.stopReason === "error") {
          response = message;
          lastError = message.errorMessage ?? "provider error";
        } else {
          const text = extractText(message);
          if (text.length === 0) {
            response = message;
            lastError = "empty response text";
            // SELF-HEAL: an empty reply means the model emitted no answer text -
            // usually because reasoning consumed the whole token budget (stopReason
            // "length"), but some providers report a thinking-cap as an empty
            // "stop". Either way, repeating the identical call repeats the failure,
            // so for the NEXT attempt step thinking DOWN (frees the answer budget)
            // and raise the ceiling. Stepping thinking down is always a safe
            // recovery for an empty response, regardless of stopReason. (A NON-empty
            // length stop is real truncation, handled in the success branch below.)
            if (attempts < maxAttempts) {
              const prev = `thinking=${curThinking}, maxTokens=${curMaxTokens}`;
              const next = nextAttemptBudget(curThinking, curMaxTokens, selfHealCap);
              curThinking = next.thinking;
              curMaxTokens = next.maxTokens;
              this.opts.onNote?.(
                `sub-call ${req.label}: empty output (${message.stopReason}; reasoning likely ate the budget: ${prev}) - next attempt thinking=${curThinking}, maxTokens=${curMaxTokens}`,
              );
            }
          } else {
            response = message;
            lastError = "";
            // Truncation is a SILENT cap otherwise: a `length`-stopped response is
            // non-empty so it counts as success, but the text is cut off at
            // maxTokens (e.g. a candidate's code ends mid-function and then fails
            // its own self-test for the wrong reason). Surface it so the caller
            // knows to raise the role's maxTokens or narrow the task.
            if (message.stopReason === "length") {
              this.opts.onNote?.(
                `sub-call ${req.label}: output TRUNCATED at maxTokens (stop=length) - the result is cut off; raise the role's maxTokens or narrow the task`,
              );
            }
            break; // success
          }
        }
      } catch (err) {
        if (this.opts.signal?.aborted) {
          lastError = "aborted by caller";
          break;
        }
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempts < maxAttempts) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 10_000;
        this.opts.onNote?.(`sub-call ${req.label} attempt ${attempts} failed (${truncate(lastError, 200)}); retrying in ${backoff / 1000}s`);
        await sleep(backoff, this.opts.signal);
      }
    }

    const usage = cumulativeUsage;
    this.opts.budget.record(usage);

    const text = response && lastError === "" ? extractText(response) : "";
    const record: SubCallRecord = {
      id,
      label: req.label,
      role: req.role,
      provider: spec.provider,
      model: spec.id,
      startedAt,
      durationMs: Date.now() - t0,
      retries: attempts - 1,
      stopReason: response?.stopReason ?? "error",
      usage,
      systemPrompt: req.systemPrompt,
      userText: req.userText,
      responseText: text || (response ? extractText(response) : ""),
    };
    if (lastError !== "") record.error = lastError;

    this.opts.store.appendSubCall(record);

    if (lastError !== "") {
      return { ok: false, text: "", record, error: lastError };
    }
    return { ok: true, text, record };
  }

  private cfgTemperature(req: SubCallRequest): number {
    return this.opts.resolver.getRoleSpec(req.role).temperature;
  }

  private cfgMaxTokens(req: SubCallRequest): number {
    return this.opts.resolver.getRoleSpec(req.role).maxTokens;
  }

  private cfgThinking(req: SubCallRequest) {
    return this.opts.resolver.getRoleSpec(req.role).thinking;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}
