// Bounded wait for the required checks of one pull request. The interactive
// parent has no harness-independent way to bound `gh pr checks --watch`: `gh`
// takes no timeout for the watch, and a shell `timeout` exists on neither
// Windows nor macOS by default. The runtime owns the bound instead (issue #329).
import { setTimeout as delay } from "node:timers/promises";
import {
  canceledError,
  requiredAbsence,
  requiredNamesRefusal,
  requiredResolutionRefusal,
} from "./ci-gate.mjs";
import {
  commitEntries,
  contextLabel,
  evaluateContext,
  latestBy,
  matchingEntries,
  RUN_TIME_FIELDS,
  STATUS_TIME_FIELDS,
} from "./commit-entries.mjs";
import {
  EXIT_PENDING,
  NO_CHECKS_YET,
  NO_REQUIRED_CHECKS,
  repoSlug,
  requiredContexts,
  requiredNamesOf,
  UNKNOWN,
} from "./ci-required-sources.mjs";
import { noCheckSource, pullRequestWorkflowMayRun } from "./check-source-probe.mjs";
import { failureOf, ghReadError, runGh, withSignal } from "./gh-api.mjs";
import { readProp } from "./error-message.mjs";
import { isFullSha } from "./git-sha.mjs";
import { isJsonObject, tryParseJson } from "./json.mjs";

// The app of the check runs that a workflow of the repository registers.
const ACTIONS_APP_SLUG = "github-actions";

/** Default wait bound, in seconds. Short enough to fit a harness command timeout. */
export const DEFAULT_WAIT_SECONDS = 300;

/**
 * Milliseconds the command keeps waiting for an abandoned `gh` read to exit after
 * the bound elapses, so the command confirms the child is gone. The total bound
 * of a wait is therefore `timeoutSeconds` plus this ceiling (#329).
 */
export const CHILD_EXIT_CEILING_MS = 5000;

const POLL_INTERVAL_MS = 15_000;

// Every value a well-formed item can carry, so an item the runtime cannot read
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
 * One required-check read, mapped to the wait outcome that the `gh` exit code and the check list
 * carry. A failing check is settled. A pending read, or an empty one on exit 0, keeps the wait
 * running. The exact no-required-check and no-checks-yet replies are read here. Throws when the
 * read is unresolved, so it never reads as a pass.
 */
function readOutcome(pr, { status, stdout, stderr }, all, source = null) {
  const label = source ?? `gh pr checks ${pr}${all ? "" : " --required"}`;
  const text = stdout.trim();
  let checks = [];
  if (text !== "") {
    const parsed = tryParseJson(text);
    if (!Array.isArray(parsed)) {
      // An unparseable output is a read error (#329).
      throw ghReadError(label, { status, stdout, stderr });
    }
    const items = parsed.map(readItem);
    // A list item that is not well formed is unresolved too, so one unreadable item cannot settle
    // the list as a pass.
    const bad = items.findIndex((item) => item === null);
    if (bad !== -1) {
      throw new Error(
        `${label} returned a check item that is not well formed at index ${bad}; the read is unresolved.`,
      );
    }
    checks = items;
  }
  // A listed failing check is settled, whichever code answered, and the failure is reported rather
  // than waited out.
  if (checks.some(isFailing)) {
    return { settled: true, checks };
  }
  // Only the pending exit code, or exit 0 with a pending item, keeps the wait running. Exit 1
  // with a pending list and no failing check is a read error, so it is not waited
  // out as pending (#894).
  if (status === EXIT_PENDING || (status === 0 && checks.some(isPending))) {
    return { settled: false, checks };
  }
  // An empty list on exit 0 keeps waiting, because `gh pr checks --required` omits a check that
  // has not started. An exit 0 with no settled check keeps it running too. The same empty list on
  // exit 1 is not that. Exit 1 with no failing check listed is a read error unless `gh` names no
  // required check or no check has reported yet (#941, #950). Any other exit 1 falls through to the
  // refusal below.
  if (status === 0 && checks.length > 0) {
    return { settled: true, checks };
  }
  // Exit 1 with no output and the exact `no required checks reported` reply is settled as
  // `noRequiredChecks`. The branch has no required check to wait for, which is no pass either
  // (#894). The all-checks read has no such answer, so its stderr is unresolved, like every other
  // exit 1 with no failing check listed (#896).
  if (!all && status === 1 && text === "" && NO_REQUIRED_CHECKS.test(stderr.trim())) {
    return { settled: true, checks, noRequiredChecks: true };
  }
  // Exit 1 with no output and the exact `no checks reported` reply is an empty list that is not
  // settled. The wait continues, because no check has reported on the PR head yet (#941). The
  // all-checks read applies the same rule (#950).
  if (status === 1 && text === "" && NO_CHECKS_YET.test(stderr.trim())) {
    return { settled: false, checks, noChecksYet: true };
  }
  // Exit 1 with no failing check listed covers a read error, and any other code is unresolved (#329).
  if (status !== 0) {
    throw ghReadError(label, { status, stdout, stderr });
  }
  return { settled: false, checks };
}

