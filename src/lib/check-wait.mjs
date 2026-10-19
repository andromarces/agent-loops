// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import { checkRuns, commitStatuses, latestBy } from "./ci-gate.mjs";
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
function readOutcome(pr, { status, stdout, stderr }, all, source = null) {
  const label = source ?? `gh pr checks ${pr}${all ? "" : " --required"}`;
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

// The check items of one commit, read by SHA. `gh pr checks` queries by PR identity and
// names no commit, so it cannot say which head its states describe (#961). The check runs
// and commit statuses of the commit come from `commits/{sha}`, and the latest entry for a
// name decides, as it does for the `--require-ci` gate.
const RUN_BUCKETS = { success: "pass", neutral: "pass", skipped: "skipping", cancelled: "cancel" };
const STATUS_BUCKETS = { success: "pass", pending: "pending" };

function groupBy(entries, key) {
  const groups = new Map();
  for (const entry of entries) {
    groups.set(entry[key], [...(groups.get(entry[key]) ?? []), entry]);
  }
  return groups;
}

/** The latest entry of each name group. Throws when a group cannot be ordered, so the read is unresolved. */
function latestOfEach(entries, key, fields, what) {
  return [...groupBy(entries, key)].map(([name, group]) => {
    const latest = latestBy(group, fields);
    if (latest === null) {
      throw new Error(`the ${what} named "${name}" cannot be ordered; the read is unresolved.`);
    }
    return latest;
  });
}

function runItem(run) {
  const completed = run.status === "completed";
  return {
    name: run.name,
    state: (completed ? run.conclusion : run.status).toUpperCase(),
    bucket: completed ? (RUN_BUCKETS[run.conclusion] ?? "fail") : "pending",
  };
}

function statusItem(status) {
  return {
    name: status.context,
    state: status.state.toUpperCase(),
    bucket: STATUS_BUCKETS[status.state] ?? "fail",
  };
}

/**
 * The items of a commit read: every check run and commit status when `names` is null,
 * otherwise those named. A name with no entry on the commit has not reported on it, so it
 * is a pending item. Every item describes `commit` and no other.
 */
function commitItems({ runs, statuses }, names) {
  const latestRuns = latestOfEach(runs, "name", ["started_at", "completed_at"], "check runs");
  const latestStatuses = latestOfEach(
    statuses,
    "context",
    ["updated_at", "created_at"],
    "commit statuses",
  );
  if (names === null) {
    return [...latestRuns.map(runItem), ...latestStatuses.map(statusItem)];
  }
  return [...new Set(names)].flatMap((name) => {
    const found = [
      ...latestRuns.filter((run) => run.name === name).map(runItem),
      ...latestStatuses.filter((status) => status.context === name).map(statusItem),
    ];
    return found.length > 0 ? found : [{ name, state: "PENDING", bucket: "pending" }];
  });
}

/** The `gh pr checks` reply shape for `items`, so one outcome rule set judges both sources. */
function asRead(items) {
  const status = items.some(isFailing) ? 1 : items.some(isPending) ? 8 : 0;
  return { status, stdout: JSON.stringify(items), stderr: "" };
}

/** A read the wait bound ended; carries the read result for `childExitUnconfirmed`. */
class BoundReached extends Error {
  constructor(result) {
    super("the wait bound was reached");
    this.result = result;
  }
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
 * `gh pr checks` names no commit, because it queries by PR identity, so the check states
 * never come from it. Each poll reads the PR head `sha` (`gh pr view`), runs `gh pr checks`
 * for its exit-code outcome and for the names of the required checks, and then takes every
 * state from the check runs and commit statuses of `sha` itself (`commits/{sha}`, every page).
 * The envelope's `head` is that `sha`, so `checks` describe it and no other commit, even when
 * the PR head moves during the wait. The required wait judges the names that `gh pr checks
 * --required` lists, with a name that has no entry on `sha` pending. The `--all` wait judges
 * every entry of `sha`. A check that is required but that no read of the PR lists yet is
 * absent, as before. With `head`, a poll whose PR head is another commit reads no checks and
 * the wait continues, so the passing checks of the previous head never settle it. The PR head
 * is the one read at the start of the poll, so the PR can have moved on by the time the wait
 * returns. `head` is null when no read completed, such as a wait that reached the bound before
 * the PR head reached `head` (#961).
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
  let slug = null;
  // `childExitUnconfirmed` rides only on the read whose exit the command could
  // not observe, so an absent field is an observed exit.
  const timeout = (result = {}) => ({
    timedOut: true,
    head: lastHead,
    checks: last,
    ...(result.childExitUnconfirmed ? { childExitUnconfirmed: true } : {}),
  });
  // One bounded read, so the commit reads share the deadline of the checks read.
  const bounded = async (argv) => {
    const remaining = end - now();
    if (remaining <= 0) {
      throw new BoundReached({});
    }
    const result = await readWithin(gh, argv, cwd, remaining, signal);
    if (result.timedOut) {
      throw new BoundReached(result);
    }
    return result;
  };
  const readCommit = async (sha) => {
    if (slug === null) {
      const read = await bounded([
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "-q",
        ".nameWithOwner",
      ]);
      slug = read.stdout.trim();
      if (read.status !== 0 || slug === "") {
        slug = null;
        throw new Error(`gh repo view could not be read: ${ghFailureText(read)}`);
      }
    }
    const read = (argv, cwdArg) => bounded(argv, cwdArg);
    const runs = await checkRuns(read, slug, sha, cwd, true);
    const statuses = await commitStatuses(read, slug, sha, cwd, true);
    return { runs, statuses };
  };
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
  try {
    for (;;) {
      const sha = readHead(pr, await bounded(headArgv));
      if (head === null || sha === head) {
        const listed = readOutcome(pr, await bounded(checksArgv), all);
        let outcome = listed;
        // A branch with no required check names no state to read, so it carries no commit read.
        // An empty required list names nothing to read, so the wait continues.
        if (!listed.noRequiredChecks && (all || listed.checks.length > 0)) {
          const items = commitItems(
            await readCommit(sha),
            all ? null : listed.checks.map(({ name }) => name),
          );
          outcome = readOutcome(
            pr,
            asRead(items),
            all,
            `the check runs and commit statuses of ${sha}`,
          );
        }
        // A new head drops the kept checks, so the envelope never pairs them with it.
        if (sha !== lastHead) {
          last = [];
          lastHead = sha;
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
            head: sha,
            checks: outcome.checks,
          };
        }
      }
      if (!(await pause())) {
        return timeout();
      }
    }
  } catch (err) {
    if (err instanceof BoundReached) {
      return timeout(err.result);
    }
    throw err;
  }
}
