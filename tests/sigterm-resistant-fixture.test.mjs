import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

import { removePath } from "./fs-helpers.mjs";
import { endOwnedProcess, processExists } from "./process-helpers.mjs";
import { HOLD_ENV, RESISTANT_CHILD, RESISTANT_TREE } from "./sigterm-resistant-fixture.mjs";
import { pollUntil } from "./wait-helpers.mjs";

const SIGNAL_WAIT_MS = 10_000;

function watchExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function readPid(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function waitForPid(file, ms = 20_000) {
  return pollUntil(() => readPid(file), ms);
}

async function releaseHold(prefix, pid) {
  const release = `${prefix}-${pid}`;
  await writeFile(release, "");
  return `${release}.resumed`;
}

// The window stays open until the test releases it, so only the SIGTERM can end the process inside it.
async function expectSurvived(gone, marker, label) {
  const resumed = pollUntil(() => (existsSync(marker) ? true : undefined), SIGNAL_WAIT_MS);
  const outcome = await Promise.race([
    gone.then(
      () => "ended",
      () => "still running",
    ),
    resumed.then(
      () => "resumed",
      () => "no resumed marker",
    ),
  ]);
  expect(outcome, `${label} did not survive the SIGTERM sent inside its held window`).toBe(
    "resumed",
  );
}

// Ends every process of the tree, also one that a failed or timed-out startup never read a pid for.
async function endTree(child, pidFiles, marker) {
  const pids = [];
  for (const file of pidFiles) {
    const pid = await readPid(file);
    if (pid !== undefined) pids.push(pid);
  }
  for (const pid of pids.reverse()) {
    if (pid !== child.pid && processExists(pid)) {
      await endOwnedProcess(pid, marker);
    }
  }
  // The direct child leads the process group this test created, so the group signal ends a member
  // whose pid file no read reached. The group id stays allocated while the group has members.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already empty.
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

// Usefulness: section 11 of #1067 - a handler installed before the pid file write keeps the child alive after that write.
test.skipIf(process.platform === "win32")(
  "a child that writes its pid file after its SIGTERM handler survives a signal inside the held window",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "sigterm-order-"));
    const pidFile = join(scratch, "child.pid");
    const holdPrefix = join(scratch, "release");
    let child;
    let pid;
    try {
      child = spawn(process.execPath, ["-e", RESISTANT_CHILD, pidFile], {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, [HOLD_ENV]: holdPrefix },
      });
      const ended = watchExit(child);
      pid = await waitForPid(pidFile);
      child.kill("SIGTERM");
      const marker = await releaseHold(holdPrefix, pid);
      await expectSurvived(ended, marker, `the child ${pid}`);
      expect(processExists(pid)).toBe(true);
    } finally {
      if (child) await endTree(child, [pidFile], scratch);
      await removePath(scratch);
    }
  },
  60_000,
);

// Usefulness: section 12 of #1067 - the grandchild installs its handler before its pid write, so a signal after that write leaves it alive.
test.skipIf(process.platform === "win32")(
  "a grandchild that writes its pid file after its SIGTERM handler survives a signal inside the held window",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "sigterm-order-tree-"));
    const pidFile = join(scratch, "tree.pid");
    const grandPidFile = `${pidFile}.grand`;
    const holdPrefix = join(scratch, "release");
    let child;
    let pid;
    let grandPid;
    try {
      child = spawn(process.execPath, ["-e", RESISTANT_TREE, pidFile, "", RESISTANT_TREE], {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, [HOLD_ENV]: holdPrefix },
      });
      const ended = watchExit(child);
      pid = await waitForPid(pidFile);
      child.kill("SIGTERM");
      const marker = await releaseHold(holdPrefix, pid);
      await expectSurvived(ended, marker, `the child ${pid}`);
      grandPid = await waitForPid(grandPidFile);
      const grandGone = pollUntil(
        () => (processExists(grandPid) ? undefined : true),
        SIGNAL_WAIT_MS,
      );
      process.kill(grandPid, "SIGTERM");
      const grandMarker = await releaseHold(holdPrefix, grandPid);
      await expectSurvived(grandGone, grandMarker, `the grandchild ${grandPid}`);
      expect(processExists(pid)).toBe(true);
      expect(processExists(grandPid)).toBe(true);
    } finally {
      if (child) await endTree(child, [pidFile, grandPidFile], scratch);
      await removePath(scratch);
    }
  },
  60_000,
);
