// Proves the triage gate-driver: the pure classifier (parseTriage), the
// fail-safe coercions, the fallback plan, and runTriage's retry/fallback control
// flow are exercised WITHOUT any LLM (a stub SubCallClient drives the branches).
// The cheap-flash end-to-end check (runTriage over a real flash model) runs only
// under APODEX_TRIAGE_LIVE=1 so the default run stays free and CI-safe.
//
// Run (free):  npx tsx eval/triage-selftest.ts
// Run (+live): APODEX_TRIAGE_LIVE=1 npx tsx eval/triage-selftest.ts

import { parseTriage, fallbackPlan, runTriage, megaRoadmapClarification, shouldBackstopDialog } from "../src/triage.ts";
import { SubCallClient } from "../src/llm.ts";
import type { SubCallOutcome, SubCallRecord, SubCallRequest } from "../src/types.ts";
import { loadConfig, defaultConfig, DEFAULT_WORKER_MODEL } from "../src/config.ts";
import { Budget } from "../src/budget.ts";
import { RunStore } from "../src/store.ts";
import { RoleResolver } from "../src/roles.ts";
import { createStandaloneRegistry } from "./standalone.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

/** Build the snake_case JSON object a model would emit for triage. */
function modelJson(f: {
  type?: string;
  scale?: string;
  oracle?: string;
  arch_risk?: boolean;
  needs_dialog?: boolean;
  confidence?: string;
  roadmap?: string[];
  rationale?: string;
}): string {
  return JSON.stringify(f);
}

const goodJson = modelJson({
  type: "code",
  scale: "micro",
  oracle: "execute",
  arch_risk: false,
  needs_dialog: false,
  confidence: "high",
  roadmap: [],
  rationale: "ok",
});
const garbageText = "Sorry, I cannot classify this without more detail.";

// --- stub SubCallClient: scripts a sequence of outcomes, counts the calls. ---

function outcome(ok: boolean, text: string, error?: string): SubCallOutcome {
  // runTriage only reads .ok/.text/.error; the record is never inspected.
  const record = { label: "stub", responseText: text } as unknown as SubCallRecord;
  return error !== undefined ? { ok, text, record, error } : { ok, text, record };
}

function stubClient(scripted: SubCallOutcome[]): { client: SubCallClient; calls: () => number } {
  let i = 0;
  const stub = {
    call: async (_req: SubCallRequest): Promise<SubCallOutcome> => {
      const out = scripted[i] ?? outcome(false, "", "stub exhausted");
      i += 1;
      return out;
    },
  };
  return { client: stub as unknown as SubCallClient, calls: () => i };
}

