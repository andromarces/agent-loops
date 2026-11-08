// `agent-loop harness-check`: verifies that the named harness is the nearest ancestor process, so a
// run starts only from the shell that owns it (#151). It installs nothing.
import { readableErrorText, readProp } from "./lib/error-message.mjs";
import { logError } from "./lib/log.mjs";
import { nearestHarness } from "./lib/process-ancestry.mjs";
import { harnessForCommand, isHarness } from "./lib/harnesses.mjs";

/**
 * Exit code for a harness mismatch: the named harness is not the nearest
 * ancestor, so another harness owns the shell. Exit 0 means the names match;
 * every other non-zero code means the check could not run, found no harness
 * ancestor, or could not read the process ancestry. The distinct code lets a
 * caller separate a genuine harness refusal from a check that did not decide
 * (#151).
 */
export const HARNESS_MISMATCH_EXIT = 3;

/**
 * Runs `agent-loop harness-check` for the named harness. It sets exit code 0 on a match and 1 when
 * the check cannot run or finds no harness ancestor. A mismatch sets 3, and a cancel sets 130.
 */
export async function runHarnessCheckCommand(argv, { lookup = nearestHarness, signal } = {}) {
  const requested = argv[0];
  if (!requested) {
    logError("harness-check requires a harness name.");
    process.exitCode = 1;
    return;
  }
  const harness = harnessForCommand(requested) ?? requested;
  if (!isHarness(harness)) {
    logError(`Unknown harness: ${requested}`);
    process.exitCode = 1;
    return;
  }

  let found;
  try {
    found = await lookup({ signal });
  } catch (err) {
    if (readProp(err, "isCanceled")) {
      logError("harness-check was canceled.");
      process.exitCode = 130;
      return;
    }
    logError(`could not read the process table: ${readableErrorText(err)}`);
    process.exitCode = 1;
    return;
  }
  if (found === harness) {
    process.exitCode = 0;
    return;
  }
  if (found === null || found === undefined) {
    logError(
      `no known harness process was found above this shell, so not ${harness}. Not starting a run.`,
    );
    process.exitCode = 1;
    return;
  }
  logError(`nearest harness ancestor is ${found}, not ${harness}. Refusing to start a run.`);
  process.exitCode = HARNESS_MISMATCH_EXIT;
}