/**
 * The PR head `{ head, base }` that a `gh pr view --json headRefOid,baseRefName` read reports, the
 * head lowercase. Throws when the read failed or names no full SHA or base branch, so an
 * unreadable head is unresolved, never a pass.
 */
function readHead(pr, { status, stdout, stderr }) {
  const label = `gh pr view ${pr}`;
  if (status !== 0) {
    throw ghReadError(label, { status, stdout, stderr });
  }
  const parsed = tryParseJson(stdout);
  // A null parse is refused below, as a missing head or base branch.
  const head = isJsonObject(parsed) ? parsed.headRefOid : undefined;
  const base = isJsonObject(parsed) ? parsed.baseRefName : undefined;
  if (typeof head !== "string" || !isFullSha(head.toLowerCase())) {
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
  return [...Map.groupBy(entries, keyOf)].map(([key, group]) => {
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
      (run) => contextLabel(run.name, run.app?.id ?? "none"),
      RUN_TIME_FIELDS,
      "check runs",
    ).map(runItem),
    ...latestOfEach(
      statuses,
      (status) => status.context,
      STATUS_TIME_FIELDS,
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
        ...(matching.runs.length > 0 ? [runItem(latestBy(matching.runs, RUN_TIME_FIELDS))] : []),
        ...(matching.statuses.length > 0
          ? [statusItem(latestBy(matching.statuses, STATUS_TIME_FIELDS))]
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
  const status = items.some(isFailing) ? 1 : items.some(isPending) ? EXIT_PENDING : 0;
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
async function readWithin(gh, argv, cwd, remainingMs, signal, dropEnv, childExitCeilingMs) {
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
          ceiling = setTimeout(() => resolve(false), childExitCeilingMs);
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

// Whether a names read failed with a server error or a transport failure. The refusal holds no
// unparseable reply. The next poll retries it, and the error names the cause (#1121, #1312).
const namesRetryable = (required) => required.namesTransient && required.unparsed.length === 0;
const namesCause = (required) => (namesRetryable(required) ? `: ${required.namesFailure}` : "");
const unresolved = (required, refusal) => {
  const err = new Error(`${refusal}; the read is unresolved.`);
  if (namesRetryable(required)) {
    err.transient = true;
  }
  return err;
};

// The contexts the required wait judges: every source of the gate, so an app-qualified
// context keeps its app, plus the names `gh pr checks --required` listed. `context` is
// `{ bounded, slug, pr, cwd, sourceCache }`: the wait's bounded runner, the repository slug, the
// pull request, the directory, and the ruleset and protection results of the base branch that the
// wait reads once. A rules change during the wait is not seen by this wait. The `--require-ci`
// finish gate reads both sources again, so the finish judges the current rules (#1267).
async function contextsOf({ bounded, slug, pr, cwd, sourceCache }, base, listed, names) {
  const required = await requiredContexts(bounded, slug, base, pr, cwd, { names, sourceCache });
  // The gate's own refusals, and any source that settled nothing: such a source may hold a
  // required check or an app qualifier that this read never saw, so no pass can follow.
  const refusal = requiredResolutionRefusal(required, pr, namesCause(required));
  if (refusal) {
    throw unresolved(required, refusal);
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
}

// Whether the `gh` no-required-checks answer is an established absence, decided by the same
// `requiredAbsence` the `--require-ci` gate uses (#1013). A source that settled nothing, and a
// ruleset read that found no rule beside no named check, are errors that name the cause,
// because the gate refuses the same states. A source that names a required
// check is no absence, so the wait goes on to judge it. The `no checks reported` reply (#1091)
// refuses only when no source can state the required checks: both configuration sources are
// unreadable and no check is named. A malformed reply of
// one source says nothing about the other, so it is not judged. A source that names a check or
// states the absence keeps the wait running whatever the other returned (#941). A server error or a
// transport failure of a source read carries `transient` and the poll retries it. The names are those of the poll's
// own `gh pr checks --required` read, which is the reply that raised the question, so no names
// read can fail here (#1125). `context` is the one of `contextsOf`.
async function absenceOf(
  { bounded, slug, pr, cwd, sourceCache },
  base,
  names,
  reply = "no required check",
) {
  const noChecksYet = reply === "no checks";
  const required = await requiredContexts(bounded, slug, base, pr, cwd, {
    retryable: noChecksYet,
    names,
    sourceCache,
  });
  // A no-checks-reported poll accepts its names read, which is the `no checks reported` reply
  // itself. Any other refusal stands, and only a clean server error or a transport failure is
  // retried (#1121, #1312).
  const namesRefusal = noChecksYet
    ? null
    : requiredNamesRefusal(required, pr, namesCause(required));
  if (namesRefusal) {
    throw unresolved(required, namesRefusal);
  }
  const absence = requiredAbsence(required);
  if (absence?.absent) {
    return true;
  }
  const noSource =
    absence && required.rulesetState === UNKNOWN && required.protectionState === UNKNOWN
      ? required.unknown
      : [];
  const unproven = noChecksYet ? noSource : (absence?.unproven ?? required.unknown);
  if (unproven.length > 0) {
    throw new Error(
      `gh pr checks ${pr} --required reported ${reply}, but ${unproven.join(" and ")} did not state that it holds no required check, so the required checks of PR ${pr} are unresolved.`,
    );
  }
  return false;
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
 * report one for the PR head (see `noCheckSource` in `check-source-probe.mjs`): the wait ends at once with an empty `checks`,
 * and it is no pass (#1054).
 * `expect` names check runs that the `--all` wait must see on `sha` before a pass, matched by exact
 * name against the check runs only, whichever app made them, never against commit statuses: a third-party app can
 * register a check run after the first ones passed, so a pass without it is not evidence. A
 * missing expected name keeps the wait running to the bound, where `awaiting` lists it. A failing
 * check still settles the wait (#978).
 * An `--all` pass is held while a workflow of the base branch may run for the PR (see
 * `pullRequestWorkflowMayRun`) and `sha` has no check run from GitHub Actions: a workflow registers
 * its run after a fast check of another app passed. The hold skips only a workflow that provably
 * cannot run, so a read that fails or a form that is not settled holds too. It needs no `expect` name,
 * ends at the bound with `timedOut: true`, and a failing check still settles the wait (#1228).
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
 * which holds only states read for `head`, and it survives the bound. A required context that
 * cannot be resolved (a source that cannot be read or parsed, or a failed read of the names) is
 * an error, because no pass can follow it. A check that is required but that no read of the PR
 * lists yet is absent. With `head`, a poll whose PR head is another commit reads no
 * checks and the wait continues. The
 * PR head is the one read at the start of the poll, so the PR can have moved on by the time
 * the wait returns. `head` is null when no read completed, such as a wait that reached the
 * bound before the PR head reached `head` (#961).
 *
 * A retryable server error or transport failure of a read is retried on the next poll. One that
 * lasts to the bound throws, so it is never `timedOut: true` and never a pass. A transport failure
 * carries no HTTP status and no reply body. A 4xx, a 5xx with an unreadable body, and a text with no
 * known transport wording stay terminal. The `--require-ci` finish gate still fails closed on every
 * read failure.
 *
 * `deadline` is an absolute time on the `now` clock. A caller passes it to bound
 * the whole command, including the work that runs before the first read; a
 * caller that passes only `timeoutSeconds` is bounded from this call (#329).
 * @param {{ pr: number, cwd: string, timeoutSeconds?: number, deadline?: number | null, all?: boolean,
 *           head?: string | null, expect?: string[], gh?: Function, now?: Function, sleep?: Function, signal?: AbortSignal | null }} options
 * @returns {Promise<{ timedOut: boolean, head: string | null, checks: Array<{ name: string, state: string|null, bucket: string|null }>, prFailures?: Array<{ name: string, state: string|null, bucket: string|null }>, awaiting?: string[], noRequiredChecks?: true, noCheckSource?: true, childExitUnconfirmed?: true }>}
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
  // Injectable so a test can use a short bound; production keeps the 5000 ms default (issue #1465).
  childExitCeilingMs = CHILD_EXIT_CEILING_MS,
  signal = null,
}) {
  if (head !== null && !isFullSha(head)) {
    throw new Error("head must be a full lowercase commit SHA.");
  }
  const context = createWaitContext({
    pr,
    cwd,
    timeoutSeconds,
    deadline,
    all,
    head,
    expect,
    gh,
    now,
    sleep,
    childExitCeilingMs,
    signal,
  });
  try {
    return seal(context, await poll(context));
  } catch (raw) {
    let err = failureOf(raw);
    if (err instanceof BoundReached) {
      context.unconfirmed ||= Boolean(err.result.childExitUnconfirmed);
      // A listed failure is reported with the bound, so an earlier retryable failure never replaces it.
      if (context.transient === null || context.prFailures.length > 0) {
        return seal(context, timeoutOf(context));
      }
      err = context.transient;
    }
    // An error envelope carries the unconfirmed exit too: a child can still run.
    if (context.unconfirmed && err instanceof Error) {
      err.childExitUnconfirmed = true;
    }
    throw err;
  }
}

/**
 * Builds the inputs and mutable state of one wait.
 * The wait helpers read and write this object, so every poll shares one cache.
 * @param {object} options The resolved options of `waitChecks`.
 */
function createWaitContext(options) {
  const context = {
    pr: options.pr,
    cwd: options.cwd,
    all: options.all,
    head: options.head,
    expect: options.expect,
    gh: options.gh,
    now: options.now,
    sleep: options.sleep,
    childExitCeilingMs: options.childExitCeilingMs,
    signal: options.signal,
    end: options.deadline ?? options.now() + options.timeoutSeconds * 1000,
    checksArgv: [
      "pr",
      "checks",
      String(options.pr),
      ...(options.all ? [] : ["--required"]),
      "--json",
      "name,state,bucket",
    ],
    headArgv: ["pr", "view", String(options.pr), "--json", "headRefOid,baseRefName"],
    last: [],
    lastHead: null,
    slug: null,
    // Set by every read of the wait whose child exit was not observed. A sibling read that the
    // first failure of a group left running to the ceiling sets it too.
    unconfirmed: false,
    // The failures that `gh pr checks` listed in the current poll. They are PR-level evidence,
    // not pinned to a commit, so they ride apart from `checks`, which holds states read for `head`.
    prFailures: [],
    // The expected check names that the last poll found no run for on its head.
    awaiting: [],
    // The ruleset and protection results of the base branch, read once per wait. A rules change during
    // the wait is not seen by this wait. The `--require-ci` finish gate reads both sources again, so the
    // finish judges the current rules (#1267).
    sourceCache: new Map(),
    // Whether the probe of `noCheckSource` settled. A retryable failure leaves it unset, so the next
    // poll probes again.
    probed: false,
    // The retryable failure of the current poll, or null. The next poll retries it, and a wait that
    // reaches the bound with it set reports it as an error (#1025, #1312).
    failed: null,
    // Whether a workflow of the base branch can run for the PR head `sha`, read once per head. A read
    // that fails or is not settled holds the pass, is not kept, and is read again on the next poll (#1228).
    workflowMayRun: { sha: null, value: true },
    // The retryable failure of the latest completed poll, or null when that poll had none. It is a
    // server error or a transport failure. A wait that ends on the bound with it set reports it as an
    // error. Neither then reads as a timeout or a pass (#1025, #1312).
    transient: null,
  };
  const boundedRead = (argv, readCwd, readOptions) =>
    readBounded(context, argv, readCwd, readOptions);
  context.bounded = context.signal ? withSignal(boundedRead, context.signal) : boundedRead;
  return context;
}

/** The envelope of a wait that ended on its bound, with the last states the poll read. */
function timeoutOf(context) {
  return {
    timedOut: true,
    head: context.lastHead,
    checks: context.last,
    ...(context.awaiting.length > 0 ? { awaiting: context.awaiting } : {}),
    ...(context.prFailures.length > 0 ? { prFailures: context.prFailures } : {}),
  };
}

/**
 * The one place that adds `childExitUnconfirmed`.
 * Every envelope the wait returns passes through it, settled or timed out, and the catch below carries the flag on an error.
 */
function seal(context, envelope) {
  return context.unconfirmed ? { ...envelope, childExitUnconfirmed: true } : envelope;
}

/**
 * Runs one read bounded by the time left, so the commit reads share the deadline of the checks read.
 * A group of reads passes its own signal, which stops the siblings of a failed read.
 * A read that reaches the bound throws `BoundReached` with its result.
 */
async function readBounded(context, argv, _cwd, options = {}) {
  const remaining = context.end - context.now();
  if (remaining <= 0) {
    throw new BoundReached({});
  }
  const result = await readWithin(
    context.gh,
    argv,
    context.cwd,
    remaining,
    options.signal ?? null,
    options.dropEnv,
    context.childExitCeilingMs,
  );
  if (result.timedOut) {
    context.unconfirmed ||= Boolean(result.childExitUnconfirmed);
    throw new BoundReached(result);
  }
  return result;
}

/** Reads the repository slug once, and reuses it for every later read. */
async function ensureSlug(context) {
  context.slug ??= await repoSlug(context.bounded, context.cwd, "could not be read");
}

/**
 * Reads the gate's own check-run and commit-status entries of `sha`, after the repository slug read.
 * They page by page number with one `gh api --include` request per page. They never follow the
 * `Link` header, which they reject when it names another host (see `pagedRead`). A failed read is
 * marked `transient`, and the wait retries it on the next poll. That needs a first-line status of
 * 500, 502, 503, or 504 with a body that is empty, JSON, or truncated JSON. It also covers a
 * transport failure with no status line and no body (#1312).
 */
async function readCommit(context, sha) {
  await ensureSlug(context);
  // Every other failure ends the wait. Any other status, a 4xx whatever its body says, and a
  // failure with no status block end it.
  // A successful reply whose body is not exactly one JSON value ends it too.
  return commitEntries(context.bounded, context.slug, sha, context.cwd, true);
}

/**
 * Waits for the next poll, or reports that the bound is spent.
 * @returns {Promise<boolean>} False when the bound is spent, so the caller reports it instead of sleeping.
 */
async function pause(context) {
  const left = context.end - context.now();
  if (left <= 0) {
    return false;
  }
  try {
    await context.sleep(Math.min(POLL_INTERVAL_MS, left), context.signal);
  } catch (err) {
    // The sleep rejects on an abort. Report it as the cancel the rest of the role CLI reports, so
    // Ctrl+C exits 130 instead of a read failure.
    if (context.signal?.aborted) {
      throw canceledError();
    }
    throw err;
  }
  return true;
}

/** The wait context that the required-check source and absence reads take. */
function gateContext(context) {
  return {
    bounded: context.bounded,
    slug: context.slug,
    pr: context.pr,
    cwd: context.cwd,
    sourceCache: context.sourceCache,
  };
}

/** Reads the required-check absence of `base` after the repository slug read. */
async function absent(context, base, names, reply) {
  await ensureSlug(context);
  return absenceOf(gateContext(context), base, names, reply);
}

/** Reads the PR head and base branch of the wait. */
async function readPrHead(context) {
  return readHead(context.pr, await context.bounded(context.headArgv));
}

/** The context that the no-check-source probe takes. */
function probeContext(context) {
  return {
    bounded: context.bounded,
    slug: context.slug,
    cwd: context.cwd,
    pr: context.pr,
    headOf: () => readPrHead(context),
  };
}

/**
 * Whether a workflow of the base branch can run for the PR head `sha`, read once per head.
 * A read that fails or is not settled holds the pass, is not kept, and is read again on the next poll (#1228).
 */
async function workflowMayRunFor(context, sha, base) {
  if (context.workflowMayRun.sha !== sha) {
    let value = null;
    try {
      await ensureSlug(context);
      value = await pullRequestWorkflowMayRun(probeContext(context), sha, base);
    } catch (raw) {
      // A failed read holds the pass. A transport failure is kept for the bound, which reports it.
      const err = retryableOrThrow(raw, {
        retryable: (error) => error?.transport,
        settled: () => true,
      });
      if (err !== null) {
        context.failed = err;
      }
    }
    if (value === null) {
      return true;
    }
    context.workflowMayRun = { sha, value };
  }
  return context.workflowMayRun.value;
}

/** Probes for a check source of the PR head `sha` after the repository slug read. */
async function probe(context, sha, base) {
  await ensureSlug(context);
  return noCheckSource(probeContext(context), sha, base);
}

/**
 * The `gh pr` reads of one poll: the head, and the check list when the head is the one waited for.
 * `listed` is null for another head.
 */
async function readPr(context) {
  const { head: sha, base } = await readPrHead(context);
  if (context.head !== null && sha !== context.head) {
    return { sha, base, listed: null };
  }
  const read = await context.bounded(context.checksArgv);
  const listed = readOutcome(context.pr, read, context.all);
  // The required names come from this read, so the poll makes no second `gh pr checks` call (#1125).
  const names = context.all ? null : requiredNamesOf(read);
  if (listed.noRequiredChecks && !(await absent(context, base, names))) {
    listed.noRequiredChecks = false;
    listed.settled = false;
  }
  return { sha, base, listed, names };
}

/**
 * The retryable failure of `raw`, or a throw. The bound always ends the wait and so does a terminal
 * failure, unless `settled` says the poll already holds a failure that ends it. `retryable` names
 * the tag that the read sets for a failure that it can retry. A cancel carries neither tag, so it
 * reaches the caller as the same object.
 */
function retryableOrThrow(
  raw,
  { retryable = (err) => err?.transient, settled = () => false } = {},
) {
  const err = failureOf(raw);
  // A cancel reaches the caller as the same object, with no retry and no hold.
  if (readProp(err, "isCanceled")) {
    throw err;
  }
  if (err instanceof BoundReached || !retryable(err)) {
    if (err instanceof BoundReached || !settled()) {
      throw err;
    }
    return null;
  }
  return err;
}

/**
 * The outcome of one poll that read the check list of `sha`: the commit states read by SHA, or the
 * probe result. A retryable failure of a read is kept in `failed`, and a listed failure settles the
 * wait whatever the commit read returns.
 */
async function commitOutcome(context, sha, base, listed, names) {
  let items = null;
  let runNames = [];
  let actionsRun = false;
  let headEmpty = false;
  try {
    const entries = await readCommit(context, sha);
    runNames = entries.runs.map((run) => run.name);
    actionsRun = entries.runs.some((run) => run.app?.slug === ACTIONS_APP_SLUG);
    headEmpty = entries.runs.length === 0 && entries.statuses.length === 0;
    items = context.all
      ? allItems(entries)
      : requiredItems(entries, await contextsOf(gateContext(context), base, listed, names), sha);
  } catch (raw) {
    // A failure that `gh pr checks` lists settles the wait, so a commit or source read that fails
    // never delays it. The bound and every other failure still end it.
    const err = retryableOrThrow(raw, {
      settled: () => context.failed !== null || context.prFailures.length > 0,
    });
    if (err !== null) {
      // A retryable failure is retried on the next poll, unless a listed failure settles the wait.
      context.failed = err;
    }
  }
  // The probe runs once per settled answer, only for an `--all` wait that names no expected check.
  // It runs after `gh pr checks` listed nothing and the by-SHA read found no check run and no commit status.
  // A state on the PR head never gives way to the probe (ADR 0048).
  if (
    items !== null &&
    context.all &&
    context.expect.length === 0 &&
    !context.probed &&
    headEmpty
  ) {
    try {
      const noSource = await probe(context, sha, base);
      context.probed = true;
      if (listed.checks.length === 0 && noSource) {
        return { settled: true, checks: [], noCheckSource: true };
      }
    } catch (raw) {
      // A transport failure keeps the probe open, so the next poll reads again.
      const err = retryableOrThrow(raw, {
        retryable: (error) => error?.transport,
        settled: () => true,
      });
      if (err !== null) {
        context.failed = err;
      } else {
        context.probed = true;
      }
    }
  }
  if (context.failed !== null && context.prFailures.length === 0) {
    return { settled: false, checks: [], unread: true };
  }
  if (items === null) {
    // No state was read for `sha`, so the result names no head and holds no check.
    return { settled: true, checks: [], unread: true };
  }
  const read = readOutcome(
    context.pr,
    asRead(items),
    context.all,
    `the check runs and commit statuses of ${sha}`,
  );
  // The commit states only make the outcome stricter. A failing state, or a failure
  // that `gh pr checks` lists, settles the wait, and a listed failure is reported in
  // `prFailures`, never in `checks`. A pass needs both the PR outcome and the commit
  // states to pass, so a pending or not yet reported PR answer keeps waiting.
  // An expected name needs a check run: a commit status of that name is no run on `sha`.
  context.awaiting = context.expect.filter((name) => !runNames.includes(name));
  const failing = context.prFailures.length > 0 || items.some(isFailing);
  const passing = read.settled && listed.settled && context.awaiting.length === 0;
  // A pass waits for the run of a base workflow that has not registered on `sha` yet (#1228).
  const held =
    !failing &&
    passing &&
    context.all &&
    !actionsRun &&
    (await workflowMayRunFor(context, sha, base));
  return { settled: failing || (passing && !held), checks: read.checks };
}

/**
 * Polls until the checks settle or the bound ends the wait.
 * Returns the settled envelope, or the last check states when the bound is reached.
 * A retryable failure of the latest poll is thrown when the bound ends the wait.
 */
async function poll(context) {
  for (;;) {
    context.prFailures = [];
    context.failed = null;
    let state = null;
    try {
      state = await readPr(context);
    } catch (raw) {
      // A retryable failure of a `gh pr` read is retried on the next poll.
      context.failed = retryableOrThrow(raw);
    }
    if (state?.listed) {
      const { sha, base, listed, names } = state;
      if (listed.noChecksYet && !context.all) {
        try {
          await absent(context, base, names, "no checks");
        } catch (raw) {
          // A retryable failure of a source read is retried on the next poll.
          context.failed = retryableOrThrow(raw);
        }
      }
      context.prFailures = listed.checks.filter(isFailing);
      // A branch with no required check names no state to read, so it carries no commit read.
      // An empty required list names nothing to read, so the wait continues.
      const outcome =
        !listed.noRequiredChecks && (context.all || listed.checks.length > 0)
          ? await commitOutcome(context, sha, base, listed, names)
          : listed;
      // A new head drops the kept checks, so the envelope never pairs them with it.
      if (!outcome.unread && sha !== context.lastHead) {
        context.last = [];
        context.lastHead = sha;
      }
      // An empty list is not a settled read: `gh pr checks --required` omits a check that has not started.
      // The last reported states are kept for the envelope while the wait continues.
      if (outcome.checks.length > 0) {
        context.last = outcome.checks;
      }
      if (outcome.settled) {
        return {
          timedOut: false,
          ...(outcome.noRequiredChecks ? { noRequiredChecks: true } : {}),
          ...(outcome.noCheckSource ? { noCheckSource: true } : {}),
          head: outcome.unread ? null : sha,
          checks: outcome.checks,
          ...(context.prFailures.length > 0 ? { prFailures: context.prFailures } : {}),
        };
      }
    }
    // A completed poll replaces the error of an earlier one: only the latest poll keeps it.
    context.transient = context.failed;
    if (!(await pause(context))) {
      if (context.transient !== null) {
        throw context.transient;
      }
      return timeoutOf(context);
    }
  }
}
