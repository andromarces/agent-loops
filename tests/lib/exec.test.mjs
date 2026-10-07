import { afterEach, expect, test, vi } from "vite-plus/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecError, SPAWNED_RUN_ENV, exec } from "../../src/lib/exec.mjs";
import { setVerbose } from "../../src/lib/log.mjs";
import { pidAlive } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

afterEach(() => {
  setVerbose(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Usefulness: verifies successful execution returns stdout and stderr.
test("exec returns stdout on successful command", async () => {
  const result = await exec(process.execPath, ["-e", 'console.log("hello")']);
  expect(result.stdout.trim()).toBe("hello");
  expect(result.stderr).toBe("");
});

// Usefulness: verifies stdin input is passed to the process.
test("exec passes input on stdin", async () => {
  const result = await exec(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    input: "stdin data",
  });
  expect(result.stdout).toBe("stdin data");
});

// Usefulness: verifies an env option reaches the child while the parent environment stays inherited.
test("exec merges env into the inherited child environment", async () => {
  const result = await exec(
    process.execPath,
    ["-e", "console.log(process.env.AGENT_LOOP_TEST_ENV, typeof process.env.PATH)"],
    { env: { AGENT_LOOP_TEST_ENV: "set" } },
  );
  expect(result.stdout.trim()).toBe("set string");
});

// Usefulness: verifies only a worker or reviewer spawn carries the run marker, so a headless orchestrator process, whose descendants include a nested parent, never holds it (issue #392).
test("exec marks a worker or reviewer spawn and leaves every other spawn unmarked", async () => {
  vi.stubEnv(SPAWNED_RUN_ENV, "");
  const script = `console.log(process.env.${SPAWNED_RUN_ENV} || "none")`;
  const spawn = async (options) =>
    (await exec(process.execPath, ["-e", script], options)).stdout.trim();
  const worker = await spawn({ role: "worker", cwd: tmpdir() });
  expect(worker).not.toBe("none");
  expect(await spawn({ role: "reviewer", cwd: tmpdir() })).toBe(worker);
  expect(await spawn({ role: "orchestrator", cwd: tmpdir() })).toBe("none");
  expect(await spawn({ cwd: tmpdir() })).toBe("none");
});

// Usefulness: verifies non-zero exit code throws ExecError with fields.
test("exec throws ExecError on failure", async () => {
  await expect(
    exec(process.execPath, ["-e", 'console.error("err_msg"); process.exit(42);']),
  ).rejects.toThrow(ExecError);

  try {
    await exec(process.execPath, ["-e", 'console.error("err_msg"); process.exit(42);']);
  } catch (err) {
    expect(err).toBeInstanceOf(ExecError);
    expect(err.exitCode).toBe(42);
    expect(err.stderr.trim()).toBe("err_msg");
    expect(err.timedOut).toBe(false);
    expect(err.isCanceled).toBe(false);
  }
});

// Usefulness: verifies timeout aborts execution and sets timedOut flag on ExecError.
test("exec sets timedOut when execution exceeds timeout", async () => {
  try {
    await exec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 0.1 });
    expect.unreachable("should have thrown ExecError");
  } catch (err) {
    expect(err).toBeInstanceOf(ExecError);
    expect(err.timedOut).toBe(true);
  }
});

// Usefulness: verifies cancel signal aborts execution and sets isCanceled flag on ExecError.
test("exec sets isCanceled when signal aborts", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  try {
    await exec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      signal: controller.signal,
    });
    expect.unreachable("should have thrown ExecError");
  } catch (err) {
    expect(err).toBeInstanceOf(ExecError);
    expect(err.isCanceled).toBe(true);
  }
});

// Usefulness: verifies a timed-out command names the cause instead of an exit code (issue #20).
test("exec timeout message contains timed out", async () => {
  try {
    await exec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 0.1 });
    expect.unreachable("should have thrown ExecError");
  } catch (err) {
    expect(err.message).toContain("timed out");
    expect(err.message).not.toContain("undefined");
  }
});

// Usefulness: verifies a canceled command names the cause instead of an exit code (issue #20).
test("exec cancel message contains canceled", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  try {
    await exec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      signal: controller.signal,
    });
    expect.unreachable("should have thrown ExecError");
  } catch (err) {
    expect(err.message).toContain("canceled");
    expect(err.message).not.toContain("undefined");
  }
});

