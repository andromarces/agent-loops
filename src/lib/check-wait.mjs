// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import { ghFailureText, NO_REQUIRED_CHECKS, runGh } from "./ci-required-sources.mjs";
import { isJsonObject } from "./json.mjs";

/** Default wait bound, in seconds. Short enough to fit a harness command timeout. */
export const DEFAULT_WAIT_SECONDS = 300;

/**
 * Milliseconds the command keeps waiting for an abandoned `gh` read to exit after
 * the bound elapses, so the command confirms the child is gone. The total bound
 * of a wait is therefore `timeoutSeconds` plus this ceiling (#329).
 */
export const CHILD_EXIT_CEILING_MS = 5000;

const POLL_INTERVAL_MS = 15_000;

// The exact `gh pr checks` reply on a PR head that no check has reported on yet,
// as right after a push. It is an empty list, not a read error, in the required
// and the all-checks read alike (#941, #950).
const NO_CHECKS_YET = /^no checks reported on the '.+' branch$/;

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
  if (!isJsonObject(item)) {
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
 * - Exit 8, or exit 0 with a pending check listed, keeps the wait running. An
 *   exit 0 with no settled check keeps it running too.
 * - Exit 1 with no output and the exact `no required checks reported on the
 *   '<branch>' branch` stderr is settled as `noRequiredChecks`: the branch has
 *   no required check to wait for, which is no pass either (#894). In the
 *   all-checks mode that answer does not exist, so that stderr is unresolved
 *   there, like every other exit 1 with no failing check listed (#896).
 * - Exit 1 with no output and the exact `no checks reported on the '<branch>'
 *   branch` stderr is an empty list that is not settled, so the wait continues:
 *   no check has reported on the PR head yet (#941). The all-checks read applies
 *   the same rule (#950).
 * - Any other code, with no failing check listed, is unresolved: exit 1 covers
 *   a read error, and an unparseable output is a read error. A list item that is
 *   not well formed is unresolved too, so one unreadable item cannot settle the
 *   list as a pass.
 */
function readOutcome(pr, { status, stdout, stderr }, all) {
  const label = `gh pr checks ${pr}${all ? "" : " --required"}`;
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
      throw new Error(`${label} could not be read: ${ghFailureText({ status, stderr })}`);
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
  // Only exit 8, or exit 0 with a pending item, keeps the wait running. Exit 1
  // with a pending list and no failing check is a read error, so it is not waited
  // out as pending (#894).
  if (status === EXIT_PENDING || (status === 0 && checks.some(isPending))) {
    return { settled: false, checks };
  }
  // An empty list on exit 0 keeps waiting, because `gh pr checks --required`
  // omits a check that has not started. The same empty list on exit 1 is not
  // that: exit 1 with no failing check listed is a read error unless `gh` states
  // the branch has no required check, or that no check has reported on the PR
  // head yet (#941, #950). Any other exit 1 falls through to the refusal below.
  if (status === 0 && checks.length > 0) {
    return { settled: true, checks };
  }
  if (!all && status === 1 && text === "" && NO_REQUIRED_CHECKS.test(stderr.trim())) {
    return { settled: true, checks, noRequiredChecks: true };
  }
  if (status === 1 && text === "" && NO_CHECKS_YET.test(stderr.trim())) {
    return { settled: false, checks };
  }
  if (status !== 0) {
    throw new Error(`${label} could not be read: ${ghFailureText({ status, stderr })}`);
  }
  return { settled: false, checks };
}

// A full object name, so two heads compare by equality. `gh` reports SHA-1 and SHA-256 names.
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `value` is a full commit SHA, the form a `--head` and a read head carry. */
export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

/**
 * The PR head a `gh pr view --json headRefOid` read reports, lowercase. Throws when the
 * read failed or names no full SHA, so an unreadable head is unresolved, never a pass.
 */
function readHead(pr, { status, stdout, stderr }) {
  const label = `gh pr view ${pr}`;
  if (status !== 0) {
    throw new Error(`${label} could not be read: ${ghFailureText({ status, stderr })}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Left null: the read is refused below.
  }
  const head = isJsonObject(parsed) ? parsed.headRefOid : undefined;
  if (typeof head !== "string" || !FULL_SHA.test(head.toLowerCase())) {
    throw new Error(`${label} returned no full head SHA; the read is unresolved.`);
  }
  return head.toLowerCase();
}

/**
 * Runs one read bounded by `remainingMs` and signals `gh` to stop when the bound
 * elapses. A read the bound beat is then given `CHILD_EXIT_CEILING_MS` to exit,
 * so the command can confirm the `gh` child is gone. Returns the read result, or
 * `{ timedOut: true, childExitUnconfirmed: true }` when that ceiling expired
 * with the read still unaccounted for, which is a claim the command does not
 * make on the parent's behalf (#329).
 */
async function readWithin(gh, argv, cwd, remainingMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  let ceiling;
  try {
    const read = gh(argv, cwd, { signal: controller.signal, timeoutMs: remainingMs }).then(
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
 * `noRequiredChecks` rides on the envelope only when `gh` states the branch has no
 * required check: the wait ends at once with no check state, and it is no pass (#894).
 * `all` waits on every check of the PR head instead of the required ones, for a
 * branch with no required check; it keeps the exit-code rules above, including
 * the wait on the no-checks-yet reply, except `noRequiredChecks` (#896, #950).
 *
 * `gh pr checks` names no commit, so each poll reads the PR head, then the checks,
 * then the PR head again. A read whose two heads differ is discarded, so one result
 * never mixes two heads. With `head`, a poll whose PR head is another commit reads no
 * checks and the wait continues, so the passing checks of the previous head never
 * settle it. The envelope's `head` names the commit its `checks` describe, and is
 * null when no read completed on a stable head, such as a wait that reached the bound
 * before the PR head reached `head`. A head that moves away and back between the two
 * head reads is not seen (#961).
 *
 * `deadline` is an absolute time on the `now` clock. A caller passes it to bound
 * the whole command, including the work that runs before the first read; a
 * caller that passes only `timeoutSeconds` is bounded from this call (#329).
 * @param {{ pr: number, cwd: string, timeoutSeconds?: number, deadline?: number | null, all?: boolean,
 *           head?: string | null, gh?: Function, now?: Function, sleep?: Function, signal?: AbortSignal | null }} options
 * @returns {Promise<{ timedOut: boolean, head: string | null, checks: Array<{ name: string, state: string|null, bucket: string|null }> }>}
 */
export async function waitChecks({
  pr,
  cwd,
  timeoutSeconds = DEFAULT_WAIT_SECONDS,
  deadline = null,
  all = false,
  head = null,
  gh = runGh,
  now = Date.now,
  sleep = (ms, signal) => delay(ms, signal ? { signal } : undefined),
  signal = null,
}) {
  if (head !== null && !isFullSha(head)) {
    throw new Error("head must be a full lowercase commit SHA.");
  }
  const end = deadline ?? now() + timeoutSeconds * 1000;
  const checksArgv = [
    "pr",
    "checks",
    String(pr),
    ...(all ? [] : ["--required"]),
    "--json",
    "name,state,bucket",
  ];
  const headArgv = ["pr", "view", String(pr), "--json", "headRefOid"];
  let last = [];
  let lastHead = null;
  // `childExitUnconfirmed` rides only on the read whose exit the command could
  // not observe, so an absent field is an observed exit.
  const timeout = (result = {}) => ({
    timedOut: true,
    head: lastHead,
    checks: last,
    ...(result.childExitUnconfirmed ? { childExitUnconfirmed: true } : {}),
  });
  // False when the bound is spent, so the caller reports it instead of sleeping.
  const pause = async () => {
    const left = end - now();
    if (left <= 0) {
      return false;
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
    return true;
  };
  for (;;) {
    if (end - now() <= 0) {
      return timeout();
    }
    const first = await readWithin(gh, headArgv, cwd, end - now(), signal);
    if (first.timedOut) {
      return timeout(first);
    }
    const before = readHead(pr, first);
    if (head !== null && before !== head) {
      if (!(await pause())) {
        return timeout();
      }
      continue;
    }
    if (end - now() <= 0) {
      return timeout();
    }
    const result = await readWithin(gh, checksArgv, cwd, end - now(), signal);
    if (result.timedOut) {
      return timeout(result);
    }
    const outcome = readOutcome(pr, result, all);
    if (end - now() <= 0) {
      return timeout();
    }
    const second = await readWithin(gh, headArgv, cwd, end - now(), signal);
    if (second.timedOut) {
      return timeout(second);
    }
    if (readHead(pr, second) === before) {
      // A new head drops the kept checks, so the envelope never pairs them with it.
      if (before !== lastHead) {
        last = [];
        lastHead = before;
      }
      // An empty list is not a settled read: `gh pr checks --required` omits a
      // check that has not started, so the last reported states are kept for the
      // envelope while the wait continues.
      if (outcome.checks.length > 0) {
        last = outcome.checks;
      }
      if (outcome.settled) {
        return {
          timedOut: false,
          ...(outcome.noRequiredChecks ? { noRequiredChecks: true } : {}),
          head: before,
          checks: outcome.checks,
        };
      }
    }
    if (!(await pause())) {
      return timeout();
    }
  }
}
