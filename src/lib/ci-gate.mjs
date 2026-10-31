// Evaluates the `--require-ci` finish gate: every required status check passed
// on the commit GitHub evaluates for the pull request. Check runs and commit
// statuses are both considered, because a required name can appear as either
// type (issue #218).
//
// The `gh` runner is injected so a caller can run the gate against captured
// responses. The default runner shells out to the `gh` CLI.
import { readableErrorText } from "./error-message.mjs";
import { isJsonObject } from "./json.mjs";
import { logWarn } from "./log.mjs";
import {
  boundedCall,
  failureOf,
  ghApi,
  inOrder,
  pagedRead,
  ReadFailure,
  readTimeout,
  runGh,
  withSignal,
} from "./gh-api.mjs";
import {
  ABSENT,
  UNKNOWN,
  EMPTY,
  RULESETS,
  prInfo,
  repoSlug,
  readRulesetState,
  requiredContexts,
} from "./ci-required-sources.mjs";

// A check run passes with one of these conclusions; every other conclusion and
// every non-completed status fails the gate.
const PASS_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function fail(reason) {
  return { ok: false, reason };
}

/** The refusal for a reviewed state that cannot finish, or null when it is a clean reviewed commit. */
function reviewedRefusal(reviewed) {
  if (!reviewed) {
    return fail("the latest reviewer turn has no reviewed state");
  }
  return reviewed.clean ? null : fail("the reviewed work tree is not clean");
}

const headDiffers = () => fail("the PR head differs from the reviewed commit");

/** The refusal for a pull request whose merge state is `BLOCKED` after the check pass. */
const MERGE_BLOCKED_REFUSAL =
  "the PR merge state is blocked (a required check, review, or other required rule is unmet)";

// Every merge state GitHub's GraphQL `mergeStateStatus` reports that the gate can
// act on. A value outside this set, and a missing or null one, is a state the
// gate cannot read, so it refuses on both the per-check path and the absence path
// (issue #336 review). `UNSTABLE` means a check is failing, which the per-check
// path judges by name, and `HAS_HOOKS` and `DRAFT` report no unmet rule the gate
// enforces; `BLOCKED` refuses at the end of both paths. `UNKNOWN` is deliberately
// absent: GitHub computes it lazily, so it states no outcome either.
const MERGE_STATES = new Set([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNSTABLE",
]);

// The merge-state refusals the gate makes before it reads any check: behind its
// base, merge conflicts, and a state the gate cannot read. `UNKNOWN`, which GitHub
// computes lazily, a missing state, and a value outside `MERGE_STATES` are all the
// last kind. Shared with the status read so it cannot report a pass for a state the
// gate refuses (issue #349).
function earlyMergeRefusal(mergeState) {
  if (mergeState === "BEHIND") {
    return "the PR is behind its base branch";
  }
  if (mergeState === "DIRTY") {
    return "the PR has merge conflicts (merge state DIRTY)";
  }
  // The merge state is validated before either path, so the relaxed absence path
  // applies exactly the same merge-state condition as the per-check path. A state
  // that is missing, null, empty, or not one GitHub documents settles nothing, and
  // a state the gate cannot read is not a clean one, so it refuses on both paths
  // rather than passing the absence path on a reply it never understood
  // (issue #336 review).
  if (!MERGE_STATES.has(mergeState)) {
    return "GitHub reports the PR merge state as unknown (computed lazily; retry shortly)";
  }
  return null;
}

const RULESETS_UNREADABLE =
  "the repository rulesets could not be read, so the gate cannot tell which required checks the base branch requires";

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
// replies strictly. The gate accepts a missing or malformed field as an empty list. A reply that is
// not the paginated shape, or that holds an entry the judgment cannot read, throws in strict mode,
// and the reader reports it as unresolved instead of judging the entries that did parse. The
// latest entry for a name decides, so an id or a timestamp that cannot be ordered is malformed too:
// it could rank an old pass above a newer failure (issue #349).
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

