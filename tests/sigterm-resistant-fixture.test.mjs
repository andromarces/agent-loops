import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vite-plus/test";

import { removePath } from "./fs-helpers.mjs";
import { processExists } from "./process-helpers.mjs";
import { RESISTANT_CHILD, RESISTANT_TREE } from "./sigterm-resistant-fixture.mjs";
import { pollUntil } from "./wait-helpers.mjs";

const PAUSE_MS = 2000;

// A preload that pauses a process for PAUSE_MS right after it writes a `.pid` file, then writes a
// marker. The pause widens the gap between the pid write and the handler install. The old order
// then fails on every host, not only on a slow one.
const PAUSE_AFTER_PID_WRITE = `
const fs = require("node:fs");
const write = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  write(file, ...rest);
  if (!String(file).includes(".pid")) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PID_WRITE_PAUSE_MS));
  write(process.env.PID_WRITE_PAUSE_DONE + "-" + process.pid, "");
};
`;

async function pauseControl(scratch) {
  const preload = join(scratch, "pause-after-pid-write.cjs");
  await writeFile(preload, PAUSE_AFTER_PID_WRITE);
  return {
    env: {
      NODE_OPTIONS: `--require ${preload}`,
      PID_WRITE_PAUSE_MS: String(PAUSE_MS),
      PID_WRITE_PAUSE_DONE: join(scratch, "paused"),
    },
    marker: (pid) => join(scratch, `paused-${pid}`),
  };
}

function waitForPid(file, ms = 20_000) {
  return pollUntil(async () => {
    const text = await readFile(file, "utf8").catch(() => "");
    return /^\d+$/.test(text) ? Number(text) : undefined;
  }, ms);
}

function watchExit(child) {
  const state = { ended: null };
  child.once("exit", (code, signal) => {
    state.ended = { code, signal };
  });
  return state;
}

async function waitThroughPause(marker, ended, label) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (ended()) {
      throw new Error(`${label} ended before the pause after its pid file write.`);
    }
    if (existsSync(marker)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`The pause of ${label} did not end within 15000 ms.`);
    }
    await delay(25);
  }
}

// Usefulness: section 11 of #1067 - a handler installed before the pid file write keeps the child alive after that write.
test.skipIf(process.platform === "win32")(
  "a child that writes its pid file after its SIGTERM handler survives a signal right after the write",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "sigterm-order-"));
    const pidFile = join(scratch, "child.pid");
    const control = await pauseControl(scratch);
    let child;
    let pid;
    try {
      child = spawn(process.execPath, ["-e", RESISTANT_CHILD, pidFile], {
        stdio: "ignore",
        env: { ...process.env, ...control.env },
      });
      const state = watchExit(child);
      pid = await waitForPid(pidFile);
      child.kill("SIGTERM");
      await waitThroughPause(control.marker(pid), () => state.ended !== null, `the child ${pid}`);
      expect(processExists(pid)).toBe(true);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(scratch);
    }
  },
  60_000,
);

// Usefulness: section 12 of #1067 - the grandchild installs its handler before its pid write, so a signal after that write leaves it alive.
test.skipIf(process.platform === "win32")(
  "a grandchild that writes its pid file after its SIGTERM handler survives a signal right after the write",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "sigterm-order-tree-"));
    const pidFile = join(scratch, "tree.pid");
    const grandPidFile = `${pidFile}.grand`;
    const control = await pauseControl(scratch);
    let child;
    let pid;
    let grandPid;
    try {
      child = spawn(process.execPath, ["-e", RESISTANT_TREE, pidFile, "", RESISTANT_TREE], {
        stdio: "ignore",
        env: { ...process.env, ...control.env },
      });
      const state = watchExit(child);
      pid = await waitForPid(pidFile);
      grandPid = await waitForPid(grandPidFile);
      process.kill(pid, "SIGTERM");
      process.kill(grandPid, "SIGTERM");
      await waitThroughPause(
        control.marker(grandPid),
        () => !processExists(grandPid),
        `the grandchild ${grandPid}`,
      );
      expect(state.ended).toBeNull();
      expect(processExists(grandPid)).toBe(true);
    } finally {
      if (grandPid && processExists(grandPid)) {
        process.kill(grandPid, "SIGKILL");
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(scratch);
    }
  },
  60_000,
);
