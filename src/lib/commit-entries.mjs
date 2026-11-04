// Reads the check runs and commit statuses of a commit, and judges one required
// context against them (#218). Both types are considered, because a required name
// can appear as either type. The finish gate, the check wait, the status read, and
// the source probe share these reads.
import { ghApi, inOrder, pagedRead } from "./gh-api.mjs";
import { isJsonObject } from "./json.mjs";

// A check run passes with one of these conclusions; every other conclusion and
// every non-completed status fails the gate.
const PASS_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

const CHECK_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const COMMIT_STATUS_STATES = new Set(["error", "failure", "pending", "success"]);

// The status read, the check wait, and the source probe parse the check-run and commit-status
// replies strictly. The gate accepts a missing or malformed field as an empty list. In strict mode,
// a reply that is not the paginated shape, or that holds an entry the judgment cannot read, throws.
// The reader then reports it as unresolved instead of judging the entries that did parse. The
// latest entry for a name decides, so an id or a timestamp that cannot be ordered is malformed too.
// Such an entry can rank an old pass above a newer failure (issue #349).
function pagesOf(data, field, what) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`malformed ${what} reply`);
  }
  return data.flatMap((page) => {
    if (!isJsonObject(page) || !Array.isArray(page[field])) {
      throw new Error(`malformed ${what} reply`);
    }
    return page[field];
  });
}

// Validates with `Date.parse`, looser than `parseTime`. `latestBy` returns a lone entry without
// parsing its timestamp. A stricter check here refuses a read that the judgment accepts.
const isOrderable = (entry, fields) =>
  Number.isFinite(entry.id) &&
  fields.some(
    (field) => typeof entry[field] === "string" && !Number.isNaN(Date.parse(entry[field])),
  ) &&
  fields.every((field) => entry[field] == null || !Number.isNaN(Date.parse(entry[field])));

/**
 * The entries of the list `field` of the commit endpoint `endpoint`, every page. `strict` makes a
 * reply throw `malformed ${what} reply` when it is not paginated or an entry fails `isWellFormed`.
 */
async function commitList(gh, slug, sha, cwd, strict, { endpoint, field, what, isWellFormed }) {
  const pages = await ghApi(
    pagedRead(gh, field),
    [`repos/${slug}/commits/${sha}/${endpoint}`],
    cwd,
  );
  if (!strict) {
    return pages.flatMap((page) => page?.[field] ?? []);
  }
  const entries = pagesOf(pages, field, what);
  if (!entries.every(isWellFormed)) {
    throw new Error(`malformed ${what} reply`);
  }
  return entries;
}

// The timestamp fields that order the entries of one name, as `latestBy` and `isOrderable` read them.
export const RUN_TIME_FIELDS = ["started_at", "completed_at"];
export const STATUS_TIME_FIELDS = ["updated_at", "created_at"];

const isWellFormedRun = (run) =>
  isJsonObject(run) &&
  typeof run.name === "string" &&
  run.name !== "" &&
  CHECK_RUN_STATUSES.has(run.status) &&
  !(run.status === "completed" && typeof run.conclusion !== "string") &&
  // A queued run has not started, so it can carry no start time.
  (run.status === "completed" || run.status === "in_progress"
    ? isOrderable(run, RUN_TIME_FIELDS)
    : Number.isFinite(run.id));

const isWellFormedStatus = (status) =>
  isJsonObject(status) &&
  typeof status.context === "string" &&
  status.context !== "" &&
  COMMIT_STATUS_STATES.has(status.state) &&
  isOrderable(status, STATUS_TIME_FIELDS);

/** The check runs of `sha`, every page. `strict` makes a malformed reply throw. */
export const checkRuns = (gh, slug, sha, cwd, strict = false) =>
  commitList(gh, slug, sha, cwd, strict, {
    endpoint: "check-runs",
    field: "check_runs",
    what: "check-runs",
    isWellFormed: isWellFormedRun,
  });

/** The commit statuses of `sha`, every page. `strict` makes a malformed reply throw. */
export const commitStatuses = (gh, slug, sha, cwd, strict = false) =>
  commitList(gh, slug, sha, cwd, strict, {
    endpoint: "status",
    field: "statuses",
    what: "commit status",
    isWellFormed: isWellFormedStatus,
  });

/**
 * The check runs and commit statuses of `sha`, read together. A failure throws as `inOrder` does,
 * so a caller unwraps it with `failureOf`.
 */
export async function commitEntries(gh, slug, sha, cwd, strict = false) {
  const [runs, statuses] = await inOrder(gh, [
    (read) => checkRuns(read, slug, sha, cwd, strict),
    (read) => commitStatuses(read, slug, sha, cwd, strict),
  ]);
  return { runs, statuses };
}

// The commit GitHub evaluates: the test merge commit when it carries a check
// run or a commit status, the head commit otherwise. The same selection yields
// the result GitHub shows for the pull request.
export async function evaluatedState(gh, slug, info, cwd, strict = false) {
  const head = info.headRefOid;
  const merge = info.potentialMergeCommit?.oid ?? null;
  if (merge && merge !== head) {
    const entries = await commitEntries(gh, slug, merge, cwd, strict);
    if (entries.runs.length > 0 || entries.statuses.length > 0) {
      return { commit: merge, ...entries };
    }
  }
  return { commit: head, ...(await commitEntries(gh, slug, head, cwd, strict)) };
}

