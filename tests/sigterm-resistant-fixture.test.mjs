import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";

import { execBounded } from "../src/lib/exec.mjs";
import { removePath } from "./fs-helpers.mjs";
import { endOwnedProcess, processExists } from "./process-helpers.mjs";
import { HOLD_ENV, RESISTANT_CHILD, RESISTANT_TREE } from "./sigterm-resistant-fixture.mjs";
import { pollUntil } from "./wait-helpers.mjs";

const SIGNAL_WAIT_MS = 10_000;

// Every child a case started. The teardown runs after the case, also when a runner timeout ends it.
const started = [];

afterEach(async () => {
  for (const tree of started.splice(0).reverse()) {
    await endTree(tree);
    await removePath(tree.scratch);
  }
});

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

// Records a started tree, so the teardown sees every pid that the case learned.
function track(child, scratch, pidFiles) {
  const tree = { child, scratch, pidFiles, marker: scratch, pids: new Set() };
  started.push(tree);
  return tree;
}

function remember(tree, pid) {
  tree.pids.add(pid);
  return pid;
}

// True while the group that the direct child leads still holds a process of this test. The leader
// proves the group while it lives. After its exit, a member must carry the unique scratch path.
async function ownsGroup(tree) {
  if (tree.child.exitCode === null && tree.child.signalCode === null) {
    return true;
  }
  const read = await execBounded("ps", ["-A", "-ww", "-o", "pgid=,command="]);
  if (typeof read.stdout !== "string") {
    return false;
  }
  return read.stdout.split("\n").some((line) => {
    const [group, ...command] = line.trim().split(/\s+/);
    return Number(group) === tree.child.pid && command.join(" ").includes(tree.marker);
  });
}

// Ends every process of the tree, also one that a failed or timed-out startup never read a pid for.
async function endTree(tree) {
  const pids = new Set(tree.pids);
  for (const file of tree.pidFiles) {
    const pid = await readPid(file);
    if (pid !== undefined) pids.add(pid);
  }
  for (const pid of [...pids].reverse()) {
    if (pid !== tree.child.pid && processExists(pid)) {
      await endOwnedProcess(pid, tree.marker);
    }
  }
  if (await ownsGroup(tree)) {
    try {
      process.kill(-tree.child.pid, "SIGKILL");
    } catch {
      // The group is already empty.
    }
  }
  if (tree.child.exitCode === null && tree.child.signalCode === null) {
    tree.child.kill("SIGKILL");
  }
}

// Usefulness: section 11 of #1067 - a handler installed before the pid file write keeps the child alive after that write.
test.skipIf(process.platform === "win32")(
  "a child that writes its pid file after its SIGTERM handler survives a signal inside the held window",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "sigterm-order-"));
    const pidFile = join(scratch, "child.pid");
    const holdPrefix = join(scratch, "release");
    const child = spawn(process.execPath, ["-e", RESISTANT_CHILD, pidFile], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, [HOLD_ENV]: holdPrefix },
    });
    const tree = track(child, scratch, [pidFile]);
    const ended = watchExit(child);
    const pid = remember(tree, await waitForPid(pidFile));
    child.kill("SIGTERM");
    const marker = await releaseHold(holdPrefix, pid);
    await expectSurvived(ended, marker, `the child ${pid}`);
    expect(processExists(pid)).toBe(true);
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
    const child = spawn(process.execPath, ["-e", RESISTANT_TREE, pidFile, "", RESISTANT_TREE], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, [HOLD_ENV]: holdPrefix },
    });
    const tree = track(child, scratch, [pidFile, grandPidFile]);
    const ended = watchExit(child);
    const pid = remember(tree, await waitForPid(pidFile));
    child.kill("SIGTERM");
    const marker = await releaseHold(holdPrefix, pid);
    await expectSurvived(ended, marker, `the child ${pid}`);
    const grandPid = remember(tree, await waitForPid(grandPidFile));
    const grandGone = pollUntil(() => (processExists(grandPid) ? undefined : true), SIGNAL_WAIT_MS);
    process.kill(grandPid, "SIGTERM");
    const grandMarker = await releaseHold(holdPrefix, grandPid);
    await expectSurvived(grandGone, grandMarker, `the grandchild ${grandPid}`);
    expect(processExists(pid)).toBe(true);
    expect(processExists(grandPid)).toBe(true);
  },
  60_000,
);
