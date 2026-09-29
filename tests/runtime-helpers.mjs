import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * Writes a `command` shim into `dir` that hangs, so a bound is exercised against
 * a real child process. The shim records its own pid in `started` when it runs,
 * and writes `alive` only if it lives `hangMs`. The shim is a `.cmd` on Windows
 * and an executable shell script elsewhere, which is what `git` and `gh` resolve
 * to on each platform.
 */
async function writeHangingShim(dir, command, hangMs) {
  const started = join(dir, "started.txt");
  const alive = join(dir, "alive.txt");
  if (process.platform === "win32") {
    const fwd = (path) => path.split("\\").join("/");
    await writeFile(
      join(dir, `${command}.cmd`),
      `@echo off\r\nnode -e "require('fs').writeFileSync('${fwd(started)}',String(process.pid));setTimeout(function(){require('fs').writeFileSync('${fwd(alive)}','x')},${hangMs})"\r\n`,
    );
  } else {
    await writeFile(
      join(dir, command),
      `#!/bin/sh\necho $$ > '${started}'\nsleep ${hangMs / 1000}\ntouch '${alive}'\n`,
      { mode: 0o755 },
    );
  }
  return { started, alive };
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

async function assertGone(pids, alive) {
  const deadline = Date.now() + 5000;
  for (const pid of pids) {
    while (processExists(pid) && Date.now() < deadline) {
      await delay(50);
    }
    assert.ok(!processExists(pid), `the shim child ${pid} survived the cancellation`);
  }
  await assert.rejects(readFile(alive), "the shim child outlived its hang and wrote its marker");
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
 * Checks that a time bound kills a real hanging `command` child. `run(timeoutMs)`
 * starts the bounded call and must resolve once the call returns.
 *
 * The verdict rests on the child's recorded pid, not on a wall-clock window: a
 * child that starts late under load still writes its pid, and the test fails if
 * that pid outlives the call. A call that returns before the shim started is
 * inconclusive, because the bound may have killed the launcher first, so the run
 * repeats with the next, longer bound and fails if no bound is conclusive.
 * Returns the result of the conclusive call.
 */
export async function expectBoundKillsShim(
  command,
  run,
  { hangMs = 20_000, bounds = [300, 2000, 5000] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  const shims = [];
  try {
    for (const [index, bound] of bounds.entries()) {
      const dir = join(root, String(index));
      await mkdir(dir);
      const shim = await writeHangingShim(dir, command, hangMs);
      shims.push(shim);
      const result = await withShimOnPath(dir, async () => {
        const began = Date.now();
        const returned = await run(bound);
        assert.ok(Date.now() - began < hangMs, "the call waited for the hanging child");
        return returned;
      });
      // Inconclusive until the shim shows it ran. A survivor that starts late
      // shows here too, and its pid is checked with the rest.
      if ((await waitForPid(shim.started, 1500)) !== null) {
        const pids = [];
        for (const seen of shims) {
          const pid = await waitForPid(seen.started, 0);
          if (pid !== null) {
            pids.push(pid);
          }
        }
        await assertGone(pids, shim.alive);
        return result;
      }
    }
    assert.fail(`the shim never started before any bound of ${bounds.join(", ")} ms`);
  } finally {
    await removePath(root);
  }
}

/**
 * Checks that an abort signal kills a real hanging `command` child. `start(signal)`
 * starts the call without a time bound and returns its promise. The test aborts
 * only after the shim recorded its pid, so a slow start cannot make the abort
 * precede the child, and the pid must be gone once the call returns.
 */
export async function expectAbortKillsShim(command, start, { hangMs = 20_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  try {
    const shim = await writeHangingShim(dir, command, hangMs);
    return await withShimOnPath(dir, async () => {
      const controller = new AbortController();
      const pending = start(controller.signal);
      const pid = await waitForPid(shim.started, 15_000);
      assert.notEqual(pid, null, "the shim never started");
      controller.abort();
      const result = await pending;
      await assertGone([pid], shim.alive);
      return result;
    });
  } finally {
    await removePath(dir);
  }
}
