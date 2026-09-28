// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import { runGh } from "./ci-gate.mjs";

/** Default wait bound, in seconds. Short enough to fit a harness command timeout. */
export const DEFAULT_WAIT_SECONDS = 300;

const POLL_INTERVAL_MS = 15_000;

// A check is pending while it reports a pending bucket or a non-terminal state,
// so a `gh` that answers without the `bucket` field still ends the wait only on
// a settled check.
function isPending(check) {
  return (
    check.bucket === "pending" ||
    ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(check.state)
  );
}

/**
 * One required-check read. `gh pr checks --required` lists only checks that
 * already reported and prints no JSON when none has, so empty output is an empty
 * list and not a read failure; the caller keeps waiting on it.
 */
async function readRequiredChecks(gh, pr, cwd) {
  const label = `gh pr checks ${pr} --required`;
  const { status, stdout, stderr } = await gh(
    ["pr", "checks", String(pr), "--required", "--json", "name,state,bucket"],
    cwd,
  );
  const text = stdout.trim();
  if (text === "") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} could not be read: ${stderr.trim() || `exit ${status}`}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} returned no check list: ${stderr.trim() || `exit ${status}`}`);
  }
  return parsed.map((check) => ({
    name: check?.name ?? null,
    state: check?.state ?? null,
    bucket: check?.bucket ?? null,
  }));
}

/**
 * Polls the required checks of `pr` until none is pending or `timeoutSeconds`
 * elapses. `timedOut` marks a wait that ended on the bound; it is a completed
 * read, and the envelope still carries the last check states.
 * @param {{ pr: number, cwd: string, timeoutSeconds?: number, gh?: Function,
 *           now?: Function, sleep?: Function, signal?: AbortSignal | null }} options
 * @returns {Promise<{ timedOut: boolean, checks: Array<{ name: string|null, state: string|null, bucket: string|null }> }>}
 */
export async function waitChecks({
  pr,
  cwd,
  timeoutSeconds = DEFAULT_WAIT_SECONDS,
  gh = runGh,
  now = Date.now,
  sleep = (ms, signal) => delay(ms, signal ? { signal } : undefined),
  signal = null,
}) {
  const deadline = now() + timeoutSeconds * 1000;
  for (;;) {
    const checks = await readRequiredChecks(gh, pr, cwd);
    // An empty list is not a settled read: `gh pr checks --required` omits a
    // check that has not started, so it keeps waiting until one reports or the
    // bound elapses.
    if (checks.length > 0 && !checks.some(isPending)) {
      return { timedOut: false, checks };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { timedOut: true, checks };
    }
    try {
      await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal);
    } catch (err) {
      // The sleep rejects on an abort; report it as the cancel the rest of the
      // role CLI reports, so Ctrl+C exits 130 instead of a read failure.
      if (signal?.aborted) {
        const canceled = new Error("Interrupted by SIGINT");
        canceled.isCanceled = true;
        throw canceled;
      }
      throw err;
    }
  }
}
