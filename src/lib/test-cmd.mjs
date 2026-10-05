import { execa } from "execa";
import { readProp } from "./error-message.mjs";
import { logInfo } from "./log.mjs";
import { redactEnvSecrets } from "./redact.mjs";
import { diffSnapshots, snapshot } from "./snapshot.mjs";

// ADR 0017. The command is the operator's `--test-cmd`, run by the runtime in
// the run's work tree before each reviewer turn, outside every CLI sandbox.
export const DEFAULT_TEST_CMD_TIMEOUT_SECONDS = 600;
// Bytes kept while the command runs: twice the tail the reviewer sees, so a
// secret cut at the left edge of the window never reaches the final tail.
const CAPTURE_WINDOW_BYTES = 16 * 1024;
export const TAIL_CHARS = 8 * 1024;

// Results carried by an error object that cannot take the `testRun` property.
const carriedTestRuns = new WeakMap();

/**
 * Carries the result on a fatal error as `err.testRun`. A frozen error or a throwing setter
 * keeps the original error, and the result stays readable through `failedTestRun`.
 */
export function carryTestRun(err, testRun) {
  carriedTestRuns.set(err, testRun);
  try {
    err.testRun = testRun;
  } catch {}
}

/** Returns the result a fatal error carries, or `undefined` when it carries none. */
export function failedTestRun(err) {
  return carriedTestRuns.get(err) ?? readProp(err, "testRun");
}
const MAX_CHANGED_PATHS = 20;
// Control characters other than newline and tab never help a reviewer and can
// hide text in a terminal, so they are dropped.
function stripControl(text) {
  return [...text.replaceAll("\r\n", "\n")]
    .filter((c) => c === "\n" || c === "\t" || c >= " ")
    .join("");
}

/**
 * The command text as every output shows it (ADR 0017): secret-named environment values
 * redacted and control characters removed. The runtime runs the original text.
 * @param {string} command
 */
export function redactCommandText(command) {
  return stripControl(redactEnvSecrets(command));
}

/**
 * Kills what the runtime owns and nothing else. execa starts the command as the
 * leader of a process group of its own on POSIX, so SIGKILL to that group reaches
 * the command and the descendants and orphans that stayed in the group. On Windows
 * execa runs `taskkill /T /F`, which walks the parent links of the command. The
 * runtime never signals a process by name, by environment, or by a host-wide scan.
 * Approved limit (maintainer, 2026-10-04, ADR 0017): an orphan that left the group,
 * for example through `setsid`, survives on POSIX, and an orphan whose parent
 * exited survives on Windows. Neither Node nor execa exposes a Windows job object.
 */
function killTree(subprocess) {
  subprocess.kill("SIGKILL");
}

/**
 * Runs `command` through the platform shell (`/bin/sh -c` on POSIX, `cmd.exe`
 * on Windows) in `cwd`, so the command is written in the syntax of the shell
 * that runs it and the runtime adds no quoting. The command and its child
 * processes are killed when the bound expires, which reports `timed-out` with
 * `exitCode: null`, whatever code the killed command exited with. The kill reaches
 * the process group of the command on POSIX and its tree on Windows only: an orphan
 * that left the group, or whose parent exited on Windows, can survive (ADR 0017).
 * Output is read as a rolling window, so a noisy command cannot exhaust memory.
 * The work tree is compared before and after the command; the caller takes its
 * reviewer snapshot after this returns, so the changes are reported here and are
 * not a mutation by the reviewer. A snapshot failure throws. A cancel kills the
 * tree, takes the same after snapshot, and throws an error with `isCanceled` and the
 * result, `status: "canceled"`, as `testRun`, so a write made before the cancel is
 * reported. Every other failure of the command is a result.
 * @param {{ command: string, timeoutSeconds?: number, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<object>} the advisory result: `status` is `pass`, `fail`, `timed-out`, `error`, or `canceled` (thrown)
 */
export async function runTestCmd({
  command,
  timeoutSeconds = DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
  cwd,
  signal,
}) {
  const before = await snapshot(cwd);
  const startedAt = Date.now();
  logInfo(`test command started (bound ${timeoutSeconds}s)`);

  const subprocess = execa(command, {
    cwd,
    shell: true,
    reject: false,
    stdin: "ignore",
    all: true,
    buffer: false,
    cleanup: true,
    killDescendants: true,
  });
  // The runtime owns the bound and the cancel. Both kill the process group of the command on
  // POSIX and its tree on Windows, and an orphan that left it can survive (ADR 0017).
  let timedOut = false;
  let canceled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(subprocess);
  }, timeoutSeconds * 1000);
  const onAbort = () => {
    canceled = true;
    killTree(subprocess);
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  let window = Buffer.alloc(0);
  let total = 0;
  subprocess.all.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    window = Buffer.concat([window, bytes]);
    if (window.length > CAPTURE_WINDOW_BYTES * 2) {
      window = window.subarray(window.length - CAPTURE_WINDOW_BYTES);
    }
  });
  let result;
  try {
    result = await subprocess;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const durationMs = Date.now() - startedAt;

  const after = await snapshot(cwd);
  const changed = diffSnapshots(before, after);

  const text = stripControl(
    redactEnvSecrets(window.subarray(-CAPTURE_WINDOW_BYTES).toString("utf8")),
  );
  const truncated = total > CAPTURE_WINDOW_BYTES || text.length > TAIL_CHARS;
  const tail = text.slice(-TAIL_CHARS);

  const exitCode =
    !timedOut && !canceled && typeof result.exitCode === "number" ? result.exitCode : null;
  let status;
  let summary;
  if (canceled) {
    status = "canceled";
    summary =
      "canceled before the command finished; the runtime killed the command's own process group on POSIX or its process tree on Windows, and an orphan that left it can survive";
  } else if (timedOut) {
    status = "timed-out";
    summary = `timed out after ${timeoutSeconds} seconds; the runtime killed the command's own process group on POSIX or its process tree on Windows, and an orphan that left it can survive; this is neither a pass nor a failure`;
  } else if (exitCode === null) {
    status = "error";
    summary = `did not run to an exit code${result.signal ? ` (signal ${result.signal})` : ""}`;
  } else {
    status = exitCode === 0 ? "pass" : "fail";
    summary = `exit ${exitCode}`;
  }
  logInfo(`test command finished in ${durationMs}ms: ${status}`);

  const testRun = {
    command: redactCommandText(command),
    status,
    exitCode,
    timedOut,
    durationMs,
    summary,
    outputBytes: total,
    truncated,
    tail,
    workTreeChanged: changed.length > 0,
    changedPaths: changed.slice(0, MAX_CHANGED_PATHS),
    changedCount: changed.length,
    advisory: true,
  };
  if (canceled) {
    const err = new Error("test command canceled");
    err.isCanceled = true;
    err.testRun = testRun;
    throw err;
  }
  return testRun;
}
