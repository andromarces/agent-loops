// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import { runGh } from "./ci-gate.mjs";

/** Default wait bound, in seconds. Short enough to fit a harness command timeout. */
export const DEFAULT_WAIT_SECONDS = 300;

const POLL_INTERVAL_MS = 15_000;

// The `gh pr checks` exit codes, as `docs/orchestrator-instructions.md` states
// them for the reviewer read: 8 is a pending check, and 1 covers a failing check,
// a repository with no required check, and a read error. An exit 1 is therefore
// not a failure on its own; the check list decides (#329).
const EXIT_PENDING = 8;

// A check is pending while it reports a pending bucket or a non-terminal state,
// so a `gh` that answers without the `bucket` field still ends the wait only on
// a settled check. The failing test is its mirror: a settled failure ends the
// wait, because waiting a failing check out hides the failure the parent must
// act on.
const PENDING_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
const FAILING_STATES = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

function isPending(check) {
  return check.bucket === "pending" || PENDING_STATES.has(check.state);
}

function isFailing(check) {
  return check.bucket === "fail" || FAILING_STATES.has(check.state);
}

/**
 * One required-check read, mapped to the wait outcome the `gh` exit code and the
 * check list carry. Throws when the read is unresolved, so an unresolved read
 * never reads as a pass.
 *
 * - A listed failing check is settled, whichever code answered, and the failure
 *   is reported rather than waited out.
 * - A pending code, or a list with no settled check, keeps the wait running.
 * - Any other code, with no failing check listed, is unresolved: exit 1 covers
 *   a repository with no required check and a read error, and an unparseable
 *   output is a read error.
 */
function readOutcome(pr, { status, stdout, stderr, timedOut = false }) {
  const label = `gh pr checks ${pr} --required`;
  if (timedOut) {
    return { settled: false, checks: null };
  }
  const text = stdout.trim();
  let checks = [];
  if (text !== "") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} could not be read: ${stderr.trim() || `exit ${status}`}`);
    }
    checks = parsed.map((check) => ({
      name: check?.name ?? null,
      state: check?.state ?? null,
      bucket: check?.bucket ?? null,
    }));
  }
  if (checks.some(isFailing)) {
    return { settled: true, checks };
  }
  if (status === EXIT_PENDING || checks.some(isPending)) {
    return { settled: false, checks };
  }
  // An empty list on exit 0 keeps waiting, because `gh pr checks --required`
  // omits a check that has not started. The same empty list on exit 1 is not
  // that: exit 1 with no failing check listed covers a repository with no
  // required check and a read error, so it falls through to the refusal below.
  if (status === 0 && checks.length > 0) {
    return { settled: true, checks };
  }
  if (status !== 0) {
    throw new Error(`${label} could not be read: ${stderr.trim() || `exit ${status}`}`);
  }
  return { settled: false, checks };
}

/**
 * Runs one read bounded by `remainingMs` and signals `gh` to stop when the bound
 * elapses, so a hung `gh` is abandoned and its child terminated instead of
 * outlasting the wait. Returns `null` when the bound beat the read.
 */
async function readWithin(gh, pr, cwd, remainingMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  try {
    const read = gh(
      ["pr", "checks", String(pr), "--required", "--json", "name,state,bucket"],
      cwd,
      { signal: controller.signal, timeoutMs: remainingMs },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const elapsed = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), remainingMs);
    });
    const outcome = await Promise.race([read, elapsed]);
    if (outcome === null) {
      return null;
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // The read is finished or abandoned, so stop the `gh` child either way.
    controller.abort();
  }
}

/**
 * Polls the required checks of `pr` until none is pending or `timeoutSeconds`
 * elapses. Every read is bounded by the time left, and the read that reaches the
 * bound is signaled to stop. `timedOut` marks a wait that ended on the bound; it
 * is a completed read, and the envelope still carries the last check states.
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
  let last = [];
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { timedOut: true, checks: last };
    }
    const result = await readWithin(gh, pr, cwd, remaining, signal);
    if (result === null || result.timedOut) {
      return { timedOut: true, checks: last };
    }
    const outcome = readOutcome(pr, result);
    // An empty list is not a settled read: `gh pr checks --required` omits a
    // check that has not started, so the last reported states are kept for the
    // envelope while the wait continues.
    if (outcome.checks !== null && outcome.checks.length > 0) {
      last = outcome.checks;
    }
    if (outcome.settled) {
      return { timedOut: false, checks: outcome.checks };
    }
    const left = deadline - now();
    if (left <= 0) {
      return { timedOut: true, checks: last };
    }
    try {
      await sleep(Math.min(POLL_INTERVAL_MS, left), signal);
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