// Validates with `Date.parse`, looser than `parseTime`: `latestBy` returns a lone entry without
// parsing its timestamp, so a stricter check here would refuse a read that the judgment accepts.
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
  // A queued run has not started, so it may carry no start time.
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
async function evaluatedState(gh, slug, info, cwd, strict = false) {
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
// holds an entry with a non-numeric id or a missing or unparseable timestamp,
// because the order is then unknown and the caller must not pass the group. A
// single entry needs no order and is returned as is. GitHub evaluates the latest
// run for a name; an earlier failing run that a later run replaces does not fail
// the gate.
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
// `missing`, `pending`, or `failing` and `reason` names the condition. An app-qualified context is satisfied only by a check run from that
// app; an unqualified context is satisfied by a check run or a commit status
// with the name, and both types must pass when both carry an unqualified name.
export function evaluateContext({ name, appId }, commit, runs, statuses) {
  const label = appId === null ? `"${name}"` : `"${name}" (app ${appId})`;
  const { runs: matchingRuns, statuses: matchingStatuses } = matchingEntries(
    { name, appId },
    runs,
    statuses,
  );

  if (matchingRuns.length === 0 && matchingStatuses.length === 0) {
    return { kind: "missing", reason: `required check ${label} is missing on ${commit}` };
  }

  // The reason is the first unmet condition, which is what the gate reports. The
  // kind is the worst condition among all entries that share the name: a pending
  // latest entry does not hide a failing entry beside it, whether that entry is
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

/**
 * Refuses unless the PR head equals the reviewed commit, the reviewed tree is
 * clean, the PR is not behind its base under a strict rule, has no merge
 * conflicts, is not in an unknown merge state, and every required check passed
 * on the commit GitHub evaluates. A blocked merge state refuses after the
 * per-check pass, so a named check refusal keeps its name; any remaining block
 * (a required check that never reported, a required review, or another required
 * rule) fails closed.
 *
 * An unknown repository-rulesets read refuses the finish whatever the rest of the
 * union holds, because that reply can carry a required-status rule this caller
 * never saw. A non-empty union from another source must not let the per-check
 * pass judge only the names it saw (issue #336).
 *
 * An empty union of required checks refuses when the classic-protection source
 * settled nothing, so a source this caller cannot read fails closed and the reason
 * names it. An empty union over sources that each stated they hold no required check
 * is an established absence, which passes and reports `noRequiredChecks: true` so a
 * caller can tell it apart from a gated pass on a branch that required a check
 * (issue #336).
 *
 * The reads end after `timeoutMs` and when `signal` aborts. A cancel wins over every other outcome,
 * a local refusal and a gate result included: an aborted `signal` starts no read, and the call
 * rejects with `isCanceled` set. A deadline rejects with `timedOut` set and a timeout message (#1181).
 * @param {{ pr: number, reviewed: object | null, cwd: string, gh?: Function, timeoutMs?: number, signal?: AbortSignal | null }} options
 * @returns {Promise<{ ok: true, commit: string, noRequiredChecks?: true } | { ok: false, reason: string }>}
 */
export async function checkCi({
  pr,
  reviewed,
  cwd,
  gh = runGh,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  signal = null,
}) {
  return boundedGateRead({ reviewed, gh, timeoutMs, signal }, (call) =>
    judgeCi({ pr, reviewed, cwd, gh: call }),
  );
}

/**
 * Refuses unless the PR is open, the PR head equals the reviewed commit, and the reviewed tree is
 * clean. A closed or merged PR refuses even when its head is unchanged (#1111). This is the
 * head part of `checkCi` alone: it makes the one PR read, whose merge-state field it ignores, so no
 * required-check source is read and no merge state or check result is evaluated or claimed. It serves a repository whose required-check sources
 * settle nothing, where `checkCi` refuses every finish (#1098).
 *
 * The read ends after `timeoutMs` and when `signal` aborts, with the cancel and timeout rules of `checkCi`: an
 * aborted `signal` starts no read and the call rejects with `isCanceled` set, and a deadline rejects with
 * `timedOut` set, never a verified compare (#1200).
 * @param {{ pr: number, reviewed: object | null, cwd: string, gh?: Function, timeoutMs?: number, signal?: AbortSignal | null }} options
 * @returns {Promise<{ ok: true, commit: string } | { ok: false, reason: string }>}
 */
export async function checkPrHead({
  pr,
  reviewed,
  cwd,
  gh = runGh,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  signal = null,
}) {
  return boundedGateRead(
    { reviewed, gh, timeoutMs, signal },
    (call) => prInfo(call, pr, cwd),
    (info) => {
      if (info.state !== "OPEN") {
        return fail(
          typeof info.state === "string"
            ? `PR ${pr} is ${info.state.toLowerCase()}, not open`
            : `PR ${pr} has no readable state, so it is not known to be open`,
        );
      }
      if (info.headRefOid !== reviewed.head) {
        return headDiffers();
      }
      return { ok: true, commit: info.headRefOid };
    },
  );
}

/** The cancel error, as the rest of the role CLI reports it, so Ctrl+C exits 130. */
export const canceledError = () =>
  Object.assign(new Error("Interrupted by SIGINT"), { isCanceled: true });

/** Throws the cancel error (`isCanceled`) when `signal` is aborted. */
function throwIfCanceled(signal) {
  if (signal?.aborted) {
    throw canceledError();
  }
}

/**
 * Whether `err` is the deadline of `call` and not an earlier failure. A failure that a group captured
 * before the deadline fired stays the outcome, so a deadline that expires while the canceled siblings
 * settle cannot replace it.
 */
function readExpired(call, err) {
  return call.deadline.aborted && !(err instanceof ReadFailure && !err.expired);
}

// The bounded read that `checkCi` and `checkPrHead` share. A cancel wins over every other outcome:
// before the read, when the reviewed state refuses, and after the read. `read(call)` runs on the
// bounded runner, and `judge(value)` runs on its value once the cancel check has passed.
async function boundedGateRead(
  { reviewed, gh, timeoutMs, signal },
  read,
  judge = (value) => value,
) {
  throwIfCanceled(signal);
  const refused = reviewedRefusal(reviewed);
  if (refused) {
    return refused;
  }
  const call = boundedCall(gh, timeoutMs, signal);
  let value;
  try {
    value = await read(call);
  } catch (err) {
    throwIfCanceled(signal);
    if (readExpired(call, err)) {
      throw readTimeout(timeoutMs);
    }
    throw failureOf(err);
  }
  throwIfCanceled(signal);
  return judge(value);
}

// The reads that `judgeCi` and `readRequiredChecks` both start with: the PR, the
// repository slug, and the required contexts. The slug read starts beside the PR
// read and is awaited only after the PR refusals; a failure of it surfaces then. It
// ends and settles before the preamble returns, so no `gh` child outlives it. A failure leaves as a
// `ReadFailure` that records whether the deadline had fired when the failure was captured, so a
// cleanup that outlasts the deadline cannot turn that failure into a timeout.
// `refuseInfo(info)` runs right after the PR read and `refuseUnknownRuleset(info)`
// after the contexts read. A truthy return from either comes back as `{ stop }`, so
// each caller keeps its own refusal order and wording. Otherwise the result is
// `{ info, slug, required }`. With `rulesetsOnly`, `required` holds the `rulesetState` alone, read by
// `readRulesetState`, for a caller that judges nothing else.
async function readCiPreamble({
  gh,
  cwd,
  pr,
  refuseInfo,
  refuseUnknownRuleset,
  rulesetsOnly = false,
}) {
  const canceler = new AbortController();
  const slugRead = repoSlug(withSignal(gh, canceler.signal), cwd);
  slugRead.catch(() => {});
  try {
    const info = await prInfo(gh, pr, cwd);
    const infoStop = refuseInfo(info);
    if (infoStop) {
      return { stop: infoStop };
    }
    const slug = await slugRead;
    const required = rulesetsOnly
      ? { rulesetState: await readRulesetState(gh, slug, info.baseRefName, cwd) }
      : await requiredContexts(gh, slug, info.baseRefName, pr, cwd);
    if (required.rulesetState === UNKNOWN) {
      return { stop: refuseUnknownRuleset(info) };
    }
    return { info, slug, required };
  } catch (err) {
    throw err instanceof ReadFailure ? err : new ReadFailure(err, gh.deadline?.aborted ?? false);
  } finally {
    canceler.abort();
    await Promise.allSettled([slugRead]);
  }
}

// Judges each required context on the commit GitHub evaluates.
async function evaluateRequired(gh, slug, info, cwd, contexts, strict) {
  const { commit, runs, statuses } = await evaluatedState(gh, slug, info, cwd, strict);
  const findings = contexts.map((context) => ({
    context,
    failure: evaluateContext(context, commit, runs, statuses),
  }));
  return { commit, findings };
}

// The judgment of `checkCi` after its early guards.
async function judgeCi({ pr, reviewed, cwd, gh }) {
  const preamble = await readCiPreamble({
    gh,
    cwd,
    pr,
    refuseInfo: (info) => {
      const early = earlyMergeRefusal(info.mergeStateStatus);
      if (early) {
        return fail(early);
      }
      if (info.headRefOid !== reviewed.head) {
        return headDiffers();
      }
      return null;
    },
    // An unknown ruleset read refuses the finish whatever the rest of the union
    // holds. Its own reply may carry a required-status rule this caller never saw,
    // and a non-empty union from another source would otherwise let the per-check
    // pass judge only the names it saw, so a ruleset-required check could be skipped
    // (issue #336 review).
    //
    // A successful read that found no rule is not in this branch. It contributes no
    // contexts, and the per-check pass runs on the other sources. A classic-only
    // repository whose required checks passed therefore still finishes. The read
    // is still not a positive absence, so the empty-union refusal below names it.
    refuseUnknownRuleset: () => fail(RULESETS_UNREADABLE),
  });
  if (preamble.stop) {
    return preamble.stop;
  }
  const { info, slug } = preamble;
  const { contexts: required } = preamble.required;
  // A blocked merge state still refuses below, so an absent check set cannot pass a
  // pull request another required rule blocks.
  const absence = requiredAbsence(preamble.required);
  if (absence?.unproven) {
    return fail(
      `no required checks were found for the base branch, and ${absence.unproven.join(" and ")} did not state that it holds no required check, so the gate cannot tell a base branch with no required check from one whose check it never saw`,
    );
  }
  const noRequiredChecks = absence?.absent === true;
  if (noRequiredChecks) {
    if (info.mergeStateStatus === "BLOCKED") {
      return fail(
        "the PR merge state is blocked (a required review or another required rule is unmet)",
      );
    }
    return { ok: true, commit: info.headRefOid, noRequiredChecks: true };
  }
  const { commit, findings } = await evaluateRequired(gh, slug, info, cwd, required, false);
  const first = findings.find(({ failure }) => failure);
  if (first) {
    return fail(first.failure.reason);
  }
  // Run this after the per-check pass so a named check refusal keeps its name.
  // `gh pr checks --required` lists only checks that already reported, so on a
  // classic-protection-only repo a caller without admin rights cannot enumerate
  // a required check that never started; GitHub reports that PR as blocked to such
  // a caller, confirmed live with a non-admin `GITHUB_TOKEN` (#280). When no other
  // required check reported, the empty-union refusal above fires first, because
  // that caller's protection source is unreadable. The REST `mergeable_state`
  // reads `blocked` for an admin and `unstable` for an anonymous caller on that
  // same pull request, so its value depends on the viewer and is not a stable
  // signal. The GraphQL `mergeStateStatus` reads `BLOCKED` for the admin and for
  // a non-admin `GITHUB_TOKEN`, which is what was observed; GraphQL needs
  // authentication, so no anonymous reading of it exists (#280). Other unmet rules
  // (a required review, unresolved conversations, a required deployment) also report
  // blocked, and the gate cannot tell them apart, so it fails closed (#271). The
  // established-absence pass above refuses on it too, because a branch with no
  // required check can still carry another required rule (#336).
  if (info.mergeStateStatus === "BLOCKED") {
    return fail(MERGE_BLOCKED_REFUSAL);
  }

  return { ok: true, commit };
}

/**
 * Why a run that declares `pr` could never finish through the `--require-ci` gate, or null. Reads the
 * repository rulesets of the PR base once, as the gate does, beside the protection source, which only an
 * unsettled rulesets read waits for (a failed protection read ends in null, as it always did), and reports the one answer the gate
 * refuses whatever the other sources hold: a repository-rulesets read that settled nothing, such as
 * the Free-plan 403. A read that fails for another reason, such as the network, logs a warning and
 * returns null, because the gate may read the sources when the run finishes.
 * `when` completes the warning of a failed read: "at start" for a `--pr` start, or the point where a
 * declaration of a worker-opened PR reads. `signal` is the caller cancel: it ends a running read, and
 * the call then rejects with `isCanceled` set instead of logging a warning and returning null.
 * @param {{ pr: number, cwd: string, gh?: Function, timeoutMs?: number, when?: string, signal?: AbortSignal | null }} options
 * @returns {Promise<string | null>}
 */
export async function unreadableGateReason({
  pr,
  cwd,
  gh = runGh,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  when = "at start",
  signal = null,
}) {
  // The signal ends a call that a runner does not bound itself, so a hung `gh` cannot hold the start open.
  const call = boundedCall(gh, timeoutMs, signal);
  // A canceled read fails like any other read, so the cancel is told from the failure by the signal.
  try {
    const preamble = await readCiPreamble({
      gh: call,
      cwd,
      pr,
      refuseInfo: () => null,
      refuseUnknownRuleset: () => RULESETS_UNREADABLE,
      rulesetsOnly: true,
    });
    throwIfCanceled(signal);
    return preamble.stop ?? null;
  } catch (err) {
    throwIfCanceled(signal);
    logWarn(
      `the required-check sources of PR ${pr} could not be read ${when}: ${oneLine(readableErrorText(failureOf(err)))}`,
    );
    return null;
  }
}

/**
 * Whether the required contexts that `requiredContexts` resolved state an absence of a required
 * check. The gate and the check wait share it, so one rule decides it (issue #1013).
 *
 * - `null`: a source names a required check, so there is no absence to decide. The caller judges
 *   each named check.
 * - `{ absent: true }`: no source names a check, and both the rulesets and the classic
 *   protection stated they hold none.
 * - `{ unproven }`: no source names a check, and the listed sources did not state an absence. A
 *   source that settled nothing and a ruleset read that found no rule are both named, because a
 *   parent can only fix a source it can see (issue #336). The protection source cannot be
 *   `EMPTY`: `classifyProtection` returns `ABSENT`, `HAS_CONTEXTS`, or `UNKNOWN` and nothing
 *   else, so an unreadable protection reply is already in `unknown`.
 * @param {{ unknown: string[], rulesetState: string, protectionState: string, contexts: object[] }} required
 * @returns {{ absent: true } | { unproven: string[] } | null}
 */
export function requiredAbsence({ unknown, rulesetState, protectionState, contexts }) {
  if (contexts.length > 0) {
    return null;
  }
  if (rulesetState === ABSENT && protectionState === ABSENT) {
    return { absent: true };
  }
  const unproven = [...unknown];
  if (rulesetState === EMPTY) {
    unproven.push(RULESETS);
  }
  return { unproven };
}

/**
 * Why a failed read of the required names, or a reply that could not be parsed, leaves the
 * required contexts unresolved, or null when neither applies. `requiredResolutionRefusal` and the
 * wait on a no-required-checks answer share it.
 * @param {{ unparsed: string[], namesRead: boolean }} required
 * @param {number} pr
 * @param {string} [where] text that ends the two reasons, for example the PR head
 * @returns {string | null}
 */
export function requiredNamesRefusal({ unparsed, namesRead }, pr, where = "") {
  if (unparsed.length > 0) {
    return `${unparsed.join(" and ")} returned a reply that could not be parsed for PR ${pr}${where}`;
  }
  if (!namesRead) {
    return `the required check names for PR ${pr} could not be read${where}`;
  }
  return null;
}

/**
 * Why the required contexts that `requiredContexts` resolved cannot be judged, or null when
 * they can. The status read and the check wait share it, so one rule decides it.
 *
 * - A successful reply that is not parseable JSON may hide a required context, so it is
 *   unresolved whatever the other source names. An unreadable source (a 404 or 403) is not
 *   this case: it is a reply the gate also accepts.
 * - A failed read of the required names may have dropped a required check no other source
 *   names, so it is unresolved whatever the rest of the union holds.
 * - An empty union is no status to report.
 * @param {{ unknown: string[], unparsed: string[], namesRead: boolean, contexts: object[] }} required
 * @param {number} pr
 * @param {string} [where] text that ends the two reply-failure reasons, for example the PR head
 * @returns {string | null}
 */
export function requiredResolutionRefusal(
  { unknown, unparsed, namesRead, contexts },
  pr,
  where = "",
) {
  const namesRefusal = requiredNamesRefusal({ unparsed, namesRead }, pr, where);
  if (namesRefusal) {
    return namesRefusal;
  }
  if (contexts.length === 0) {
    const sources = unknown.length > 0 ? ` (${unknown.join(" and ")} settled nothing)` : "";
    return `no required checks were found for PR ${pr}${sources}`;
  }
  return null;
}

/**
 * The default bound on a status read. The read sits in front of a child turn
 * that has its own much longer `--timeout`, so it needs its own bound: a `gh`
 * that hangs must not hold the dispatch open (#320).
 */
export const DEFAULT_READ_TIMEOUT_MS = 60_000;

/** One line of text for a prompt line or a report field. */
function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads the required-check status for the reviewed commit, which a declared-PR
 * run supplies to each reviewer prompt (issue #320). The read is evidence for the
 * reviewer, not a gate.
 *
 * The status is bound to `head`, the local reviewed commit. The PR is read once,
 * and the check runs and commit statuses come from `commits/{sha}` by SHA, so a PR
 * head that moves away and back cannot put another commit's checks in the status
 * (issue #349). A PR head that differs from `head`, or a read with no local
 * `head`, is unresolved, because the gate would judge the other commit.
 *
 * The read judges what the gate judges: the required contexts come from
 * `requiredContexts`, the commit from `evaluatedState` (the test merge commit when
 * it carries a check, otherwise the head), every page of both replies, and each
 * context from `evaluateContext`. A pass therefore never describes a state the gate
 * refuses. The read is stricter where it can be: a reply it cannot parse or
 * interpret, a failed read of the required names, a ruleset source that settles
 * nothing, and no required context are unresolved. A failing entry wins over a
 * pending one for the same name, and a required check with no run or status reads
 * as pending.
 *
 * It never throws, except for a caller cancel: an aborted `signal` starts no read
 * and rejects with `isCanceled` set (#1181). A failed read is `unresolved`, because
 * the reviewer keeps its own read as the fallback and a turn must not fail over
 * supplied evidence.
 *
 * Every status carries `advisory: true`, for one reason: the status is a report,
 * and `--require-ci` re-reads GitHub and enforces the condition. The status is a
 * snapshot taken before the turn, so a check that starts or finishes later is not
 * in it.
 * `clean` is whether the reviewed work tree is clean. The gate refuses a tree that
 * is not clean, so a pass is withheld unless `clean` is true; the default is the
 * safe one. Every other refusal the gate makes before it reads a check is a
 * withheld pass here too: no reviewed head, a PR head other than the reviewed one,
 * and a merge state it refuses.
 * @param {{ pr: number, cwd: string, head?: string | null, clean?: boolean, gh?: Function, timeoutMs?: number, signal?: AbortSignal | null }} options
 * @returns {Promise<{ pr: number, head: string | null, status: "pass" | "failing" | "pending" | "unresolved", checks: string[], summary: string, advisory: true }>}
 */
export async function readRequiredChecks(options) {
  const status = await readStatus(options);
  // A cancel that arrived while the reads were cleaned up wins over the status.
  throwIfCanceled(options.signal);
  return status;
}

async function readStatus({
  pr,
  cwd,
  head = null,
  clean = false,
  gh = runGh,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  signal = null,
}) {
  const report = (status, checks, summary, prHead = null) => ({
    pr,
    head: prHead,
    status,
    checks,
    summary,
    advisory: true,
  });
  const unresolved = (summary, prHead = null) => report("unresolved", [], summary, prHead);

  throwIfCanceled(signal);
  // The read is bounded, and the signal terminates the child, so a hung `gh`
  // cannot stall the dispatch or outlive it. A group of reads adds its own
  // signal, so a failed read cancels its siblings without reading as a timeout
  // of the whole bound.
  const call = boundedCall(gh, timeoutMs, signal);
  let prHead = null;
  try {
    const preamble = await readCiPreamble({
      gh: call,
      cwd,
      pr,
      refuseInfo: (info) => {
        prHead =
          typeof info.headRefOid === "string" && info.headRefOid !== "" ? info.headRefOid : null;
        if (prHead === null) {
          return unresolved(`unread: the PR head for PR ${pr} could not be resolved`);
        }
        if (head === null) {
          return unresolved(
            `unread: PR ${pr} head ${prHead} cannot be compared with a local reviewed head`,
            prHead,
          );
        }
        if (prHead !== head) {
          return unresolved(
            `unread: PR ${pr} head ${prHead} differs from the local reviewed head ${head}`,
            prHead,
          );
        }
        return null;
      },
      // The same refusal the gate makes: a ruleset read that settled nothing can
      // hide a required check. `requiredResolutionRefusal` refuses an empty union.
      refuseUnknownRuleset: () =>
        unresolved(
          `unread: the repository rulesets could not be read for PR ${pr} on PR head ${head}`,
          head,
        ),
    });
    if (preamble.stop) {
      return preamble.stop;
    }
    const { info, slug } = preamble;
    const { contexts } = preamble.required;
    const sourceRefusal = requiredResolutionRefusal(preamble.required, pr, ` on PR head ${head}`);
    if (sourceRefusal) {
      return unresolved(`unread: ${sourceRefusal}`, head);
    }
    // The commit is the gate's own selection, so the read judges the state the
    // gate judges and cannot pass a state the gate refuses.
    const { commit, findings } = await evaluateRequired(call, slug, info, cwd, contexts, true);
    const label = ({ context }) =>
      context.appId === null ? context.name : `${context.name} (app ${context.appId})`;
    const ofKind = (...kinds) =>
      findings.filter(({ failure }) => failure && kinds.includes(failure.kind));
    const failing = ofKind("failing");
    const waiting = ofKind("pending", "missing");
    // A pass is withheld for a state the gate refuses: a work tree that is not clean,
    // or a merge state. A failing or pending
    // status is already not a pass, so it keeps its own word.
    const refusal =
      (clean === true ? null : "the reviewed work tree is not clean") ??
      earlyMergeRefusal(info.mergeStateStatus) ??
      (info.mergeStateStatus === "BLOCKED" ? MERGE_BLOCKED_REFUSAL : null);
    const on = `on PR head ${head}${commit === head ? "" : ` (evaluated on test merge commit ${commit})`}`;
    if (failing.length > 0) {
      return report(
        "failing",
        failing.map(label),
        `failing required checks ${on}: ${failing.map(label).join(", ")}`,
        head,
      );
    }
    if (waiting.length > 0) {
      return report(
        "pending",
        waiting.map(label),
        `a required check is pending or has not reported ${on}: ${waiting.map(label).join(", ")}`,
        head,
      );
    }
    if (refusal) {
      return unresolved(`unread: ${refusal} on PR head ${head}`, head);
    }
    return report(
      "pass",
      findings.map(label),
      `all ${findings.length} required checks passed ${on}`,
      head,
    );
  } catch (err) {
    // A failure decided before the deadline stays the outcome, whatever the
    // deadline does while the cancelled siblings settle.
    throwIfCanceled(signal);
    const detail = readExpired(call, err)
      ? `the read timed out after ${timeoutMs}ms`
      : oneLine(readableErrorText(failureOf(err)));
    return unresolved(`unread: ${detail}`, prHead);
  }
}
