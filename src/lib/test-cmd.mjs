import { entryCarrier } from "./entry-report.mjs";
import { readProp } from "./error-message.mjs";
import { execBounded } from "./exec.mjs";
import { logError, logInfo, logWarn } from "./log.mjs";
import { redactAndClean } from "./redact.mjs";
import { beginEvidenceRead, forceCancelSignal } from "./sigint.mjs";
import { diffSnapshots, snapshot } from "./snapshot.mjs";
import { holdTestSlot, testSlotOptions } from "./test-slot.mjs";

// ADR 0017. The command is the operator's `--test-cmd`, run by the runtime in
// the run's work tree before each reviewer turn, outside every CLI sandbox.
export const DEFAULT_TEST_CMD_TIMEOUT_SECONDS = 600;

/** The `runChild` test-command input, or null when the run has no `--test-cmd`. */
export const testCmdInput = (command, timeoutSeconds) =>
  command === null
    ? null
    : { command, timeoutSeconds: timeoutSeconds ?? DEFAULT_TEST_CMD_TIMEOUT_SECONDS };
// Bytes kept while the command runs: twice the tail the reviewer sees, so a
// secret cut at the left edge of the window never reaches the final tail.
const CAPTURE_WINDOW_BYTES = 16 * 1024;
export const TAIL_CHARS = 8 * 1024;

const testRunCarrier = entryCarrier("testRun");

/**
 * Carries the result on a fatal error as `err.testRun`. A frozen error or a throwing setter
 * keeps the original error, and the result stays readable through `failedTestRun`.
 */
export const carryTestRun = testRunCarrier.carry;

/**
 * Returns the result a fatal error carries, or `undefined` when it carries none. The property
 * fallback reads a result that `canceledError` sets directly, which `carry` never recorded.
 */
export const failedTestRun = (err) => testRunCarrier.failed(err) ?? readProp(err, "testRun");
// The clause of a canceled or timed-out summary that states what the kill reaches.
const KILL_CLAUSE =
  "the runtime killed the command's own process group on POSIX or its process tree on Windows, and an orphan that left it can survive";
const MAX_CHANGED_PATHS = 20;
// The bound and the redaction that every reported path list gets, as the output text gets them.
const boundedPaths = (paths) => paths.slice(0, MAX_CHANGED_PATHS).map(redactAndClean);

// The after-command snapshot of each result, kept off the result so it never reaches an output.
const finalSnapshots = new WeakMap();
// Results of a command that never ran, which have no late change to report.
const notRun = new WeakSet();

/**
 * Reports the paths that differ between the after-command snapshot and the reviewer baseline as
 * `testRun.lateChangedPaths`, at most 20 and redacted like `changedPaths`: a write by a process
 * that the command left behind, made between the two snapshots, which the baseline absorbs. The
 * field is `null` when a second cancel ended the after-command snapshot. A turn that takes no
 * baseline, for example a cancel before it, never calls this, and a command that never ran
 * reports none, so the field is absent. The report is advisory and never fails the turn.
 */
export function reportLateChangedPaths(testRun, baseline) {
  if (notRun.has(testRun)) return;
  const final = finalSnapshots.get(testRun);
  testRun.lateChangedPaths = final ? boundedPaths(diffSnapshots(final, baseline)) : null;
}
// The error that a canceled run throws, which carries the advisory `canceled` result.
function canceledError(testRun) {
  const err = new Error("test command canceled");
  err.isCanceled = true;
  err.testRun = testRun;
  return err;
}

// The advisory result of a command that never ran: every output field is empty. A run that ran
// overrides the output fields.
function baseTestRun(command, status, durationMs, summary) {
  return {
    command: redactAndClean(command),
    status,
    exitCode: null,
    timedOut: false,
    durationMs,
    summary,
    outputBytes: 0,
    truncated: false,
    tail: "",
    workTreeChanged: false,
    changedPaths: [],
    changedCount: 0,
    advisory: true,
  };
}

// The advisory result of a command that the runtime did not start (ADR 0040).
function notRunResult(command, status, summary, durationMs) {
  const testRun = baseTestRun(command, status, durationMs, summary);
  notRun.add(testRun);
  return testRun;
}

