import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { exec, execBounded } from "../../src/lib/exec.mjs";

afterEach(() => vi.useRealTimers());

// A child that no kill ends: its promise never settles and no exit event arrives.
function stuckChild() {
  const never = new Promise(() => {});
  const subprocess = {
    pid: 4242,
    kill: vi.fn(() => true),
    nodeChildProcess: new EventEmitter(),
    // oxlint-disable-next-line unicorn/no-thenable -- execa returns a thenable subprocess
    then: (...callbacks) => never.then(...callbacks),
    catch: (...callbacks) => never.catch(...callbacks),
    finally: (...callbacks) => never.finally(...callbacks),
  };
  execa.mockReturnValue(subprocess);
  return subprocess;
}

// Usefulness: a child that survives the timeout kill (stuck in the kernel) must not hold the call.
// It must not hold the state lock or the lifecycle forever either (issue #1302).
test("exec rejects with timedOut when the child outlives the timeout kill", async () => {
  vi.useFakeTimers();
  stuckChild();
  const outcome = exec("codex", [], { timeout: 5 }).catch((err) => err);
  await vi.advanceTimersByTimeAsync(5_000 + 60_000);
  const failure = await outcome;
  expect(failure.timedOut).toBe(true);
  expect(failure.message).toContain("timed out after 5 seconds");
});

// Usefulness: the bounded runner shares the guarantee, so a stuck probe never hangs a lock acquisition.
test("execBounded resolves with timedOut when the child outlives the timeout kill", async () => {
  vi.useFakeTimers();
  stuckChild();
  const outcome = execBounded("powershell", [], { timeoutMs: 5000 });
  await vi.advanceTimersByTimeAsync(5_000 + 60_000);
  expect((await outcome).timedOut).toBe(true);
});

// Usefulness: a cancel ends the call even when the child ignores the kill.
test("exec rejects with isCanceled when the child outlives the cancel kill", async () => {
  vi.useFakeTimers();
  stuckChild();
  const controller = new AbortController();
  const outcome = exec("codex", [], { signal: controller.signal }).catch((err) => err);
  controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await outcome).isCanceled).toBe(true);
});

// Usefulness: a spawn double that returns a plain result, as the CLI tests do, still reaches the caller.
test("exec and execBounded pass a plain spawn result through", async () => {
  execa.mockReturnValue({ exitCode: 0, stdout: "out", stderr: "" });
  expect((await exec("git", [])).stdout).toBe("out");
  expect((await execBounded("git", [], { timeoutMs: 1000 })).stdout).toBe("out");
});

// Usefulness: a pipe that a paused reader has not drained is never cut. An idle open pipe of an
// exited child gets the group kill and the end of the read (review of PR #1306).
test("exec cuts an idle open pipe of an exited child and spares a paused one", async () => {
  vi.useFakeTimers();
  const subprocess = stuckChild();
  const pipe = new Socket();
  subprocess.nodeChildProcess.stdout = pipe;
  pipe.resume();
  pipe.pause();
  const outcome = exec("codex", []);
  subprocess.nodeChildProcess.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(subprocess.kill).not.toHaveBeenCalled();
  pipe.resume();
  await vi.advanceTimersByTimeAsync(3000);
  expect(subprocess.kill).toHaveBeenCalledWith("SIGKILL");
  await vi.advanceTimersByTimeAsync(0);
  expect(pipe.readableEnded).toBe(true);
  pipe.destroy();
  outcome.catch(() => {});
});
