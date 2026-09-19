import { expect, test } from "vitest";
import { ExecError, exec } from "../../src/lib/exec.mjs";

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

// Usefulness: verifies best-effort descendant kill when canceling a process tree.
test("exec terminates descendants when canceled", async () => {
  const controller = new AbortController();

  // Child spawns a long-running grandchild and prints grandchild's pid
  const script = `
    const { spawn } = require("node:child_process");
    const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(sub.pid);
  `;

  let grandchildPid = null;
  const promise = exec(process.execPath, ["-e", script], { signal: controller.signal });

  // Give it a moment to spawn and output
  await new Promise((r) => setTimeout(r, 400));
  controller.abort();

  let caughtErr;
  try {
    await promise;
  } catch (err) {
    caughtErr = err;
    const match = err.stdout.trim().match(/(\d+)/);
    if (match) {
      grandchildPid = Number(match[1]);
    }
  }

  expect(caughtErr).toBeInstanceOf(ExecError);
  expect(caughtErr.isCanceled).toBe(true);

  if (grandchildPid) {
    await new Promise((r) => setTimeout(r, 200));
    let isAlive = false;
    try {
      process.kill(grandchildPid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    expect(isAlive).toBe(false);
  }
});
