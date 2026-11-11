// Reads the replies that the required-check wait judges. It covers a `gh pr checks` list, a
// `gh pr view` head, and the check runs and commit statuses of one commit. It holds no poll state.
import { ghReadError } from "./gh-api.mjs";
import {
  contextLabel,
  evaluateContext,
  latestBy,
  matchingEntries,
  RUN_TIME_FIELDS,
  STATUS_TIME_FIELDS,
} from "./commit-entries.mjs";
import { EXIT_PENDING, NO_CHECKS_YET, NO_REQUIRED_CHECKS } from "./ci-required-sources.mjs";
import { isFullSha } from "../git-sha.mjs";
import { isJsonObject, tryParseJson } from "../json.mjs";

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

export function isFailing(check) {
  return check.bucket === "fail" || check.bucket === "cancel" || FAILING_STATES.has(check.state);
}

/**
 * One required-check read, mapped to the wait outcome that the `gh` exit code and the check list
 * carry. A failing check is settled. A pending read, or an empty one on exit 0, keeps the wait
 * running. The exact no-required-check and no-checks-yet replies are read here. Throws when the
 * read is unresolved, so it never reads as a pass.
 */
export function readOutcome(pr, { status, stdout, stderr }, all, source = null) {
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
 * The PR head and merge state that one `gh pr view` read reports: `{ head, base, conflicting }`.
 * A `CONFLICTING` mergeable value or a `DIRTY` merge state is a conflict. A missing or unreadable
 * one is no conflict, so a value the wait cannot read never ends it as one.
 * Throws when the read failed or names no full SHA or base branch, so an unreadable head is
 * unresolved, never a pass.
 */
export function readHead(pr, { status, stdout, stderr }) {
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
  const conflicting = parsed.mergeable === "CONFLICTING" || parsed.mergeStateStatus === "DIRTY";
  return { head: head.toLowerCase(), base, conflicting };
}

// The check items of one commit, read by SHA. `gh pr checks` queries by PR identity and names no
// commit, so it cannot say which head its states describe (#961). The check runs and commit
// statuses of the commit come from `commits/{sha}`. A required context is judged by the gate's
// own matching and verdict (`matchingEntries`, `evaluateContext`). An app-qualified context needs
// a run of that app, and the latest matching entry decides.
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
 * commit status of each context. An app is part of the key. A newer run of one app never
 * masks a failing run of the same name under another app.
 */
export function allItems({ runs, statuses }) {
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
 * matching entry in that state, or a synthetic item when only the verdict says so. A context
 * with no matching entry has not reported on the commit, so it is pending.
 */
export function requiredItems({ runs, statuses }, contexts, commit) {
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
export function asRead(items) {
  const status = items.some(isFailing) ? 1 : items.some(isPending) ? EXIT_PENDING : 0;
  return { status, stdout: JSON.stringify(items), stderr: "" };
}
