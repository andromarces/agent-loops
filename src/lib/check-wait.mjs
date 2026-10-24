// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import {
  checkRuns,
  commitStatuses,
  evaluateContext,
  latestBy,
  matchingEntries,
  requiredAbsence,
  requiredNamesRefusal,
  requiredResolutionRefusal,
} from "./ci-gate.mjs";
import {
  failureOf,
  ghApi,
  ghFailureText,
  NO_REQUIRED_CHECKS,
  pagedRead,
  readOne,
  requiredContexts,
  runGh,
} from "./ci-required-sources.mjs";
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

// The workflow triggers that can run for a PR head, and the directory that holds the workflows. The
// probe scans the text of each workflow file for a trigger name instead of parsing the YAML, so a name
// in a comment or a step also keeps the wait. That errs toward the wait, never toward a skip.
const PR_TRIGGERS =
  /\b(?:pull_request|pull_request_target|push|merge_group|workflow_run|check_suite)\b/;
const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_PATH = /^\.github\/workflows\//i;
// A text the scan cannot read as plain trigger names: a backslash starts a YAML escape or a line
// continuation that can spell an event name (`"pull_request"`), and a control character, as a
// NUL in UTF-16 text, hides names from the scan. Such a text keeps the wait.
// oxlint-disable-next-line no-control-regex -- the control characters are the point of the pattern
const UNREADABLE_TEXT = /[\\\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// A base64 string as the contents API sends it, line breaks removed.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// The most items that the files endpoint of a PR (3,000) and the contents endpoint of a directory
// (1,000) return, so a list of that length may be cut and proves nothing.
const PR_FILES_CAP = 3000;
const DIRECTORY_CAP = 1000;

/**
 * The merge time of a `pulls` entry in ms: false for a PR that is not merged (`null`), null for any
 * value that is not a real UTC timestamp as the API writes it (`YYYY-MM-DDTHH:MM:SSZ`).
 */
function mergeTimeOf(value) {
  if (value === null) {
    return false;
  }
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) || `${new Date(time).toISOString().slice(0, 19)}Z` !== value
    ? null
    : time;
}

/**
 * Whether `name` is a valid Git branch name, as `git check-ref-format --branch` judges it: no control
 * character, space, or one of `~^:?*[\`, no `..` or `@{`, no leading dash, no leading or trailing
 * slash or empty component, no component that starts with a dot or ends with `.lock`, no trailing dot,
 * and neither `@` nor `HEAD` alone. A name that fails is an unknown shape, never another branch.
 */
function isBranchName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "@" &&
    name !== "HEAD" &&
    !name.startsWith("-") &&
    !name.endsWith(".") &&
    ![...name].some((char) => char <= " " || char === "\x7f" || "~^:?*[\\".includes(char)) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

// A full object name, so two heads compare by equality. `gh` reports SHA-1 and SHA-256 names.
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `value` is a full commit SHA, the form a `--head` and a read head carry. */
export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

/**
 * The PR head `{ head, base }` that a `gh pr view --json headRefOid,baseRefName` read reports, the
 * head lowercase. Throws when the read failed or names no full SHA or base branch, so an
 * unreadable head is unresolved, never a pass.
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
  const base = isJsonObject(parsed) ? parsed.baseRefName : undefined;
  if (typeof head !== "string" || !FULL_SHA.test(head.toLowerCase())) {
    throw new Error(`${label} returned no full head SHA; the read is unresolved.`);
  }
  if (typeof base !== "string" || base === "") {
    throw new Error(`${label} returned no base branch; the read is unresolved.`);
  }
  return { head: head.toLowerCase(), base };
}

// The check items of one commit, read by SHA. `gh pr checks` queries by PR identity and
// names no commit, so it cannot say which head its states describe (#961). The check runs
// and commit statuses of the commit come from `commits/{sha}`. A required context is judged
// by the gate's own matching and verdict (`matchingEntries`, `evaluateContext`), so an
// app-qualified context is satisfied only by a run of that app, and the latest entry among
// the matching ones decides.
const RUN_BUCKETS = { success: "pass", neutral: "pass", skipped: "skipping", cancelled: "cancel" };
const STATUS_BUCKETS = { success: "pass", pending: "pending" };

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

/** The latest entry of each group, keyed by `keyOf`. Throws when a group cannot be ordered, so the read is unresolved. */
function latestOfEach(entries, keyOf, fields, what) {
  const groups = new Map();
  for (const entry of entries) {
    groups.set(keyOf(entry), [...(groups.get(keyOf(entry)) ?? []), entry]);
  }
  return [...groups].map(([key, group]) => {
    const latest = latestBy(group, fields);
    if (latest === null) {
      throw new Error(`the ${what} named "${key}" cannot be ordered; the read is unresolved.`);
    }
    return latest;
  });
}

