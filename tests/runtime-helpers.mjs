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

// The hanging child is a `node` process on every platform, launched by a wrapper
// that stays alive as its parent (`.cmd` on Windows, `sh` with a background job
// and `wait` elsewhere, so the shell never execs into node). A kill that reaches
// only the wrapper leaves the node process running.
//
// These helpers prove termination only. The bound value is proved without a
// clock by tests/lib/spawn-bounds.test.mjs, so every wait here is a generous
// ceiling that load cannot reach, and none of them measures the bound.
const SHIM_HANG_MS = 60_000;
// The longest a call may take to return, and a kill to land, once the bound or
// the abort has fired. A survivor is still running when either ceiling ends.
const SHIM_CEILING_MS = 10_000;

/**
 * Writes a `command` shim into `dir` that hangs, so a kill is exercised against
 * a real child process. The long-lived node process records its own pid in
 * `started`, then exits by itself after SHIM_HANG_MS.
 */
async function writeHangingShim(dir, command) {
  const started = join(dir, "started.txt");
  const script = join(dir, "hang.js");
  await writeFile(
    script,
    `require("fs").writeFileSync(${JSON.stringify(started)}, String(process.pid));
setTimeout(() => {}, ${SHIM_HANG_MS});
`,
  );
  if (process.platform === "win32") {
    await writeFile(join(dir, `${command}.cmd`), `@echo off\r\nnode "${script}"\r\n`);
  } else {
    await writeFile(join(dir, command), `#!/bin/sh\nnode '${script}' &\nwait\n`, { mode: 0o755 });
  }
  return { started };
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

// `kill(pid, 0)` sends no signal. It throws ESRCH once the process is gone, on
// POSIX and on Windows (where Node reports an exited process as ESRCH).
// known-limit: the OS may hand the pid to another process inside the window, which
// reads as alive and fails the test; the window is seconds, so reuse is not a
// practical risk.
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function assertGone(pid) {
  const deadline = Date.now() + SHIM_CEILING_MS;
  while (processExists(pid) && Date.now() < deadline) {
    await delay(50);
  }
  assert.ok(!processExists(pid), `the shim child ${pid} survived the cancellation`);
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
 * Checks that a time bound kills a real hanging `command` child. `run(boundMs)`
 * starts the bounded call and resolves when it returns. The call must return
 * within `boundMs` plus SHIM_CEILING_MS, and the node process the shim recorded
 * must be gone within a further SHIM_CEILING_MS. The child must have started
 * before the call returned, or the test fails: a child that never ran proves
 * nothing about the kill, so `boundMs` must leave the shim time to start on a
 * loaded machine. That value is not what is under test here. Returns the call
 * result.
 */
export async function expectBoundKillsShim(command, run, boundMs = 2000) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  try {
    const shim = await writeHangingShim(dir, command);
    return await withShimOnPath(dir, async () => {
      const result = await returnsWithin(
        run(boundMs),
        boundMs + SHIM_CEILING_MS,
        "the call did not return after its bound",
      );
      // The record was written before the bound expired, so a short wait only
      // covers file visibility.
      const pid = await waitForPid(shim.started, 500);
      assert.notEqual(pid, null, `the shim did not start within the ${boundMs} ms bound`);
      await assertGone(pid);
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
      const pid = await waitForPid(shim.started, SHIM_CEILING_MS);
      assert.notEqual(pid, null, "the shim never started");
      controller.abort();
      const result = await returnsWithin(
        pending,
        SHIM_CEILING_MS,
        "the call did not return after the abort",
      );
      await assertGone(pid);
      return result;
    });
  } finally {
    await removePath(dir);
  }
}