/**
 * Holds a machine-wide test slot for one run of the command (ADR 0040). The wait has its own
 * bound, `AGENT_LOOP_TEST_SLOT_WAIT` or 1800 s, before `timeoutSeconds` starts. Returns the slot,
 * or a result for a command that did not run: `slot-timeout` at the wait bound, and `error` when
 * the slot cannot be acquired, so the command never runs unthrottled. A cancel during the wait
 * throws a cancel error that carries a `canceled` result, with no slot held.
 */
async function holdSlotFor(command, signal) {
  const startedAt = Date.now();
  let options;
  let slot;
  try {
    options = testSlotOptions();
    slot = await holdTestSlot({ ...options, signal: signal ?? new AbortController().signal });
  } catch (err) {
    const reason = redactAndClean(err?.message ?? String(err));
    logError(`test slot acquisition failed; the test command did not run: ${reason}`);
    return {
      testRun: notRunResult(
        command,
        "error",
        `the command did not run, because the test slot could not be acquired: ${reason}`,
        Date.now() - startedAt,
      ),
    };
  }
  if (slot !== null) {
    return { slot };
  }
  const durationMs = Date.now() - startedAt;
  if (signal?.aborted) {
    throw canceledError(
      notRunResult(
        command,
        "canceled",
        "canceled while the command waited for a test slot; the command did not run",
        durationMs,
      ),
    );
  }
  logWarn(`no test slot won within ${options.waitSeconds}s; the test command did not run`);
  return {
    testRun: notRunResult(
      command,
      "slot-timeout",
      `the command did not run, because no test slot was free within ${options.waitSeconds} seconds; this is neither a pass nor a failure`,
      durationMs,
    ),
  };
}

/**
 * Runs `command` inside a machine-wide test slot (ADR 0040): a command that cannot win a slot
 * does not run, and its result is `slot-timeout` or `error` (see `holdSlotFor`). With the slot held,
 * runs `command` through the platform shell (`/bin/sh -c` on POSIX, `cmd.exe`
 * on Windows) in `cwd`, so the command is written in the syntax of the shell
 * that runs it and the runtime adds no quoting. The command and its child
 * processes are killed when the bound expires, which reports `timed-out` with
 * `exitCode: null`, whatever code the killed command exited with. A command that
 * no kill ends settles 10 s after the bound or the cancel. The kill reaches
 * the process group of the command on POSIX and its tree on Windows only: an orphan
 * that left the group, or whose parent exited on Windows, can survive (ADR 0017).
 * Output is read as a rolling window, so a noisy command cannot exhaust memory.
 * The work tree is compared before and after the command; the caller takes its
 * reviewer snapshot after this returns, so the changes are reported here and are
 * not a mutation by the reviewer. A snapshot failure throws. A cancel kills the
 * tree, takes the same after snapshot, and throws an error with `isCanceled` and the
 * result, `status: "canceled"`, as `testRun`, so a write made before the cancel is
 * reported. Every other failure of the command is a result.
 * `forceSignal` (default: the second-SIGINT signal of `signal`) ends the after-command snapshot. The
 * result then keeps the status of the command as it completed, and `workTreeChanged` and
 * `changedCount` are `null`, which means not captured.
 * @param {{ command: string, timeoutSeconds?: number, cwd: string, signal?: AbortSignal, forceSignal?: AbortSignal }} options
 * @returns {Promise<object>} the advisory result: `status` is `pass`, `fail`, `timed-out`, `slot-timeout`, `error`, or `canceled` (thrown)
 */
export async function runTestCmd({
  command,
  timeoutSeconds = DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
  cwd,
  signal,
  forceSignal = forceCancelSignal(signal),
}) {
  const { slot, testRun: notStarted } = await holdSlotFor(command, signal);
  if (notStarted) {
    return notStarted;
  }
  try {
    return await runInSlot({ command, timeoutSeconds, cwd, signal, forceSignal, env: slot.env });
  } finally {
    // A failed release never replaces the result or the cancel of the command. The slot then stays
    // held until this process exits, when the stale-owner rules reclaim it.
    await slot.release().catch((err) => {
      logError(`test slot release failed: ${redactAndClean(err?.message ?? String(err))}`);
    });
  }
}