/**
 * The items of the `--all` wait: the latest check run of each name and app, and the latest
 * commit status of each context. An app is a part of the key, so a newer run of one app
 * never masks another app's failing run of the same name.
 */
function allItems({ runs, statuses }) {
  return [
    ...latestOfEach(
      runs,
      (run) => `${run.name} (app ${run.app?.id ?? "none"})`,
      ["started_at", "completed_at"],
      "check runs",
    ).map(runItem),
    ...latestOfEach(
      statuses,
      (status) => status.context,
      ["updated_at", "created_at"],
      "commit statuses",
    ).map(statusItem),
  ];
}

/**
 * The items of the required wait: one verdict per required context, as the gate judges it.
 * A passing context shows its latest matching entries. A failing or pending one shows a
 * matching entry in that state, or a synthetic item when only the verdict says so, and a
 * context with no matching entry has not reported on the commit, so it is pending.
 */
function requiredItems({ runs, statuses }, contexts, commit) {
  return contexts.flatMap((context) => {
    const verdict = evaluateContext(context, commit, runs, statuses);
    const matching = matchingEntries(context, runs, statuses);
    const entries = [...matching.runs.map(runItem), ...matching.statuses.map(statusItem)];
    if (verdict === null) {
      return [
        ...(matching.runs.length > 0
          ? [runItem(latestBy(matching.runs, ["started_at", "completed_at"]))]
          : []),
        ...(matching.statuses.length > 0
          ? [statusItem(latestBy(matching.statuses, ["updated_at", "created_at"]))]
          : []),
      ];
    }
    const failing = verdict.kind === "failing";
    const shown = entries.find((item) => (failing ? isFailing(item) : isPending(item)));
    return [
      shown ?? {
        name: context.name,
        state: failing ? "FAILURE" : "PENDING",
        bucket: failing ? "fail" : "pending",
      },
    ];
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
async function readWithin(gh, argv, cwd, remainingMs, signal, dropEnv) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  let ceiling;
  try {
    const read = gh(argv, cwd, {
      signal: controller.signal,
      timeoutMs: remainingMs,
      ...(dropEnv && { dropEnv }),
    }).then(
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
 * The text of a workflow file from its contents reply, or null when the reply is not valid evidence:
 * a file at `path` with base64 content whose string is well formed, whose decoded length equals
 * `size`, and whose bytes are valid UTF-8. An empty file with `size` 0 is valid.
 */
function workflowText(body, path) {
  if (
    body.type !== "file" ||
    body.encoding !== "base64" ||
    typeof body.content !== "string" ||
    !Number.isInteger(body.size) ||
    body.size < 0 ||
    (body.path !== undefined && body.path !== path)
  ) {
    return null;
  }
  const encoded = body.content.replace(/\r?\n/g, "");
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== body.size) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
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
 * `noCheckSource` rides on an `--all` envelope only when the first read lists no check and no source can
 * report one for the PR head (see `noCheckSource` below): the wait ends at once with an empty `checks`,
 * and it is no pass (#1054).
 * `expect` names check runs that the `--all` wait must see on `sha` before a pass, matched by exact
 * name against the check runs only, whichever app made them, never against commit statuses: a third-party app can
 * register a check run after the first ones passed, so a pass without it is not evidence. A
 * missing expected name keeps the wait running to the bound, where `awaiting` lists it. A failing
 * check still settles the wait (#978).
 *
 * `gh pr checks` names no commit, because it queries by PR identity, so the check states
 * never come from it. Each poll reads the PR head `sha` (`gh pr view`), runs `gh pr checks`
 * for its exit-code outcome, and then takes every state from the check runs and commit
 * statuses of `sha` itself (`commits/{sha}`, every page). The envelope's `head` is that `sha`,
 * so `checks` describe it and no other commit, even when the PR head moves during the wait.
 * The required wait judges each required context as the `--require-ci` gate does: the
 * contexts come from `requiredContexts`, matching and verdict come from the gate, an
 * app-qualified context is satisfied only by a run of that app, and a context with no entry
 * on `sha` is pending. The `--all` wait judges the latest run of each name and app and the
 * latest status of each context. The states of `sha` only make the outcome stricter: a failing
 * state of `sha` settles the wait, and a pass needs both the `gh pr checks` outcome and every
 * state of `sha` to pass. A failure that `gh pr checks` lists settles the wait too, but it is
 * PR-level evidence that no commit pins, so it is reported in `prFailures`, apart from `checks`,
 * which holds only states read for `head`, and it survives the bound. A required context that cannot be resolved (a source that
 * cannot be read or parsed, or a failed read of the names) is an error, because no pass can
 * follow it. A check that is required but that no read of the PR lists yet is absent, as
 * before. With
 * `head`, a poll whose PR head is another commit reads no checks and the wait continues. The
 * PR head is the one read at the start of the poll, so the PR can have moved on by the time
 * the wait returns. `head` is null when no read completed, such as a wait that reached the
 * bound before the PR head reached `head` (#961).
 *
 * `deadline` is an absolute time on the `now` clock. A caller passes it to bound
 * the whole command, including the work that runs before the first read; a
 * caller that passes only `timeoutSeconds` is bounded from this call (#329).
 * @param {{ pr: number, cwd: string, timeoutSeconds?: number, deadline?: number | null, all?: boolean,
 *           head?: string | null, expect?: string[], gh?: Function, now?: Function, sleep?: Function, signal?: AbortSignal | null }} options
 * @returns {Promise<{ timedOut: boolean, head: string | null, checks: Array<{ name: string, state: string|null, bucket: string|null }>, prFailures?: Array<{ name: string, state: string|null, bucket: string|null }>, awaiting?: string[] }>}
 */
export async function waitChecks({
  pr,
  cwd,
  timeoutSeconds = DEFAULT_WAIT_SECONDS,
  deadline = null,
  all = false,
  head = null,
  expect = [],
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
  const headArgv = ["pr", "view", String(pr), "--json", "headRefOid,baseRefName"];
  let last = [];
  let lastHead = null;
  let slug = null;
  // `childExitUnconfirmed` rides only on the read whose exit the command could
  // not observe, so an absent field is an observed exit.
  // Set by every read of the wait whose child exit was not observed, including a sibling
  // read that the first failure of a group left running to the ceiling.
  let unconfirmed = false;
  // The failures that `gh pr checks` listed in the current poll. They are PR-level evidence,
  // not pinned to a commit, so they ride apart from `checks`, which holds states read for `head`.
  let prFailures = [];
  // The expected check names that the last poll found no run for on its head.
  let awaiting = [];
  const timeout = () => ({
    timedOut: true,
    head: lastHead,
    checks: last,
    ...(awaiting.length > 0 ? { awaiting } : {}),
    ...(prFailures.length > 0 ? { prFailures } : {}),
  });
  // The one place that adds `childExitUnconfirmed`: every envelope the wait returns, settled or
  // timed out, passes through it, and an error carries the flag in the catch below.
  const seal = (envelope) => (unconfirmed ? { ...envelope, childExitUnconfirmed: true } : envelope);
  // One bounded read, so the commit reads share the deadline of the checks read. A group of
  // reads passes its own signal, which stops the siblings of a failed read.
  const bounded = async (argv, _cwd, options = {}) => {
    const remaining = end - now();
    if (remaining <= 0) {
      throw new BoundReached({});
    }
    const stop = [signal, options.signal].filter(Boolean);
    const result = await readWithin(
      gh,
      argv,
      cwd,
      remaining,
      stop.length > 1 ? AbortSignal.any(stop) : (stop[0] ?? null),
      options.dropEnv,
    );
    if (result.timedOut) {
      unconfirmed ||= Boolean(result.childExitUnconfirmed);
      throw new BoundReached(result);
    }
    return result;
  };
  const ensureSlug = async () => {
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
  };
  // The commit reads are the gate's own reads, which page by page number with one `gh api --include`
  // request per page and never follow the `Link` header, which they reject when it names another host (see `pagedRead`). A failed read is marked
  // `transient`, and the wait retries it on the next poll, only when its first-line status is 500,
  // 502, 503, or 504 and its body is empty or one JSON value. Every other failure ends the wait: any
  // other status, a 4xx whatever its body says, a failure with no status block, and a reply whose
  // body is not exactly one JSON value.
  const readCommit = async (sha) => {
    await ensureSlug();
    const runs = await checkRuns(bounded, slug, sha, cwd, true);
    const statuses = await commitStatuses(bounded, slug, sha, cwd, true);
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
  // The contexts the required wait judges: every source of the gate, so an app-qualified
  // context keeps its app, plus the names `gh pr checks --required` listed.
  const contextsOf = async (base, listed) => {
    const required = await requiredContexts(bounded, slug, base, pr, cwd);
    // The gate's own refusals, and any source that settled nothing: such a source may hold a
    // required check or an app qualifier that this read never saw, so no pass can follow.
    const refusal = requiredResolutionRefusal(required, pr);
    if (refusal) {
      throw new Error(`${refusal}; the read is unresolved.`);
    }
    if (required.unknown.length > 0) {
      throw new Error(
        `${required.unknown.join(" and ")} could not be read, so the required checks of PR ${pr} and their apps are unresolved.`,
      );
    }
    const contexts = [...required.contexts];
    for (const { name } of listed.checks) {
      if (!contexts.some((context) => context.name === name)) {
        contexts.push({ name, appId: null });
      }
    }
    return contexts;
  };
  // Whether the `gh` no-required-checks answer is an established absence, decided by the same
  // `requiredAbsence` the `--require-ci` gate uses (#1013). A source that settled nothing, and a
  // ruleset read that found no rule beside no named check, are errors that name the cause,
  // because the gate refuses the same states. A failed names read is an error too, where the
  // wait is stricter than the gate, which ignores that read. A source that names a required
  // check is no absence, so the wait goes on to judge it.
  const absenceOf = async (base) => {
    await ensureSlug();
    const required = await requiredContexts(bounded, slug, base, pr, cwd);
    const namesRefusal = requiredNamesRefusal(required, pr);
    if (namesRefusal) {
      throw new Error(`${namesRefusal}; the read is unresolved.`);
    }
    const absence = requiredAbsence(required);
    if (absence?.absent) {
      return true;
    }
    const unproven = absence?.unproven ?? required.unknown;
    if (unproven.length > 0) {
      throw new Error(
        `gh pr checks ${pr} --required reported no required check, but ${unproven.join(" and ")} did not state that it holds no required check, so the required checks of PR ${pr} are unresolved.`,
      );
    }
    return false;
  };
  // Whether no source can report a check for the PR head `sha`, once its own check runs and commit
  // statuses came back empty: the PR changes no file under `.github/workflows/`, no workflow of the
  // base branch names a trigger that can run for the PR head, and the base head shows no check run
  // and no commit status from any source, so a GitHub App or third-party CI with no workflow file is
  // covered too. The base branch resolves to one SHA first, and every base read uses it, so the
  // evidence comes from one commit. Each read is bounded by the wait, and a reply is validated before
  // it counts as evidence. A read that fails, cannot be parsed, is not exactly the expected shape, or
  // may be cut by an API cap returns false or throws, and the caller then keeps the normal wait. A
  // base branch or PR head that moved during the reads keeps it too. The head of the latest PR merged
  // as the base head commit is read for checks as well (#1062). Its limit: only those two commits are
  // read, so a provider that skipped both, or registers later, stays unseen (#1054).
  const noCheckSource = async (sha, base) => {
    await ensureSlug();
    // The head SHAs of the PRs merged into `base` that hold the commit `baseSha` and share the latest
    // merge time, so a tie never resolves by list order. The list is empty when no such PR exists, and
    // null for a read that fails or any entry of another shape: a field must be exactly as the API
    // states it, a timestamp that is a real UTC date, a non-empty base ref, a lowercase full SHA. A PR
    // that is not merged, or merged into another branch, is no evidence.
    const mergedHeadsOf = async (baseSha, base) => {
      const pages = await ghApi(
        pagedRead(bounded, null),
        [`repos/${slug}/commits/${baseSha}/pulls`],
        cwd,
      );
      if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
        return null;
      }
      let latest = -Infinity;
      let heads = [];
      for (const entry of pages.flat()) {
        const mergedAt = isJsonObject(entry) ? mergeTimeOf(entry.merged_at) : null;
        if (
          mergedAt === null ||
          !isJsonObject(entry.base) ||
          !isBranchName(entry.base.ref) ||
          !isJsonObject(entry.head) ||
          typeof entry.head.sha !== "string" ||
          !FULL_SHA.test(entry.head.sha)
        ) {
          return null;
        }
        if (mergedAt === false || entry.base.ref !== base || mergedAt < latest) {
          continue;
        }
        if (mergedAt > latest) {
          latest = mergedAt;
          heads = [];
        }
        heads.push(entry.head.sha);
      }
      return heads;
    };
    const baseShaOf = async () => {
      const read = await readOne(bounded, `repos/${slug}/commits/${encodeURIComponent(base)}`, cwd);
      const parsed = read.status === 0 ? JSON.parse(read.stdout) : null;
      const found = isJsonObject(parsed) && typeof parsed.sha === "string" ? parsed.sha : "";
      return FULL_SHA.test(found.toLowerCase()) ? found.toLowerCase() : null;
    };
    const baseSha = await baseShaOf();
    if (baseSha === null) {
      return false;
    }
    const pages = await ghApi(pagedRead(bounded, null), [`repos/${slug}/pulls/${pr}/files`], cwd);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      return false;
    }
    const changed = pages.flat();
    if (changed.length >= PR_FILES_CAP) {
      return false;
    }
    for (const file of changed) {
      if (!isJsonObject(file) || typeof file.filename !== "string") {
        return false;
      }
      if (WORKFLOW_PATH.test(file.filename) || WORKFLOW_PATH.test(file.previous_filename ?? "")) {
        return false;
      }
    }
    const listing = await readOne(
      bounded,
      `repos/${slug}/contents/${WORKFLOW_DIR}?ref=${baseSha}`,
      cwd,
    );
    let entries = [];
    if (listing.status !== 0) {
      if (!listing.notFound) {
        return false;
      }
    } else {
      entries = JSON.parse(listing.stdout);
      if (!Array.isArray(entries) || entries.length >= DIRECTORY_CAP) {
        return false;
      }
    }
    for (const entry of entries) {
      if (
        !isJsonObject(entry) ||
        typeof entry.path !== "string" ||
        !WORKFLOW_PATH.test(entry.path)
      ) {
        return false;
      }
      if (entry.type === "dir") {
        continue;
      }
      if (entry.type !== "file") {
        return false;
      }
      const path = entry.path.split("/").map(encodeURIComponent).join("/");
      const read = await readOne(bounded, `repos/${slug}/contents/${path}?ref=${baseSha}`, cwd);
      const body = read.status === 0 ? JSON.parse(read.stdout) : null;
      const text = isJsonObject(body) ? workflowText(body, entry.path) : null;
      if (text === null || UNREADABLE_TEXT.test(text) || PR_TRIGGERS.test(text)) {
        return false;
      }
    }
    const runs = await checkRuns(bounded, slug, baseSha, cwd, true);
    const statuses = await commitStatuses(bounded, slug, baseSha, cwd, true);
    if (runs.length > 0 || statuses.length > 0) {
      return false;
    }
    // A provider that reports on PR heads only never shows on the base head, so the heads of the
    // latest merged PRs of that commit are read the same way (#1062).
    const mergedHeads = await mergedHeadsOf(baseSha, base);
    if (mergedHeads === null) {
      return false;
    }
    for (const mergedHead of mergedHeads) {
      const mergedRuns = await checkRuns(bounded, slug, mergedHead, cwd, true);
      const mergedStatuses = await commitStatuses(bounded, slug, mergedHead, cwd, true);
      if (mergedRuns.length > 0 || mergedStatuses.length > 0) {
        return false;
      }
    }
    // Neither the base branch nor the PR head moved while the probe read.
    const moved = readHead(pr, await bounded(headArgv));
    return moved.head === sha && moved.base === base && (await baseShaOf()) === baseSha;
  };
  // Whether the probe ran. It runs at most once per wait.
  let probed = false;
  // The retryable server error of the latest completed poll, or null when that poll had none.
  // A wait that ends on the bound with it set reports it as an error, so a server error never
  // reads as a timeout or a pass (#1025).
  let transient = null;
  const poll = async () => {
    for (;;) {
      prFailures = [];
      let failed = null;
      const { head: sha, base } = readHead(pr, await bounded(headArgv));
      if (head === null || sha === head) {
        const listed = readOutcome(pr, await bounded(checksArgv), all);
        if (listed.noRequiredChecks && !(await absenceOf(base))) {
          listed.noRequiredChecks = false;
          listed.settled = false;
        }
        prFailures = listed.checks.filter(isFailing);
        let outcome = listed;
        // A branch with no required check names no state to read, so it carries no commit read.
        // An empty required list names nothing to read, so the wait continues.
        if (!listed.noRequiredChecks && (all || listed.checks.length > 0)) {
          let items = null;
          let runNames = [];
          let headEmpty = false;
          try {
            const entries = await readCommit(sha);
            runNames = entries.runs.map((run) => run.name);
            headEmpty = entries.runs.length === 0 && entries.statuses.length === 0;
            items = all
              ? allItems(entries)
              : requiredItems(entries, await contextsOf(base, listed), sha);
          } catch (raw) {
            // A failure that `gh pr checks` lists settles the wait, so a commit or source read
            // that fails never delays it. The bound and every other failure still end it.
            const err = failureOf(raw);
            if (err?.transient && !(err instanceof BoundReached)) {
              // A server error is retried on the next poll, unless a listed failure settles the wait.
              failed = err;
            }
            if (err instanceof BoundReached || (failed === null && prFailures.length === 0)) {
              throw err;
            }
          }
          // The probe runs once, only for an `--all` wait that names no expected check, after
          // `gh pr checks` listed nothing and the by-SHA read of the PR head found no check run and no
          // commit status, so a state on the PR head never gives way to the probe (ADR 0048).
          if (items !== null && all && expect.length === 0 && !probed && headEmpty) {
            probed = true;
            try {
              if (listed.checks.length === 0 && (await noCheckSource(sha, base))) {
                return { timedOut: false, noCheckSource: true, head: sha, checks: [] };
              }
            } catch (raw) {
              // A failed probe read keeps the normal wait. The bound still ends it.
              const err = failureOf(raw);
              if (err instanceof BoundReached) {
                throw err;
              }
            }
          }
          if (failed !== null && prFailures.length === 0) {
            outcome = { settled: false, checks: [], unread: true };
          } else if (items === null) {
            // No state was read for `sha`, so the result names no head and holds no check.
            outcome = { settled: true, checks: [], unread: true };
          } else {
            const read = readOutcome(
              pr,
              asRead(items),
              all,
              `the check runs and commit statuses of ${sha}`,
            );
            // The commit states only make the outcome stricter. A failing state, or a failure
            // that `gh pr checks` lists, settles the wait, and a listed failure is reported in
            // `prFailures`, never in `checks`. A pass needs both the PR outcome and the commit
            // states to pass, so a pending or not yet reported PR answer keeps waiting.
            // An expected name needs a check run: a commit status of that name is no run on `sha`.
            awaiting = expect.filter((name) => !runNames.includes(name));
            outcome = {
              settled:
                prFailures.length > 0 ||
                items.some(isFailing) ||
                (read.settled && listed.settled && awaiting.length === 0),
              checks: read.checks,
            };
          }
        }
        // A new head drops the kept checks, so the envelope never pairs them with it.
        if (!outcome.unread && sha !== lastHead) {
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
            head: outcome.unread ? null : sha,
            checks: outcome.checks,
            ...(prFailures.length > 0 ? { prFailures } : {}),
          };
        }
      }
      // A completed poll replaces the error of an earlier one: only the latest poll keeps it.
      transient = failed;
      if (!(await pause())) {
        if (transient !== null) {
          throw transient;
        }
        return timeout();
      }
    }
  };
  try {
    return seal(await poll());
  } catch (raw) {
    let err = failureOf(raw);
    if (err instanceof BoundReached) {
      unconfirmed ||= Boolean(err.result.childExitUnconfirmed);
      // A listed failure is reported with the bound, so an earlier server error never replaces it.
      if (transient === null || prFailures.length > 0) {
        return seal(timeout());
      }
      err = transient;
    }
    // An error envelope carries the unconfirmed exit too: a child may still run.
    if (unconfirmed && err instanceof Error) {
      err.childExitUnconfirmed = true;
    }
    throw err;
  }
}
