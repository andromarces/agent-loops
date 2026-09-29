import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";

/**
 * Creates a temporary git repository with one initial commit (`init.txt`).
 * Side effect: leaves a directory in the OS temp dir; callers must remove it
 * with `removePath`.
 */
export async function createTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "runtime-test-repo-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.name", "Tester"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(join(dir, "init.txt"), "hello\n");
  await execa("git", ["add", "init.txt"], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

/**
 * Removes a test path, retrying transient Windows locks. `fs.rm` retries
 * EBUSY, EPERM, and ENOTEMPTY only when `maxRetries` is set (default 0), so a
 * handle held by antivirus, an indexer, or a lingering child otherwise fails
 * the removal. Retries stay scoped to fixture removal, both setup and
 * teardown; a deliberate in-test delete that is itself the case under test
 * keeps plain `rm`.
 */
export async function removePath(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Captured at import, before any test overrides the runs root.
const originalRunsRoot = process.env.AGENT_LOOP_RUNS_ROOT;

/**
 * Puts AGENT_LOOP_RUNS_ROOT back to the value it had before the tests overrode
 * it: set when it existed, deleted only when it did not.
 */
export function restoreRunsRoot() {
  if (originalRunsRoot === undefined) {
    delete process.env.AGENT_LOOP_RUNS_ROOT;
  } else {
    process.env.AGENT_LOOP_RUNS_ROOT = originalRunsRoot;
  }
}

/**
 * Runs an ordered list of fake replies and records each call in `recorded`.
 * A reply may be a value or a `(state, prompt, options)` function; values are
 * returned as-is, functions are called instead.
 */
export function scripted(replies) {
  let callIndex = 0;
  const recorded = [];
  return {
    recorded,
    async run(state, prompt, options) {
      state.sessionId = state.sessionId ?? `${state.kind}-sess`;
      recorded.push({ prompt, options, sessionId: state.sessionId });
      const reply = replies[callIndex++];
      if (typeof reply === "function") {
        return reply(state, prompt, options);
      }
      return reply;
    },
  };
}

/**
 * Resolves to the pid of an exited one-shot process, so callers can build a
 * lock file that points at a dead owner. child_process exposes the pid; execa's
 * result does not.
 */
export async function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid));
    child.on("error", reject);
  });
}

// A hanging child outlives every wait below, so a survivor is still running when
// the checks end. It is a `node` process on every platform, launched by a
// wrapper (`.cmd` on Windows, `sh` elsewhere) that stays alive as its parent, so
// a kill that reaches only the wrapper leaves the node process running.
const SHIM_HANG_MS = 20_000;
const SHIM_BEAT_MS = 100;
// A beat older than this is stale. A live child stalls this long only if the
// machine starves it for a full second.
const SHIM_FRESH_MS = 1000;
// The longest a kill may take to land after the call returns. A survivor is
// running for SHIM_HANG_MS from its start, which is far past this window plus
// the bound and its margin, so a survivor is still beating when the wait ends.
const SHIM_GONE_WINDOW_MS = 5000;
// How far past its bound a bounded call may return. Load adds start and kill time
// to the bound; the margin sits far below SHIM_HANG_MS, so a call that waits for
// the child overshoots it, and a bound that is wrong by more than the margin
// overshoots it too.
const SHIM_BOUND_MARGIN_MS = 5000;

/**
 * Writes a `command` shim into `dir` that hangs, so a bound is exercised against
 * a real child process. The long-lived node process records its own pid in
 * `started` when it runs, then rewrites `beat` with the current time every
 * SHIM_BEAT_MS until SHIM_HANG_MS passes. A beat is written only by the process
 * that runs the shim, so it identifies a survivor even if its pid is reused.
 */
async function writeHangingShim(dir, command) {
  const started = join(dir, "started.txt");
  const beat = join(dir, "beat.txt");
  const script = join(dir, "hang.js");
  await writeFile(
    script,
    `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
setInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(Date.now())), ${SHIM_BEAT_MS});
setTimeout(() => process.exit(0), ${SHIM_HANG_MS});
`,
  );
  if (process.platform === "win32") {
    await writeFile(join(dir, `${command}.cmd`), `@echo off\r\nnode "${script}"\r\n`);
  } else {
    await writeFile(join(dir, command), `#!/bin/sh\nnode '${script}'\n`, { mode: 0o755 });
  }
  return { started, beat };
}