async function runFreeTests(): Promise<boolean> {
  const r: boolean[] = [];

  // parseTriage - well-formed micro, high confidence: no coercion, dialog stays off.
  {
    const p = parseTriage(
      modelJson({
        type: "code",
        scale: "micro",
        oracle: "execute",
        arch_risk: false,
        needs_dialog: false,
        confidence: "high",
        roadmap: [],
        rationale: "tiny fix",
      }),
    );
    r.push(
      line(
        "parse well-formed micro",
        p !== null &&
          p.type === "code" &&
          p.scale === "micro" &&
          p.oracle === "execute" &&
          p.needsDialog === false &&
          p.confidence === "high" &&
          p.archRisk === false,
        p ? `scale=${p.scale} dialog=${p.needsDialog} conf=${p.confidence}` : "null",
      ),
    );
  }

  // parseTriage - mega WITH a roadmap + high confidence: the mega coercion targets
  // only roadmap-less megas, so dialog stays off here (positive control).
  {
    const p = parseTriage(
      modelJson({
        type: "code",
        scale: "mega",
        oracle: "execute",
        arch_risk: false,
        needs_dialog: false,
        confidence: "high",
        roadmap: ["terrain", "blocks"],
        rationale: "big but planned",
      }),
    );
    r.push(
      line(
        "parse mega+roadmap keeps dialog=false",
        p !== null && p.scale === "mega" && p.needsDialog === false && p.roadmap.length === 2,
        p ? `dialog=${p.needsDialog} roadmap=${p.roadmap.length}` : "null",
      ),
    );
  }

  // fail-safe - low confidence forces dialog even when the model said needs_dialog:false.
  {
    const p = parseTriage(
      modelJson({
        type: "code",
        scale: "bounded",
        oracle: "execute",
        arch_risk: false,
        needs_dialog: false,
        confidence: "low",
        roadmap: [],
        rationale: "unsure",
      }),
    );
    r.push(
      line(
        "fail-safe low-confidence -> dialog",
        p !== null && p.needsDialog === true && p.confidence === "low",
        p ? `dialog=${p.needsDialog} conf=${p.confidence}` : "null",
      ),
    );
  }

  // fail-safe - mega WITHOUT a roadmap forces dialog; confidence stays high, which
  // proves it was the mega branch (not the low-confidence branch) that fired.
  {
    const p = parseTriage(
      modelJson({
        type: "design",
        scale: "mega",
        oracle: "none",
        arch_risk: true,
        needs_dialog: false,
        confidence: "high",
        roadmap: [],
        rationale: "no plan given",
      }),
    );
    r.push(
      line(
        "fail-safe mega-no-roadmap -> dialog",
        p !== null && p.needsDialog === true && p.confidence === "high" && p.scale === "mega",
        p ? `dialog=${p.needsDialog} conf=${p.confidence} scale=${p.scale}` : "null",
      ),
    );
  }

  // malformed JSON (unescaped quotes break JSON.parse): enums are recovered by the
  // regex fallback, and the !parsedOk branch FORCES needsDialog=true/confidence=low
  // (a guaranteed invariant, not an emergent default) so a corrupt reply is never a
  // confident cheap route.
  {
    const raw = `{
  "type": "code",
  "scale": "micro",
  "oracle": "execute",
  "arch_risk": false,
  "needs_dialog": false,
  "confidence": "high",
  "roadmap": [],
  "rationale": "fix the "off-by-one" in add"
}`;
    const p = parseTriage(raw);
    r.push(
      line(
        "malformed JSON -> regex enums + safe defaults",
        p !== null &&
          p.type === "code" &&
          p.scale === "micro" &&
          p.oracle === "execute" &&
          p.needsDialog === true &&
          p.confidence === "low",
        p ? `type=${p.type} scale=${p.scale} dialog=${p.needsDialog} conf=${p.confidence}` : "null",
      ),
    );
  }

  // garbage with no JSON and no extractable enums -> null (caller falls back).
  {
    const p = parseTriage(garbageText);
    r.push(line("garbage -> null", p === null, p ? "got a plan (wrong)" : "null"));
  }

  // structurally valid JSON but an out-of-vocabulary enum: not in the fixed set and
  // not regex-recoverable -> null, so runTriage re-asks/falls back. This is the path
  // where a silent wrong cheap-route would be most likely to slip through.
  {
    const p = parseTriage(
      modelJson({
        type: "code",
        scale: "huge", // not micro|bounded|mega
        oracle: "execute",
        arch_risk: false,
        needs_dialog: false,
        confidence: "high",
        roadmap: [],
        rationale: "bad scale",
      }),
    );
    r.push(line("out-of-vocab enum -> null", p === null, p ? `got scale=${p.scale} (wrong)` : "null"));
  }

  // fallbackPlan - the safe default: ask, do not guess cheap.
  {
    const p = fallbackPlan("boom");
    r.push(
      line(
        "fallbackPlan = ask/safe",
        p.needsDialog === true &&
          p.confidence === "low" &&
          p.scale === "bounded" &&
          p.oracle === "none" &&
          p.roadmap.length === 0 &&
          p.rationale === "boom",
        `scale=${p.scale} oracle=${p.oracle} dialog=${p.needsDialog} conf=${p.confidence}`,
      ),
    );
  }

  // runTriage - first call parses: returns it, no retry.
  {
    const { client, calls } = stubClient([outcome(true, goodJson)]);
    const p = await runTriage(client, "x");
    r.push(line("runTriage first-good -> 1 call", p.scale === "micro" && calls() === 1, `scale=${p.scale} calls=${calls()}`));
  }

  // runTriage - first call unparseable, retry parses: returns retry, re-ask emitted.
  {
    const { client, calls } = stubClient([outcome(true, garbageText), outcome(true, goodJson)]);
    const notes: string[] = [];
    const p = await runTriage(client, "x", (m) => notes.push(m));
    r.push(
      line(
        "runTriage retry-then-good -> 2 calls + re-ask note",
        p.scale === "micro" && calls() === 2 && notes.some((n) => n.includes("re-ask")),
        `scale=${p.scale} calls=${calls()} notes=${notes.length}`,
      ),
    );
  }

  // runTriage - first call fails at transport, retry parses: returns retry, and the
  // progress note honestly says "call failed" (not "unparseable" - there was no reply
  // to be unparseable, and no corrective "your reply was invalid" instruction is sent).
  {
    const { client, calls } = stubClient([outcome(false, "", "provider down"), outcome(true, goodJson)]);
    const notes: string[] = [];
    const p = await runTriage(client, "x", (m) => notes.push(m));
    r.push(
      line(
        "runTriage transport-fail-then-good -> 2 calls + honest note",
        p.scale === "micro" &&
          calls() === 2 &&
          notes.some((n) => n.includes("call failed")) &&
          !notes.some((n) => n.includes("unparseable")),
        `scale=${p.scale} calls=${calls()} notes=[${notes.join(" | ")}]`,
      ),
    );
  }

  // runTriage - both calls fail at transport level: fail-safe plan, error surfaced.
  {
    const { client, calls } = stubClient([outcome(false, "", "provider down"), outcome(false, "", "still down")]);
    const p = await runTriage(client, "x");
    r.push(
      line(
        "runTriage both-fail -> fallback(error)",
        p.needsDialog === true && p.confidence === "low" && p.rationale === "provider down" && calls() === 2,
        `dialog=${p.needsDialog} rationale="${p.rationale}" calls=${calls()}`,
      ),
    );
  }

  // runTriage - both calls return ok but unparseable: fail-safe plan, parse reason.
  {
    const { client, calls } = stubClient([outcome(true, garbageText), outcome(true, garbageText)]);
    const p = await runTriage(client, "x");
    r.push(
      line(
        "runTriage both-garbage -> fallback(unparseable)",
        p.needsDialog === true && p.rationale === "classification unparseable twice" && calls() === 2,
        `dialog=${p.needsDialog} rationale="${p.rationale}" calls=${calls()}`,
      ),
    );
  }

  // megaRoadmapClarification - the pause payload a mega task returns (kind=roadmap).
  {
    const plan = parseTriage(
      modelJson({
        type: "code",
        scale: "mega",
        oracle: "execute",
        arch_risk: false,
        needs_dialog: false,
        confidence: "high",
        roadmap: ["a", "b", "c"],
        rationale: "x",
      }),
    );
    const c = plan ? megaRoadmapClarification(plan) : null;
    r.push(
      line(
        "megaRoadmapClarification carries the roadmap",
        c !== null && c.kind === "roadmap" && c.roadmap.length === 3 && c.questions.length === 0 && c.briefDraft === null,
        c ? `kind=${c.kind} roadmap=${c.roadmap.length}` : "null",
      ),
    );
  }
  {
    const c = megaRoadmapClarification(fallbackPlan("x"));
    r.push(
      line("megaRoadmapClarification empty roadmap ok", c.kind === "roadmap" && c.roadmap.length === 0, `roadmap=${c.roadmap.length}`),
    );
  }

  // config.triage - default ON (defaultConfig); APODEX_TRIAGE_ENABLED toggles it
  // both ways (env beats any .apodex.json, so this is robust to ambient config).
  {
    const def = defaultConfig().triage.enabled;
    const off = loadConfig({ cwd: process.cwd(), env: { APODEX_TRIAGE_ENABLED: "0" } }).config.triage.enabled;
    const on = loadConfig({ cwd: process.cwd(), env: { APODEX_TRIAGE_ENABLED: "1" } }).config.triage.enabled;
    r.push(
      line("config.triage default on / env toggles", def === true && off === false && on === true, `default=${def} off=${off} on=${on}`),
    );
  }

  // shouldBackstopDialog - fires only when brief OFF + interactive + needsDialog.
  {
    const dialog = fallbackPlan("x"); // needsDialog=true
    const noDialog = parseTriage(
      modelJson({ type: "code", scale: "micro", oracle: "execute", arch_risk: false, needs_dialog: false, confidence: "high", roadmap: [], rationale: "x" }),
    );
    r.push(
      line(
        "shouldBackstopDialog: only brief-off + interactive + needsDialog",
        shouldBackstopDialog(dialog, false, true) === true &&
          shouldBackstopDialog(dialog, true, true) === false && // brief on -> brief handles it
          shouldBackstopDialog(dialog, false, false) === false && // non-interactive -> proceed
          shouldBackstopDialog(noDialog, false, true) === false && // confident -> no pause
          shouldBackstopDialog(null, false, true) === false, // no plan -> no pause
        `dialog/off/interactive=${shouldBackstopDialog(dialog, false, true)}`,
      ),
    );
  }

  return r.every(Boolean);
}

