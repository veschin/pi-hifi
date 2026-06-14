// Self-test for the SubCallClient self-heal helpers (pure logic): the reasoning
// ladder and the next-attempt budget escalation. The full retry loop needs a live
// model to exercise; these cover the riskiest pure decisions in that loop - the
// thinking step-down boundaries and the capped token doubling (critic 2026-06-14).
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { nextAttemptBudget, stepDownThinking } from "../src/llm.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}`);
    failed++;
  }
}

// stepDownThinking descends one level toward "off" and saturates there.
check("xhigh -> high", stepDownThinking("xhigh") === "high");
check("high -> medium", stepDownThinking("high") === "medium");
check("medium -> low", stepDownThinking("medium") === "low");
check("low -> minimal", stepDownThinking("low") === "minimal");
check("minimal -> off", stepDownThinking("minimal") === "off");
check("off saturates at off", stepDownThinking("off") === "off");
check("unknown level falls back to off", stepDownThinking("bogus" as unknown as ModelThinkingLevel) === "off");

// nextAttemptBudget steps thinking down and doubles tokens, capped.
const a = nextAttemptBudget("high", 32768, 65536);
check("budget: thinking steps down (high->medium)", a.thinking === "medium");
check("budget: tokens double (32768->65536)", a.maxTokens === 65536);

const b = nextAttemptBudget("medium", 65536, 65536);
check("budget: thinking continues down (medium->low)", b.thinking === "low");
check("budget: tokens stay at cap (65536)", b.maxTokens === 65536);

const c = nextAttemptBudget("low", 50000, 65536);
check("budget: double clamps to cap (100000->65536)", c.maxTokens === 65536);
check("budget: thinking down (low->minimal)", c.thinking === "minimal");

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nllm self-heal selftest: all green");
