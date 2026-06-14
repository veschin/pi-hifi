// Codifies the host probes from the sandbox design into an automated, repeatable
// test: the cell mechanism is hifi only if these OBSERVED behaviours hold.
//   1. a memory hog is OOM-killed at the cap (runaway RAM cannot happen);
//   2. the cell cannot see the host filesystem (cannot grep the host / read ~/.ssh);
//   3. the cell has no network;
//   4. a disk-fill is bounded (cannot fill the host disk via /work);
//   5. the degraded tier REFUSES untrusted work (no fake containment).
// On a host without the rootless tier the isolation tests SKIP with a clear
// reason rather than passing vacuously.
//
// Run: npx tsx eval/sandbox-selftest.ts

import { __setSandboxTier, detectSandbox, runCell, type CellEvidence } from "../src/sandbox.ts";

const MB = 1024 * 1024;

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

async function main(): Promise<void> {
  process.env.HIFI_TEST_HOOKS = "1"; // authorize the guarded __setSandboxTier hook
  const tier = await detectSandbox();
  console.log(`[sandbox] detected tier: ${tier}`);
  const results: boolean[] = [];

  // 5. degraded tier must REFUSE untrusted work (tier forced for the test).
  __setSandboxTier("degraded");
  const refused: CellEvidence = await runCell({ argv: ["echo", "hi"], limits: { memMaxBytes: 64 * MB, wallMs: 5_000 } });
  results.push(
    line(
      "degraded refuses untrusted",
      !refused.ran && /degraded|boundary|refus/i.test(refused.skippedReason ?? ""),
      refused.skippedReason ?? "(ran - BAD)",
    ),
  );
  __setSandboxTier(null); // restore real detection

  if ((await detectSandbox()) !== "rootless") {
    console.log("SKIP: isolation tests need the rootless tier. Cannot prove a boundary without one.");
    console.log(results.every(Boolean) ? "SANDBOX-SELFTEST PARTIAL (degraded check only)" : "SANDBOX-SELFTEST FAILED");
    if (!results.every(Boolean)) process.exitCode = 1;
    return;
  }

  // 1. memory cap OOM-kills a 300MB hog under a 64MB cap.
  const hog = "b=[]\nfor i in range(30): b.append(bytearray(10*1024*1024)); print((i+1)*10, flush=True)\nprint('ALLOCATED_300MB')";
  const mem: CellEvidence = await runCell({ argv: ["python3", "-c", hog], limits: { memMaxBytes: 64 * MB, wallMs: 10_000 } });
  results.push(
    line(
      "memory cap OOM-kills",
      mem.ran && !mem.stdout.includes("ALLOCATED_300MB") && (mem.oomKilled || mem.exitCode !== 0),
      `oom=${mem.oomKilled} exit=${mem.exitCode} lastMB=${mem.stdout.trim().split(/\s+/).pop() ?? "?"}`,
    ),
  );

  // 2. fs confinement: cell root has no /home, cannot read host ssh keys.
  const fsCell: CellEvidence = await runCell({
    argv: ["/bin/sh", "-c", "ls / ; echo ---; ls /home 2>&1 | head -1"],
    limits: { memMaxBytes: 128 * MB, wallMs: 10_000 },
  });
  const root = fsCell.stdout.split("---")[0] ?? "";
  results.push(
    line(
      "fs confinement (no host /home)",
      fsCell.ran && !/\bhome\b/.test(root) && /No such file|cannot access/.test(fsCell.stdout),
      `root=[${root.trim().replace(/\s+/g, " ")}]`,
    ),
  );

  // 3. no network.
  const netProbe = "import socket\ntry:\n socket.create_connection(('1.1.1.1',53),timeout=3); print('NET_REACHABLE')\nexcept Exception as e: print('NET_BLOCKED', type(e).__name__)";
  const netCell: CellEvidence = await runCell({
    argv: ["python3", "-c", netProbe],
    limits: { memMaxBytes: 128 * MB, wallMs: 8_000 },
    net: "none",
  });
  results.push(
    line(
      "network isolated",
      netCell.ran && netCell.stdout.includes("NET_BLOCKED") && !netCell.stdout.includes("NET_REACHABLE"),
      netCell.stdout.trim().replace(/\s+/g, " "),
    ),
  );

  // 4. disk-fill bounded: 300MB write into /work must NOT succeed on the host.
  const diskCell: CellEvidence = await runCell({
    argv: ["/bin/sh", "-c", "dd if=/dev/zero of=/work/big bs=1M count=300 2>&1; echo RC=$?; wc -c < /work/big 2>/dev/null || echo nofile"],
    limits: { memMaxBytes: 64 * MB, wallMs: 12_000 },
  });
  const wroteFull = /300\+0 records out/.test(diskCell.stdout) && /\b314572800\b/.test(diskCell.stdout);
  results.push(
    line(
      "disk write bounded (/work tmpfs)",
      diskCell.ran && !wroteFull,
      `oom=${diskCell.oomKilled} out=${diskCell.stdout.trim().replace(/\s+/g, " ").slice(0, 80)}`,
    ),
  );

  const passed = results.every(Boolean);
  console.log(passed ? "SANDBOX-SELFTEST PASSED: cell limits + isolation hold" : "SANDBOX-SELFTEST FAILED");
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("sandbox-selftest crashed:", err);
  process.exitCode = 1;
});