// Usefulness: verifies a signal-killed command names the signal instead of
// "exited with code undefined" (issue #20 POSIX case). execa cannot detect
// signal termination on Windows, so this only runs on POSIX.
test.skipIf(process.platform === "win32")(
  "exec terminated message contains signal on POSIX",
  async () => {
    try {
      await exec(process.execPath, [
        "-e",
        "setTimeout(() => process.kill(process.pid, 'SIGKILL'), 100)",
      ]);
      expect.unreachable("should have thrown ExecError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      expect(err.isTerminated).toBe(true);
      expect(err.message).toContain("killed");
      expect(err.message).not.toContain("undefined");
    }
  },
);

// Usefulness: verifies a command that cannot be spawned names the cause
// instead of "exited with code undefined" (issue #40 POSIX case). Windows
// reports exit code 1 for spawn failures, so this only runs on POSIX.
test.skipIf(process.platform === "win32")(
  "exec spawn failure message contains failed to start on POSIX",
  async () => {
    try {
      await exec("definitely-not-a-command-xyz", []);
      expect.unreachable("should have thrown ExecError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      expect(err.isTerminated).toBe(false);
      expect(err.message).toContain("failed to start");
      expect(err.message).not.toContain("undefined");
    }
  },
);

// Usefulness: verifies descendant kill when canceling a process tree.
test("exec terminates descendants when canceled", async () => {
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "agent-loop-exec-"));
  const pidFile = join(dir, "grandchild.pid");

  // On Windows, Node places the direct child's descendants in a job object, so
  // killing the direct child also kills the grandchild. That hides whether
  // execa ran its own tree kill. A detached grandchild opts out of the job
  // object: it survives a plain parent kill, yet taskkill /T still reaches it,
  // so the assertion below fails if descendant termination breaks. On POSIX the
  // grandchild stays in the direct child's process group, which the group
  // signal reaches.
  const grandchildOptions =
    process.platform === "win32"
      ? '{ stdio: "ignore", detached: true, windowsHide: true }'
      : '{ stdio: "ignore" }';

  // Child spawns a long-running grandchild and writes the grandchild pid to a
  // file. The file is the readiness signal: the test knows the descendant
  // exists before it cancels, without guessing at a fixed delay.
  const script = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], ${grandchildOptions});
    writeFileSync(${JSON.stringify(pidFile)}, String(sub.pid));
    setInterval(() => {}, 1000);
  `;

  let grandchildPid = null;
  try {
    const promise = exec(process.execPath, ["-e", script], { signal: controller.signal });

    const spawnDeadline = Date.now() + 5000;
    while (grandchildPid === null && Date.now() < spawnDeadline) {
      grandchildPid = await readPidFile(pidFile);
      if (grandchildPid === null) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    controller.abort();

    let caughtErr;
    try {
      await promise;
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(ExecError);
    expect(caughtErr.isCanceled).toBe(true);
    expect(grandchildPid).not.toBeNull();

    // Descendant termination is dispatched asynchronously (on Windows, taskkill
    // runs without being awaited), so the grandchild can outlive the cancel
    // rejection by more than any fixed delay. Poll to a deadline instead of
    // sampling once, so slow teardown under load does not read as a surviving
    // descendant (issue #221).
    const exitDeadline = Date.now() + 5000;
    while (pidAlive(grandchildPid) && Date.now() < exitDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(pidAlive(grandchildPid)).toBe(false);
  } finally {
    if (grandchildPid !== null && pidAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid);
      } catch {
        // Already gone.
      }
    }
    await removePath(dir);
  }
});

async function readPidFile(path) {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text === "" ? null : Number(text);
  } catch {
    return null;
  }
}

// Usefulness: verifies issue #26 — each agent invocation logs start and successful stop with
// the command name, duration, and exit code at info level.
test("exec logs start and stop with command name, duration, and exit code", async () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  const result = await exec(process.execPath, ["-e", 'console.log("hello")'], {
    role: "reviewer",
  });

  expect(result.stdout.trim()).toBe("hello");
  const lines = logSpy.mock.calls.map((call) => call.join(" "));
  const startLine = lines.find((line) => line.includes("reviewer") && line.includes("node"));
  const stopLine = lines.find((line) => line.includes("reviewer") && line.includes("exit 0"));
  expect(startLine).toBeTruthy();
  expect(stopLine).toMatch(/ms/);
});

// Usefulness: verifies issue #26 — a failing command still produces a terminating invocation
// line at the exec boundary, so no exec caller is left with a start line and no end. The caller
// owns the error level, so this diagnostic detail rides at debug (visible with --verbose).
test("exec logs a debug failure line with duration and cause when the command throws", async () => {
  setVerbose(true);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await expect(
    exec(process.execPath, ["-e", "process.exit(42)"], { role: "reviewer" }),
  ).rejects.toThrow(ExecError);

  const lines = logSpy.mock.calls.map((call) => call.join(" "));
  expect(
    lines.some(
      (line) =>
        line.includes("debug: reviewer:") && line.includes("failed in") && line.includes("code 42"),
    ),
  ).toBe(true);

  setVerbose(false);
  logSpy.mockClear();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    exec(process.execPath, ["-e", "process.exit(42)"], { role: "reviewer" }),
  ).rejects.toThrow(ExecError);
  const outLines = logSpy.mock.calls.map((call) => call.join(" "));
  const errLines = errorSpy.mock.calls.map((call) => call.join(" "));
  expect(outLines.some((line) => line.includes("debug:"))).toBe(false);
  expect(errLines.some((line) => line.includes("debug:"))).toBe(false);
});
