// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import { runGh } from "./ci-gate.mjs";

/** Default wait bound, in seconds. Short enough to fit a harness command timeout. */
export const DEFAULT_WAIT_SECONDS = 300;

/**
 * Milliseconds the command keeps waiting for an abandoned `gh` read to exit after
 * the bound elapses, so the command confirms the child is gone. The total bound
 * of a wait is therefore `timeoutSeconds` plus this ceiling (#329).
 */
export const CHILD_EXIT_CEILING_MS = 5000;

const POLL_INTERVAL_MS = 15_000;

// The `gh pr checks` exit codes, as `docs/orchestrator-instructions.md` states
// them for the reviewer read: 8 is a pending check, and 1 covers a failing check,
// a repository with no required check, and a read error. An exit 1 is therefore
// not a failure on its own; the check list decides (#329).
const EXIT_PENDING = 8;

// Every value a well-formed item may carry, so an item the runtime cannot read
// is unresolved rather than a pass. `gh pr checks --help` names the buckets:
// pass, fail, pending, skipping, and cancel. A `gh` that adds one is refused
// rather than guessed at, because an unread value is not evidence of a pass.
const KNOWN_BUCKETS = new Set(["pass", "fail", "pending", "skipping", "cancel"]);

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
const PASSING_STATES = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * One check item, or null when the item is not well formed. A well-formed item
 * carries a non-empty `name` and at least one of `state` or `bucket`, and every
 * value it carries is one the runtime knows. An item that fails any of those
 * checks has no state to read, so it is unresolved, never a pass (#329).
 */
function readItem(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (name === "") {
    return null;
  }
  const bucket = item.bucket === undefined || item.bucket === null ? null : String(item.bucket);
  const state = item.state === undefined || item.state === null ? null : String(item.state);
  if (bucket === null && state === null) {
    return null;
  }
  if (bucket !== null && !KNOWN_BUCKETS.has(bucket)) {
    return null;
  }
  if (
    state !== null &&
    !PENDING_STATES.has(state) &&
    !FAILING_STATES.has(state) &&
    !PASSING_STATES.has(state)
  ) {
    return null;
  }
  return { name, state, bucket };
}

function isPending(check) {
  return check.bucket === "pending" || PENDING_STATES.has(check.state);
}

function isFailing(check) {
  return check.bucket === "fail" || check.bucket === "cancel" || FAILING_STATES.has(check.state);
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
 *   output is a read error. A list item that is not well formed is unresolved
 *   too, so one unreadable item cannot settle the list as a pass.
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
    const items = parsed.map(readItem);
    const bad = items.findIndex((item) => item === null);
    if (bad !== -1) {
      throw new Error(
        `${label} returned a check item that is not well formed at index ${bad}; the read is unresolved.`,
      );
    }
    checks = items;
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
 * elapses. A read the bound beat is then given `CHILD_EXIT_CEILING_MS` to exit,
 * so the command can confirm the `gh` child is gone. Returns the read result, or
 * `{ timedOut: true, childExitUnconfirmed: true }` when that ceiling expired
 * with the read still unaccounted for, which is a claim the command does not
 * make on the parent's behalf (#329).
 */
async function readWithin(gh, pr, cwd, remainingMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  let ceiling;
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
      // Stop the child, then wait for it to exit. `read` never rejects, so the
      // wait costs nothing and reports nothing about the abandoned read.
      controller.abort();
      const settled = await Promise.race([
        read.then(() => true),
        new Promise((resolve) => {
          ceiling = setTimeout(() => resolve(false), CHILD_EXIT_CEILING_MS);
        }),
      ]);
      return settled ? { timedOut: true } : { timedOut: true, childExitUnconfirmed: true };
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
    clearTimeout(ceiling);
    signal?.removeEventListener("abort", onAbort);
    // The read is finished or abandoned, so stop the `gh` child either way.
    controller.abort();
  }
}

/**
 * Polls the required checks of `pr` until none is pending or the deadline
 * elapses. Every read is bounded by the time left, and a read that reaches the
 * bound is signaled to stop and given the child-exit ceiling. `timedOut` marks a
 * wait that ended on the bound; it is a completed read, and the envelope still
 * carries the last check states. `childExitUnconfirmed` rides on the envelope
 * only when that ceiling expired with the read still unaccounted for, because a
 * child exit the command did not observe is not a claim it may make.
 *
 * `deadline` is an absolute time on the `now` clock. A caller passes it to bound
 * the whole command, including the work that runs before the first read; a
 * caller that passes only `timeoutSeconds` is bounded from this call (#329).
 * @param {{ pr: number, cwd: string, timeoutSeconds?: number, deadline?: number | null,
 *           gh?: Function, now?: Function, sleep?: Function, signal?: AbortSignal | null }} options
 * @returns {Promise<{ timedOut: boolean, checks: Array<{ name: string, state: string|null, bucket: string|null }> }>}
 */
export async function waitChecks({
  pr,
  cwd,
  timeoutSeconds = DEFAULT_WAIT_SECONDS,
  deadline = null,
  gh = runGh,
  now = Date.now,
  sleep = (ms, signal) => delay(ms, signal ? { signal } : undefined),
  signal = null,
}) {
  const end = deadline ?? now() + timeoutSeconds * 1000;
  let last = [];
  for (;;) {
    const remaining = end - now();
    if (remaining <= 0) {
      return { timedOut: true, checks: last };
    }
    const result = await readWithin(gh, pr, cwd, remaining, signal);
    if (result.timedOut) {
      // `childExitUnconfirmed` rides only on the read whose exit the command
      // could not observe, so an absent field is an observed exit.
      return {
        timedOut: true,
        checks: last,
        ...(result.childExitUnconfirmed ? { childExitUnconfirmed: true } : {}),
      };
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
    const left = end - now();
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