// Returns the pid the shim recorded, or null if none appears within `waitMs`.
async function waitForPid(started, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const pid = Number.parseInt(await readFile(started, "utf8").catch(() => ""), 10);
    if (Number.isInteger(pid)) {
      return pid;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await delay(50);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// A survivor is a live pid that is still beating. The beat guards against pid
// reuse: another process that took the pid writes no beat, so it reads as gone.
async function isSurvivor(pid, beat) {
  if (!processExists(pid)) {
    return false;
  }
  const last = Number.parseInt(await readFile(beat, "utf8").catch(() => ""), 10);
  return Number.isInteger(last) && Date.now() - last < SHIM_FRESH_MS;
}

async function assertGone(pid, beat) {
  const deadline = Date.now() + SHIM_GONE_WINDOW_MS;
  while ((await isSurvivor(pid, beat)) && Date.now() < deadline) {
    await delay(50);
  }
  assert.ok(!(await isSurvivor(pid, beat)), `the shim child ${pid} survived the cancellation`);
}

// A call that a surviving child holds open never returns, so the wait is capped
// and fails with the reason instead of running into the test timeout.
async function returnsWithin(call, limitMs, message) {
  const cap = new AbortController();
  try {
    return await Promise.race([
      call,
      delay(limitMs, undefined, { signal: cap.signal }).then(() => {
        throw new assert.AssertionError({ message });
      }),
    ]);
  } finally {
    cap.abort();
  }
}

async function withShimOnPath(dir, body) {
  const path = process.env.PATH;
  try {
    process.env.PATH = `${dir}${delimiter}${path}`;
    return await body();
  } finally {
    process.env.PATH = path;
  }
}

/**
 * Checks that a time bound of `boundMs` kills a real hanging `command` child.
 * `run(boundMs)` starts the bounded call and resolves when it returns.
 *
 * The bound is proved by the call returning within `boundMs` plus
 * SHIM_BOUND_MARGIN_MS. Termination is proved by the node process the shim
 * recorded: it must be gone, or no longer beating, within SHIM_GONE_WINDOW_MS.
 * Neither check depends on a wall-clock wait for a marker. The child must have
 * started before the call returned, or the test fails: a child that never ran
 * proves nothing about the kill, so `boundMs` must leave the shim time to start
 * on a loaded machine. Returns the result of the call.
 */
export async function expectBoundKillsShim(command, run, boundMs = 2000) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  try {
    const shim = await writeHangingShim(dir, command);
    return await withShimOnPath(dir, async () => {
      const result = await returnsWithin(
        run(boundMs),
        boundMs + SHIM_BOUND_MARGIN_MS,
        `the call outlasted its ${boundMs} ms bound by more than ${SHIM_BOUND_MARGIN_MS} ms`,
      );
      // The record was written before the bound expired, so a short wait only
      // covers file visibility.
      const pid = await waitForPid(shim.started, 500);
      assert.notEqual(pid, null, `the shim did not start within the ${boundMs} ms bound`);
      await assertGone(pid, shim.beat);
      return result;
    });
  } finally {
    await removePath(dir);
  }
}

/**
 * Checks that an abort signal kills a real hanging `command` child. `start(signal)`
 * starts the call without a time bound and returns its promise. The test aborts
 * only after the shim recorded its pid, so a slow start cannot make the abort
 * precede the child, and the child must be gone once the call returns.
 */
export async function expectAbortKillsShim(command, start) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  try {
    const shim = await writeHangingShim(dir, command);
    return await withShimOnPath(dir, async () => {
      const controller = new AbortController();
      const pending = start(controller.signal);
      const pid = await waitForPid(shim.started, 15_000);
      assert.notEqual(pid, null, "the shim never started");
      controller.abort();
      const result = await returnsWithin(
        pending,
        SHIM_GONE_WINDOW_MS,
        "the call did not return after the abort",
      );
      await assertGone(pid, shim.beat);
      return result;
    });
  } finally {
    await removePath(dir);
  }
}