// A timestamp as the instant to the millisecond plus the fractional digits below
// it, so distinct sub-millisecond times and offsets order exactly. Only the RFC
// 3339 shape that GitHub returns is accepted: uppercase `T`, `Z` or a numeric
// offset, optional fractional digits. Null for any other value.
function parseTime(raw) {
  const match =
    typeof raw === "string" &&
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(raw);
  if (!match) {
    return null;
  }
  const digits = match[2] ?? "";
  const ms = Date.parse(`${match[1]}.${digits.slice(0, 3).padEnd(3, "0")}${match[3]}`);
  return Number.isNaN(ms) ? null : { ms, below: digits.slice(3) };
}

function compareTime(a, b) {
  if (a.ms !== b.ms) {
    return a.ms - b.ms;
  }
  const width = Math.max(a.below.length, b.below.length);
  const [x, y] = [a.below.padEnd(width, "0"), b.below.padEnd(width, "0")];
  return x < y ? -1 : x > y ? 1 : 0;
}

// The most recent entry: the later of the first present timestamp in `fields`,
// then the larger numeric id when times tie. Null when a group of several entries
// holds an entry with a non-numeric id or a missing or unparseable timestamp.
// The order is then unknown, and the caller must not pass the group. A single
// entry needs no order and is returned as is. GitHub evaluates the latest run for
// a name. An earlier failing run that a later run replaces does not fail the gate.
export function latestBy(entries, fields) {
  if (entries.length === 1) {
    return entries[0];
  }
  let latest = null;
  let latestTime = null;
  for (const entry of entries) {
    const time = parseTime(fields.map((field) => entry[field]).find((value) => value != null));
    if (!Number.isFinite(entry.id) || time === null) {
      return null;
    }
    const order = latest === null ? 1 : compareTime(time, latestTime) || entry.id - latest.id;
    if (order >= 0) {
      latest = entry;
      latestTime = time;
    }
  }
  return latest;
}

/** The display label of a required context: its name, with `(app <id>)` when an app qualifies it. */
export function contextLabel(name, appId) {
  return appId === null ? name : `${name} (app ${appId})`;
}

/**
 * The check runs and commit statuses that can satisfy a required context. A commit status
 * carries no app, so it can never satisfy an app-qualified context.
 */
export function matchingEntries({ name, appId }, runs, statuses) {
  return {
    runs: runs.filter((run) => run.name === name && (appId === null || run.app?.id === appId)),
    statuses: appId === null ? statuses.filter((status) => status.context === name) : [],
  };
}

// Null when the required context passes, or `{ kind, reason }` where `kind` is
// `missing`, `pending`, or `failing` and `reason` names the condition. An
// app-qualified context is satisfied only by a check run from that app. An
// unqualified context is satisfied by a check run or a commit status with the
// name. Both types must pass when both carry an unqualified name.
export function evaluateContext({ name, appId }, commit, runs, statuses) {
  const label = contextLabel(`"${name}"`, appId);
  const { runs: matchingRuns, statuses: matchingStatuses } = matchingEntries(
    { name, appId },
    runs,
    statuses,
  );

  if (matchingRuns.length === 0 && matchingStatuses.length === 0) {
    return { kind: "missing", reason: `required check ${label} is missing on ${commit}` };
  }

  // The reason is the first unmet condition, which is what the gate reports. The
  // kind is the worst condition among all entries that share the name. A pending
  // latest entry does not hide a failing entry beside it. That entry can be
  // another run, an earlier run, or a commit status (issue #349).
  let problem = null;
  const runFailed = (run) =>
    run.status === "completed" && !PASS_CHECK_CONCLUSIONS.has(run.conclusion);
  const statusFailed = (status) => status.state === "error" || status.state === "failure";
  // A group whose order is unknown never passes. It fails when an entry failed
  // and is pending otherwise.
  const unordered = (failed) => ({
    kind: failed ? "failing" : "pending",
    reason: `required check ${label} is ${failed ? "failing" : "pending"} (its entries cannot be ordered)`,
  });
  if (matchingRuns.length > 0) {
    const run = latestBy(matchingRuns, RUN_TIME_FIELDS);
    if (run === null) {
      problem = unordered(matchingRuns.some(runFailed));
    } else if (run.status !== "completed") {
      problem = {
        kind: "pending",
        reason: `required check ${label} is pending (check run status ${run.status})`,
      };
    } else if (!PASS_CHECK_CONCLUSIONS.has(run.conclusion)) {
      problem = {
        kind: "failing",
        reason: `required check ${label} failed (check run conclusion ${run.conclusion})`,
      };
    }
  }

  if (matchingStatuses.length > 0) {
    const status = latestBy(matchingStatuses, STATUS_TIME_FIELDS);
    if (status === null) {
      problem ??= unordered(matchingStatuses.some(statusFailed));
    } else if (status.state !== "success" && problem === null) {
      problem = {
        // A pending commit status has not failed: the reason text stays the gate's.
        kind: status.state === "pending" ? "pending" : "failing",
        reason: `required check ${label} failed (commit status ${status.state})`,
      };
    }
  }

  if (problem === null) {
    return null;
  }
  const anyFailure = matchingRuns.some(runFailed) || matchingStatuses.some(statusFailed);
  return anyFailure ? { ...problem, kind: "failing" } : problem;
}
