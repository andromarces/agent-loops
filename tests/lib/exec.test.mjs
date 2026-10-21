import { afterEach, expect, test, vi } from "vite-plus/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecError, SPAWNED_RUN_ENV, exec } from "../../src/lib/exec.mjs";
import { setVerbose } from "../../src/lib/log.mjs";
import { pidAlive } from "../../src/lib/process-identity.mjs";
import { sessionRecordsRoot } from "../../src/lib/session-record.mjs";
import { stateRoot } from "../../src/lib/runstate.mjs";
import { slotsRoot } from "../../src/lib/test-slot.mjs";
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

const ROOT_ENV = [
  "AGENT_LOOP_RUNS_ROOT",
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_SESSION_RECORDS_ROOT",
];
const PRINT_ROOTS = `console.log(JSON.stringify(${JSON.stringify(ROOT_ENV)}.map((name) => process.env[name] || null)))`;
const rootsOf = async (options) =>
  JSON.parse((await exec(process.execPath, ["-e", PRINT_ROOTS], options)).stdout);

// Usefulness: verifies a worker or reviewer child gets the three machine-wide roots that the parent resolves, so no adapter leaves them to a child `TMP` override (issue #970); other spawns stay unpinned.
test("exec pins the machine-wide roots for a worker or reviewer spawn only", async () => {
  for (const name of ROOT_ENV) vi.stubEnv(name, "");
  const parent = [stateRoot(), slotsRoot(), sessionRecordsRoot()];
  expect(await rootsOf({ role: "worker", cwd: tmpdir() })).toEqual(parent);
  expect(await rootsOf({ role: "reviewer", cwd: tmpdir() })).toEqual(parent);
  expect(await rootsOf({ role: "orchestrator", cwd: tmpdir() })).toEqual([null, null, null]);
  expect(await rootsOf({ cwd: tmpdir() })).toEqual([null, null, null]);
});

// Usefulness: verifies a user-set root wins over the parent resolved path in a worker child.
test("exec keeps a user-set root for a worker spawn", async () => {
  for (const name of ROOT_ENV) vi.stubEnv(name, "");
  vi.stubEnv("AGENT_LOOP_TEST_SLOTS_ROOT", join(tmpdir(), "mine"));
  const [runs, slots] = await rootsOf({ role: "worker", cwd: tmpdir() });
  expect(slots).toBe(join(tmpdir(), "mine"));
  expect(runs).toBe(stateRoot());
});

// Usefulness: verifies a worker child that moves TMP, TEMP, and TMPDIR still resolves the slot directory of the parent.
test("a worker child that overrides TMP resolves the parent slot directory", async () => {
  vi.stubEnv("AGENT_LOOP_TEST_SLOTS_ROOT", "");
  const other = await mkdtemp(join(tmpdir(), "other-tmp-"));
  try {
    const script = `
const slots = ${JSON.stringify(new URL("../../src/lib/test-slot.mjs", import.meta.url).href)};
for (const name of ["TMP", "TEMP", "TMPDIR"]) process.env[name] = ${JSON.stringify(other)};
const { slotsRoot } = await import(slots);
console.log(slotsRoot());`;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
      role: "worker",
      cwd: tmpdir(),
    });
    expect(stdout.trim()).toBe(slotsRoot());
  } finally {
    await removePath(other);
  }
});

// Usefulness: verifies an empty root value counts as unset and is replaced, because the root readers fall back to the `os.tmpdir()` default for it and a kept empty value would let a child `TMP` override move the root.
test("exec replaces an empty root value for a worker spawn", async () => {
  for (const name of ROOT_ENV) vi.stubEnv(name, "");
  const parent = [stateRoot(), slotsRoot(), sessionRecordsRoot()];
  const seen = await rootsOf({ role: "worker", cwd: tmpdir(), env: {} });
  expect(seen).toEqual(parent);
  expect(seen.every(Boolean)).toBe(true);
});

const NPM_LOG_NAME = /^npm_config_logs[_-](dir|max)$/i;
const PRINT_NPM_LOG = `console.log(JSON.stringify(Object.entries(process.env).filter(([name]) => ${NPM_LOG_NAME}.test(name)).map(([name, value]) => [name.toLowerCase(), value])))`;
// The npm log settings that the child sees, names lower-cased and repeats dropped.
const npmLogOf = async (options) => {
  const seen = JSON.parse((await exec(process.execPath, ["-e", PRINT_NPM_LOG], options)).stdout);
  return [...new Set(seen.map((entry) => JSON.stringify(entry)))].map((entry) => JSON.parse(entry));
};
const clearNpmLog = () => {
  for (const name of Object.keys(process.env).filter((key) => NPM_LOG_NAME.test(key))) {
    vi.stubEnv(name, undefined);
  }
};
const OFF = [["npm_config_logs_max", "0"]];

// Usefulness: verifies a worker or reviewer child writes no npm debug log outside its own directories, so the cleanup rule has no log to delete (issue #995); other spawns stay unchanged.
test("exec turns npm debug logs off for a worker or reviewer spawn only", async () => {
  clearNpmLog();
  expect(await npmLogOf({ role: "worker", cwd: tmpdir() })).toEqual(OFF);
  expect(await npmLogOf({ role: "reviewer", cwd: tmpdir() })).toEqual(OFF);
  expect(await npmLogOf({ role: "orchestrator", cwd: tmpdir() })).toEqual([]);
  expect(await npmLogOf({ cwd: tmpdir() })).toEqual([]);
});

// Usefulness: verifies an empty inherited value of any spelling counts as unset, so the default still takes effect and no second spelling reaches npm to conflict with it.
test("exec replaces an empty npm log setting of any spelling with the default", async () => {
  clearNpmLog();
  vi.stubEnv("NPM_CONFIG_LOGS_MAX", "");
  vi.stubEnv("Npm_Config_Logs_Dir", "");
  expect(await npmLogOf({ role: "worker", cwd: tmpdir() })).toEqual(OFF);
  expect(
    await npmLogOf({ role: "worker", cwd: tmpdir(), env: { npm_config_logs_dir: "" } }),
  ).toEqual(OFF);
});

// Usefulness: verifies a user-set log directory or maximum is kept in any case, from the environment or the caller, and that a user-set directory is not switched off by the default.
test("exec keeps a user-set npm log directory or maximum for a worker spawn", async () => {
  clearNpmLog();
  const dir = join(tmpdir(), "npm-logs");
  expect(
    await npmLogOf({ role: "worker", cwd: tmpdir(), env: { npm_config_logs_dir: dir } }),
  ).toEqual([["npm_config_logs_dir", dir]]);
  expect(
    await npmLogOf({ role: "reviewer", cwd: tmpdir(), env: { Npm_Config_Logs_Max: "5" } }),
  ).toEqual([["npm_config_logs_max", "5"]]);
  vi.stubEnv("Npm_Config_Logs_Dir", dir);
  expect(await npmLogOf({ role: "worker", cwd: tmpdir() })).toEqual([["npm_config_logs_dir", dir]]);
});