async function runLiveTests(): Promise<boolean> {
  const warnings: string[] = [];
  // Pin the analyst (triage) role to the cheap flash worker and cap spend hard:
  // two classifications must never run away on calls/cost/wall-time.
  const { config } = loadConfig({
    cwd: process.cwd(),
    env: {
      ...process.env,
      APODEX_ANALYST: DEFAULT_WORKER_MODEL,
      APODEX_MAX_SUBCALLS: process.env.APODEX_MAX_SUBCALLS ?? "6",
      APODEX_MAX_COST_USD: process.env.APODEX_MAX_COST_USD ?? "0.5",
      APODEX_MAX_WALL_TIME_MS: process.env.APODEX_MAX_WALL_TIME_MS ?? "120000",
    },
  });
  console.log(`[live] analyst (triage) model = ${config.roles.analyst.model}`);

  const registry = createStandaloneRegistry();
  const budget = new Budget(config.budget);
  const resolver = new RoleResolver({ config, registry });
  const runId = RunStore.newRunId("triage-selftest");
  const baseDir = config.runsDir.startsWith("/") ? config.runsDir : `${process.cwd()}/${config.runsDir}`;
  const store = new RunStore(baseDir, runId, (w) => warnings.push(w));
  const client = new SubCallClient({
    resolver,
    budget,
    store,
    timeoutMs: config.budget.subCallTimeoutMs,
    maxRetries: config.budget.subCallMaxRetries,
    onNote: (n) => console.error(`[note] ${n}`),
  });

  const r: boolean[] = [];

  const megaTask =
    "Build Minecraft from scratch: a voxel sandbox game with procedural terrain " +
    "generation, block placement and destruction, dynamic lighting, an inventory " +
    "system, mob AI, and online multiplayer.";
  const mega = await runTriage(client, megaTask, (m) => console.error(`[progress] ${m}`));
  r.push(
    line(
      "live mega -> scale=mega",
      mega.scale === "mega",
      `scale=${mega.scale} dialog=${mega.needsDialog} roadmap=${mega.roadmap.length} conf=${mega.confidence}`,
    ),
  );

  const microTask =
    "In this JS function `function add(a, b) { return a + b + 1; }` there is an " +
    "off-by-one bug; it should return a + b. Fix it.";
  const micro = await runTriage(client, microTask, (m) => console.error(`[progress] ${m}`));
  r.push(
    line(
      "live micro -> scale=micro",
      micro.scale === "micro",
      `scale=${micro.scale} dialog=${micro.needsDialog} oracle=${micro.oracle} conf=${micro.confidence}`,
    ),
  );

  const snap = budget.snapshot();
  console.log(`[live] spent: ${snap.subCalls} calls, ${snap.totalTokens} tokens, $${snap.costUsd.toFixed(4)}`);
  if (warnings.length > 0) console.log(`[live] warnings: ${warnings.join(" | ")}`);
  return r.every(Boolean);
}

async function main(): Promise<void> {
  console.log("== FREE tests (no LLM) ==");
  const free = await runFreeTests();

  let live = true;
  const liveRequested = Boolean(process.env.APODEX_TRIAGE_LIVE);
  if (liveRequested) {
    console.log("\n== LIVE cheap-flash check ==");
    try {
      live = await runLiveTests();
    } catch (err) {
      live = false;
      console.error("LIVE check crashed:", err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log("\nSKIP: live cheap-flash check (set APODEX_TRIAGE_LIVE=1 to run it)");
  }

  const ok = free && live;
  const scope = liveRequested ? "free + live" : "free";
  console.log(`\n${ok ? "TRIAGE-SELFTEST PASSED" : "TRIAGE-SELFTEST FAILED"} (${scope})`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("triage selftest crashed:", err);
  process.exitCode = 1;
});
