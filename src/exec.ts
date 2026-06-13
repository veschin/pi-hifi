// Execution evidence for code candidates. Prefers the real sandbox (src/sandbox.ts:
// kernel-enforced limits + isolation); falls back to a bare-host throwaway-tempdir
// run ONLY when no sandbox tier is available (backward-compatible with the
// pre-sandbox behaviour - no worse than before, strictly safer where a tier
// exists). Stack-agnostic: runCandidateSelfTest runs node / python / ... by the
// language tag, not just node.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectSandbox, type CellEvidence } from "./sandbox.ts";
import { Scheduler, detectCapacity } from "./sandbox-pool.ts";
import { parseExperiment } from "./runner.ts";
import type { ExecEvidence } from "./types.ts";

const OUTPUT_CAP_BYTES = 64 * 1024;
const SELFTEST_MEM_MAX = 512 * 1024 * 1024;

export interface ExecRequest {
  /** File name -> contents. Must contain `entry`. */
  files: Record<string, string>;
  /** Entry file executed as `node <entry>`. */
  entry: string;
  timeoutMs: number;
}

function capped(buf: string): string {
  if (buf.length <= OUTPUT_CAP_BYTES) return buf;
  return `${buf.slice(0, OUTPUT_CAP_BYTES)}\n...[output truncated at 64KB]`;
}

function cellToExec(ce: CellEvidence): ExecEvidence {
  return {
    ran: ce.ran,
    exitCode: ce.exitCode,
    stdout: ce.stdout,
    stderr: ce.stderr,
    timedOut: ce.timedOut,
    ...(ce.skippedReason !== undefined ? { skippedReason: ce.skippedReason } : {}),
  };
}

// One scheduler per process: admission control is shared across every exec in a
// run (selector candidates, GVR probes, eval fixtures) so they cannot oversubscribe.
let schedulerPromise: Promise<Scheduler> | null = null;
function getScheduler(): Promise<Scheduler> {
  if (!schedulerPromise) schedulerPromise = detectCapacity().then((cap) => new Scheduler(cap));
  return schedulerPromise;
}

/** Bare-host fallback: run argv in a throwaway tempdir, minimal env. NO isolation. */
async function spawnBareHost(files: Record<string, string>, argv: string[], timeoutMs: number): Promise<ExecEvidence> {
  for (const name of Object.keys(files)) {
    if (name.includes("..") || path.isAbsolute(name)) {
      return { ran: false, exitCode: null, stdout: "", stderr: "", timedOut: false, skippedReason: `unsafe file name: ${name}` };
    }
  }
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "apodex-exec-"));
  } catch (err) {
    return { ran: false, exitCode: null, stdout: "", stderr: "", timedOut: false, skippedReason: `tempdir creation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    for (const [name, contents] of Object.entries(files)) {
      const fp = path.join(dir, name);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, contents, "utf8");
    }
    return await new Promise<ExecEvidence>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let sigkill: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      const killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        sigkill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2_000);
        sigkill.unref();
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => { if (stdout.length < OUTPUT_CAP_BYTES * 2) stdout += c.toString(); });
      child.stderr.on("data", (c: Buffer) => { if (stderr.length < OUTPUT_CAP_BYTES * 2) stderr += c.toString(); });
      const settle = (e: ExecEvidence) => { if (settled) return; settled = true; clearTimeout(killTimer); if (sigkill) clearTimeout(sigkill); resolve(e); };
      child.on("close", (code) => settle({ ran: true, exitCode: code, stdout: capped(stdout), stderr: capped(stderr), timedOut }));
      child.on("error", (err) => settle({ ran: false, exitCode: null, stdout: capped(stdout), stderr: capped(stderr), timedOut, skippedReason: `spawn failed: ${err.message}` }));
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Run files+argv: sandbox when a tier exists, bare-host fallback otherwise. */
async function execFiles(files: Record<string, string>, argv: string[], timeoutMs: number): Promise<ExecEvidence> {
  const tier = await detectSandbox();
  if (tier === "rootless" || tier === "docker") {
    const sched = await getScheduler();
    const ce = await sched.schedule({ argv, files, limits: { memMaxBytes: SELFTEST_MEM_MAX, wallMs: timeoutMs, outputCapBytes: OUTPUT_CAP_BYTES } });
    return cellToExec(ce);
  }
  // No isolation tier: same behaviour as before the sandbox existed.
  return spawnBareHost(files, argv, timeoutMs);
}

export async function runNodeScript(req: ExecRequest): Promise<ExecEvidence> {
  if (!Object.prototype.hasOwnProperty.call(req.files, req.entry)) {
    return { ran: false, exitCode: null, stdout: "", stderr: "", timedOut: false, skippedReason: `entry file ${req.entry} missing from files` };
  }
  return execFiles(req.files, ["node", req.entry], req.timeoutMs);
}

/** Single source of truth for rendering exec evidence into prompts. */
export function execEvidenceToText(evidence: ExecEvidence | null): string {
  if (!evidence) return "(no execution evidence)";
  if (!evidence.ran) {
    return `Self-test was NOT executed. Reason: ${evidence.skippedReason ?? "unknown"}.`;
  }
  const status = evidence.timedOut
    ? "TIMED OUT"
    : `exit code ${evidence.exitCode ?? "unknown"} (${evidence.exitCode === 0 ? "PASS" : "FAIL"})`;
  return [
    `Self-test executed: ${status}`,
    evidence.stdout.trim() ? `--- stdout ---\n${evidence.stdout.trim()}` : "(empty stdout)",
    evidence.stderr.trim() ? `--- stderr ---\n${evidence.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SOLUTION_BLOCK = /```(?:js|javascript|mjs)\s+solution\s*\n([\s\S]*?)```/;
const SELFTEST_BLOCK = /```(?:js|javascript|mjs)\s+selftest\s*\n([\s\S]*?)```/;

export interface ExtractedCode {
  solution: string | null;
  selftest: string | null;
}

/** Legacy node-only block extractor; still used by the eval scorer. */
export function extractCodeBlocks(answer: string): ExtractedCode {
  const solution = SOLUTION_BLOCK.exec(answer)?.[1] ?? null;
  const selftest = SELFTEST_BLOCK.exec(answer)?.[1] ?? null;
  return { solution, selftest };
}

/**
 * Run a candidate's own self-test as execution evidence - STACK-AGNOSTIC (node /
 * python / ... by the `<lang> solution`/`<lang> selftest` tag). No runnable
 * experiment (missing/unsupported blocks) -> ran:false + reason, so the caller
 * still ships the artifact flagged "not executed".
 */
export async function runCandidateSelfTest(answer: string, timeoutMs: number): Promise<ExecEvidence> {
  const parsed = parseExperiment(answer);
  if ("error" in parsed) {
    return { ran: false, exitCode: null, stdout: "", stderr: "", timedOut: false, skippedReason: parsed.error };
  }
  const files: Record<string, string> = {
    [parsed.runner.solutionFile]: parsed.solution,
    [parsed.runner.selftestFile]: parsed.selftest,
  };
  return execFiles(files, parsed.runner.argv, timeoutMs);
}