async function runInSlot({ command, timeoutSeconds, cwd, signal, forceSignal, env }) {
  const before = await snapshot(cwd, { signal });
  const startedAt = Date.now();
  logInfo(`test command started (bound ${timeoutSeconds}s)`);

  const subprocess = execBounded(command, [], {
    cwd,
    env,
    shell: true,
    stdin: "ignore",
    all: true,
    buffer: false,
    // The runtime sends the immediate SIGKILL to the group at the bound or on the cancel.
    // `killBound` arms the settle bound of `execBounded` from the same timeout and cancel,
    // so a command that no kill ends settles 10 s later (issue #1307).
    killBound: { timeoutMs: timeoutSeconds * 1000, signal },
  });
  // The runtime owns the bound and the cancel, and kills what it owns and nothing else. execa
  // starts the command as the leader of a process group of its own on POSIX, so SIGKILL to that
  // group reaches the command and the descendants and orphans that stayed in the group. On Windows
  // execa runs `taskkill /T /F`, which walks the parent links of the command. The runtime never
  // signals a process by name, by environment, or by a host-wide scan.
  // Approved limit (maintainer, 2026-10-04, ADR 0017): an orphan that left the group, for example
  // through `setsid`, survives on POSIX, and an orphan whose parent exited survives on Windows.
  // Neither Node nor execa exposes a Windows job object.
  let timedOut = false;
  let canceled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    subprocess.kill("SIGKILL");
  }, timeoutSeconds * 1000);
  const onAbort = () => {
    canceled = true;
    subprocess.kill("SIGKILL");
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

  // The cancel is already set when it ended the command, and the changed paths are its evidence,
  // so this read ignores it. Only `forceSignal`, the second cancel, ends it. The change is then
  // unknown (`null`), never "none".
  let changed = null;
  let finalSnapshot = null;
  const endEvidenceRead = beginEvidenceRead(forceSignal);
  try {
    finalSnapshot = await snapshot(cwd, { signal: forceSignal });
    changed = diffSnapshots(before, finalSnapshot);
  } catch (err) {
    if (!err?.isCanceled) {
      throw err;
    }
  } finally {
    endEvidenceRead();
  }

  const text = redactAndClean(window.subarray(-CAPTURE_WINDOW_BYTES).toString("utf8"));
  const truncated = total > CAPTURE_WINDOW_BYTES || text.length > TAIL_CHARS;
  const tail = text.slice(-TAIL_CHARS);

  const exitCode =
    !timedOut && !canceled && typeof result.exitCode === "number" ? result.exitCode : null;
  let status;
  let summary;
  if (canceled) {
    status = "canceled";
    summary = `canceled before the command finished; ${KILL_CLAUSE}`;
  } else if (timedOut) {
    status = "timed-out";
    summary = `timed out after ${timeoutSeconds} seconds; ${KILL_CLAUSE}; this is neither a pass nor a failure`;
  } else if (exitCode === null) {
    status = "error";
    summary = `did not run to an exit code${result.signal ? ` (signal ${result.signal})` : ""}`;
  } else {
    status = exitCode === 0 ? "pass" : "fail";
    summary = `exit ${exitCode}`;
  }
  // Only the evidence is lost. The status above is the result of the command as it completed.
  if (changed === null) {
    summary += "; the work tree change was not captured, because a second cancel ended the read";
  }
  logInfo(`test command finished in ${durationMs}ms: ${status}`);

  const testRun = {
    ...baseTestRun(command, status, durationMs, summary),
    exitCode,
    timedOut,
    outputBytes: total,
    truncated,
    tail,
    workTreeChanged: changed === null ? null : changed.length > 0,
    changedPaths: boundedPaths(changed ?? []),
    changedCount: changed?.length ?? null,
  };
  if (finalSnapshot) {
    finalSnapshots.set(testRun, finalSnapshot);
  }
  if (canceled) {
    throw canceledError(testRun);
  }
  return testRun;
}
