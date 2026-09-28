// Evaluates the `--require-ci` finish gate: every required status check passed
// on the commit GitHub evaluates for the pull request. Check runs and commit
// statuses are both considered, because a required name can appear as either
// type (issue #218).
//
// The `gh` runner is injected so a caller can run the gate against captured
// responses. The default runner shells out to the `gh` CLI.
import { execa } from "execa";

// A check run passes with one of these conclusions; every other conclusion and
// every non-completed status fails the gate.
const PASS_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/**
 * Runs `gh` with `args` in `cwd`. Returns `{ status, stdout, stderr }`; a
 * non-zero exit is data, not a throw.
 *
 * `options.signal` bounds the call and terminates the child: the caller supplies
 * it so a `gh` that hangs cannot outlive the read (#320). The default runner
 * passes it to `execa`, which kills the child and reports a timeout.
 */
export async function runGh(args, cwd, options = {}) {
  // `cancelSignal` is the execa 10 name for the abort signal, the same one
  // `src/lib/exec.mjs` passes. The old `signal` name throws before the child
  // starts, so every real read failed and read as unresolved.
  const result = await execa("gh", args, {
    cwd,
    reject: false,
    cancelSignal: options.signal,
    timeout: options.timeoutMs,
  });
  return { status: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function fail(reason) {
  return { ok: false, reason };
}

// A source the caller cannot read answers 404 or 403, and the message names the
// credential. Observed live on the classic-protection endpoint (#280, #295):
//
//   `Not Found`                             404  a token without repository admin
//   `Branch not protected`                  404  an admin, on a branch with no
//                                                  classic protection
//   `Resource not accessible by integration` 403  a `GITHUB_TOKEN`
//   `Resource not accessible by personal
//    access token`                           403  a fine-grained PAT without the
//                                                  Administration permission
//
// All four leave the source with no required contexts, and the caller refuses an
// empty union either way, so the gate treats them alike. The second is not a
// permission problem: the branch simply has no classic protection, and a
// ruleset-only repository answers it for an admin.
//
// A private repository on the GitHub Free plan answers 403 on the classic
// protection, branch rules, and rulesets endpoints with a message that names the
// plan instead of the credential (#301, measured on two private Free-plan
// repositories with an admin classic PAT and an admin fine-grained PAT):
//
//   `Upgrade to GitHub Pro or make this repository public
//    to enable this feature.`                     403  a private repository on
//                                                     the Free plan
//
// The credential is not the problem, so the reasoning above does not carry over
// and this reply has its own argument. The plan does not allow the rule that
// would require a check, so no required context can exist on that repository and
// the source is empty by the same outcome the caller refuses on. The reply is
// the same on a branch that exists and on one that does not, so it carries
// nothing about the branch.
//
// Match the message, not the status. `gh` renders every failure as
// `gh: <message> (HTTP <status>)`, so a rate-limit or SSO 403 carries the same
// suffix as the `GITHUB_TOKEN` 403 and the status cannot tell them apart. Reading
// a rate-limit 403 as an unreadable source would silently drop every required
// context and downgrade a named check refusal to the generic blocked refusal, so
// anything unrecognized throws instead. A narrower match only costs a thrown
// error, which still fails closed.
//
// The Free-plan reply is compared as a whole string rather than added to
// `UNREADABLE`. That pattern is an unanchored search, so an alternative added to
// it matches any stderr that contains the message anywhere, including a reply
// with extra text around it or another error line beside it. Comparing the whole
// stderr, after dropping one trailing LF or CRLF, keeps the Free-plan reply exact
// and leaves every input `UNREADABLE` treats a certain way untouched.
//
// `Not Found` and the 403s are safe to read as unreadable on these two calls: the
// slug comes from `gh repo view` and the base branch from the pull request, both of
// which the caller has already read successfully, so a wrong value here cannot come
// from a typo. The `Branch not found` reply, which an admin gets for a branch that
// does not exist, is not matched and throws, so a typo still surfaces when the
// caller can read protection. It cannot be relied on to surface otherwise: a
// non-admin token can read the branch but not its protection settings, so a typo
// answers the same `Not Found` as a protected branch, and a fine-grained PAT
// without the Administration permission answers the same 403 whatever the branch
// is. The already-read values are what make a typo impossible here, not the
// message.
const UNREADABLE =
  /(?:Not Found|Branch not protected) \(HTTP 404\)|Resource not accessible by (?:integration|personal access token) \(HTTP 403\)/;

// The exact reply a private Free-plan repository writes, compared whole so no
// surrounding text or second line can pass as it.
const FREE_PLAN_403 =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

/** Whether `stderr` is the exact Free-plan 403, ignoring one trailing LF or CRLF. */
function isFreePlan403(stderr) {
  return stderr.replace(/\r?\n$/, "") === FREE_PLAN_403;
}

async function ghApi(gh, args, cwd, { allowUnreadable = false } = {}) {
  const { status, stdout, stderr } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    if (allowUnreadable && (UNREADABLE.test(stderr) || isFreePlan403(stderr))) {
      return null;
    }
    throw new Error(`gh api ${args[0]} failed: ${stderr.trim() || `exit ${status}`}`);
  }
  const text = stdout.trim();
  return text === "" ? null : JSON.parse(text);
}

async function prInfo(gh, pr, cwd) {
  const { status, stdout, stderr } = await gh(
    [
      "pr",
      "view",
      String(pr),
      "--json",
      "headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit",
    ],
    cwd,
  );
  if (status !== 0) {
    throw new Error(`gh pr view ${pr} failed: ${stderr.trim() || `exit ${status}`}`);
  }
  return JSON.parse(stdout);
}

async function repoSlug(gh, cwd) {
  const { status, stdout, stderr } = await gh(
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  if (status !== 0 || stdout.trim() === "") {
    throw new Error(`gh repo view failed: ${stderr.trim() || `exit ${status}`}`);
  }
  return stdout.trim();
}

// `gh pr checks --required` resolves required check names without admin rights.
// It lists only checks that already reported on the commit, exits non-zero for
// pending or failing checks, and prints no JSON when no required check has
// reported, so the output is parsed leniently and an unparseable result
// contributes no names. This source carries no app qualifier, so every name it
// yields is unqualified.
async function ghRequiredNames(gh, pr, cwd) {
  const { stdout } = await gh(["pr", "checks", String(pr), "--required", "--json", "name"], cwd);
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.map((check) => check?.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// A required status context: its name, plus the id of the app whose check run
// must satisfy it when the source qualifies the context with one. A null `appId`
// is unqualified and is satisfied by a check run or a commit status with the
// name. Ruleset entries carry `integration_id`, classic-protection entries carry
// `app_id`, and `gh pr checks --required` carries no app qualifier.
function contextKey(name, appId) {
  return `${name}\0${appId ?? ""}`;
}

function addContext(contexts, name, appId = null) {
  if (name) {
    // A source can report `-1` as the "any app" qualifier; treat it as absent.
    const qualifier = appId == null || appId === -1 ? null : appId;
    contexts.set(contextKey(name, qualifier), { name, appId: qualifier });
  }
}

// Required status contexts from every source the caller can read: repository
// rulesets, classic branch protection, and `gh pr checks --required`.
// Deduplicated by name and app qualifier. An unreadable source contributes no
// contexts; the caller refuses an empty union, so a source that yields no
// contexts fails closed instead of passing vacuously.
async function requiredContexts(gh, slug, base, pr, cwd) {
  const contexts = new Map();

  const rules = await ghApi(gh, [`repos/${slug}/rules/branches/${base}`], cwd, {
    allowUnreadable: true,
  });
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (rule?.type !== "required_status_checks") {
        continue;
      }
      for (const check of rule.parameters?.required_status_checks ?? []) {
        addContext(contexts, check?.context, check?.integration_id);
      }
    }
  }

  const protection = await ghApi(gh, [`repos/${slug}/branches/${base}/protection`], cwd, {
    allowUnreadable: true,
  });
  const required = protection?.required_status_checks;
  for (const context of required?.contexts ?? []) {
    addContext(contexts, context);
  }
  for (const check of required?.checks ?? []) {
    addContext(contexts, check?.context, check?.app_id);
  }

  for (const name of await ghRequiredNames(gh, pr, cwd)) {
    addContext(contexts, name);
  }

  // An unqualified copy of an app-qualified name cannot express which app must
  // pass, so it would judge the name by the newest run from any app and could
  // refuse a passing qualified check. Drop it in favor of the qualified
  // context, which the per-context check enforces.
  const values = [...contexts.values()];
  const qualifiedNames = new Set(
    values.filter((context) => context.appId !== null).map((context) => context.name),
  );
  return values
    .filter((context) => context.appId !== null || !qualifiedNames.has(context.name))
    .sort((a, b) => {
      const left = contextKey(a.name, a.appId);
      const right = contextKey(b.name, b.appId);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

async function checkRuns(gh, slug, sha, cwd) {
  const pages = await ghApi(
    gh,
    [`repos/${slug}/commits/${sha}/check-runs`, "--paginate", "--slurp"],
    cwd,
  );
  if (!Array.isArray(pages)) {
    return [];
  }
  return pages.flatMap((page) => page?.check_runs ?? []);
}

async function commitStatuses(gh, slug, sha, cwd) {
  const data = await ghApi(gh, [`repos/${slug}/commits/${sha}/status`], cwd);
  return data?.statuses ?? [];
}

// The commit GitHub evaluates: the test merge commit when it carries a check
// run or a commit status, the head commit otherwise. The same selection yields
// the result GitHub shows for the pull request.
async function evaluatedState(gh, slug, info, cwd) {
  const head = info.headRefOid;
  const merge = info.potentialMergeCommit?.oid ?? null;
  if (merge && merge !== head) {
    const runs = await checkRuns(gh, slug, merge, cwd);
    const statuses = await commitStatuses(gh, slug, merge, cwd);
    if (runs.length > 0 || statuses.length > 0) {
      return { commit: merge, runs, statuses };
    }
  }
  const runs = await checkRuns(gh, slug, head, cwd);
  const statuses = await commitStatuses(gh, slug, head, cwd);
  return { commit: head, runs, statuses };
}

// The most recent matching check run, by start time. GitHub evaluates the
// latest run for a name; an earlier failing run that a later run replaces does
// not fail the gate.
function latestRun(runs) {
  let latest = null;
  for (const run of runs) {
    const key = `${run.started_at ?? run.completed_at ?? ""}\0${run.id ?? 0}`;
    if (!latest || key >= latest.key) {
      latest = { key, run };
    }
  }
  return latest?.run ?? null;
}

function latestStatus(statuses) {
  let latest = null;
  for (const status of statuses) {
    const key = `${status.updated_at ?? status.created_at ?? ""}\0${status.id ?? 0}`;
    if (!latest || key >= latest.key) {
      latest = { key, status };
    }
  }
  return latest?.status ?? null;
}

// Null when the required context passes, or a reason that names the failing
// condition. An app-qualified context is satisfied only by a check run from that
// app; an unqualified context is satisfied by a check run or a commit status
// with the name, and both types must pass when both carry an unqualified name.
function evaluateContext({ name, appId }, commit, runs, statuses) {
  const label = appId === null ? `"${name}"` : `"${name}" (app ${appId})`;
  const matchingRuns = runs.filter(
    (run) => run.name === name && (appId === null || run.app?.id === appId),
  );
  // A commit status carries no app, so it can never satisfy an app-qualified
  // context.
  const matchingStatuses =
    appId === null ? statuses.filter((status) => status.context === name) : [];

  if (matchingRuns.length === 0 && matchingStatuses.length === 0) {
    return `required check ${label} is missing on ${commit}`;
  }

  if (matchingRuns.length > 0) {
    const run = latestRun(matchingRuns);
    if (run.status !== "completed") {
      return `required check ${label} is pending (check run status ${run.status})`;
    }
    if (!PASS_CHECK_CONCLUSIONS.has(run.conclusion)) {
      return `required check ${label} failed (check run conclusion ${run.conclusion})`;
    }
  }

  if (matchingStatuses.length > 0) {
    const status = latestStatus(matchingStatuses);
    if (status.state !== "success") {
      return `required check ${label} failed (commit status ${status.state})`;
    }
  }

  return null;
}

/**
 * Refuses unless the PR head equals the reviewed commit, the reviewed tree is
 * clean, the PR is not behind its base under a strict rule, has no merge
 * conflicts, is not in an unknown merge state, and every required check passed
 * on the commit GitHub evaluates. A blocked merge state refuses after the
 * per-check pass, so a named check refusal keeps its name; any remaining block
 * (a required check that never reported, a required review, or another required
 * rule) fails closed. Refuses when no required checks are found, so an empty
 * source fails closed.
 * @param {{ pr: number, reviewed: object | null, cwd: string, gh?: Function }} options
 * @returns {Promise<{ ok: true, commit: string } | { ok: false, reason: string }>}
 */
export async function checkCi({ pr, reviewed, cwd, gh = runGh }) {
  if (!reviewed) {
    return fail("the latest reviewer turn has no reviewed state");
  }
  if (!reviewed.clean) {
    return fail("the reviewed work tree is not clean");
  }

  const info = await prInfo(gh, pr, cwd);
  if (info.mergeStateStatus === "BEHIND") {
    return fail("the PR is behind its base branch");
  }
  if (info.mergeStateStatus === "UNKNOWN") {
    return fail("GitHub reports the PR merge state as unknown (computed lazily; retry shortly)");
  }
  if (info.mergeStateStatus === "DIRTY") {
    return fail("the PR has merge conflicts (merge state DIRTY)");
  }
  if (info.headRefOid !== reviewed.head) {
    return fail("the PR head differs from the reviewed commit");
  }

  const slug = await repoSlug(gh, cwd);
  const required = await requiredContexts(gh, slug, info.baseRefName, pr, cwd);
  if (required.length === 0) {
    return fail("no required checks were found for the base branch");
  }
  const { commit, runs, statuses } = await evaluatedState(gh, slug, info, cwd);
  for (const context of required) {
    const reason = evaluateContext(context, commit, runs, statuses);
    if (reason) {
      return fail(reason);
    }
  }
  // Run this after the per-check pass so a named check refusal keeps its name.
  // `gh pr checks --required` lists only checks that already reported, so on a
  // classic-protection-only repo a caller without admin rights cannot enumerate
  // a required check that never started; GitHub reports that PR as blocked to such
  // a caller, confirmed live with a non-admin `GITHUB_TOKEN` (#280). When no other
  // required check reported, the empty-union refusal above fires first. The REST
  // `mergeable_state` reads `blocked` for an admin and `unstable` for an anonymous
  // caller on that same pull request, so its value depends on the viewer and is not
  // a stable signal. The GraphQL `mergeStateStatus` reads `BLOCKED` for the admin
  // and for a non-admin `GITHUB_TOKEN`, which is what was observed; GraphQL needs
  // authentication, so no anonymous reading of it exists (#280). Other unmet rules
  // (a required review, unresolved conversations, a required deployment) also report
  // blocked, and the gate cannot tell them apart, so it fails closed (#271).
  if (info.mergeStateStatus === "BLOCKED") {
    return fail(
      "the PR merge state is blocked (a required check, review, or other required rule is unmet)",
    );
  }

  return { ok: true, commit };
}

// The buckets `gh pr checks --required --json name,bucket` reports. `pass` and
// `skipping` read as a pass, the same conclusions the gate accepts; `fail` and
// `cancel` are failures; `pending` is neither. A bucket outside this set is not
// a status this read knows, so it is unresolved rather than a guess.
const PASS_BUCKETS = new Set(["pass", "skipping"]);
const FAILING_BUCKETS = new Set(["fail", "cancel"]);
const KNOWN_BUCKETS = new Set([...PASS_BUCKETS, ...FAILING_BUCKETS, "pending"]);

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
 * The listed checks, or null when the reply is not a wholly well-formed list.
 * Every entry must be an object with a non-empty string `name` and a known
 * string `bucket`. A lenient parse that drops the malformed entries would read
 * as a pass whenever a pass entry sits beside a malformed one, so any malformed
 * entry rejects the whole reply (#320 review).
 */
function parseListedChecks(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  for (const check of parsed) {
    if (typeof check !== "object" || check === null || Array.isArray(check)) {
      return null;
    }
    if (typeof check.name !== "string" || oneLine(check.name) === "") {
      return null;
    }
    if (typeof check.bucket !== "string" || !KNOWN_BUCKETS.has(check.bucket)) {
      return null;
    }
  }
  return parsed;
}

const names = (checks) => checks.map((check) => check.name).join(", ");

/**
 * Resolves the PR head, the commit GitHub evaluates the required checks for. A
 * separate read from the check list, because `gh pr checks --json` reports no
 * commit: the status is meaningless without the head it describes, and the
 * reviewer must be able to compare it with the local head.
 * @param {{ pr: number, cwd: string, gh: Function, signal: AbortSignal }} context
 * @returns {Promise<string | null>} the head, or null when it cannot be read
 */
async function readPrHead({ pr, cwd, gh, signal }) {
  try {
    const { status, stdout } = await gh(["pr", "view", String(pr), "--json", "headRefOid"], cwd, {
      signal,
    });
    if (status !== 0) {
      return null;
    }
    const head = JSON.parse(stdout)?.headRefOid;
    return typeof head === "string" && head !== "" ? head : null;
  } catch (err) {
    // An aborted read stopped on the time bound, which is a different condition
    // from a head that cannot be read, and the summary must name it.
    if (signal.aborted) {
      throw err;
    }
    return null;
  }
}

/**
 * Reads the required-check status for the PR head, which a declared-PR run
 * supplies to each reviewer prompt (issue #320). The read is evidence for the
 * reviewer, not a gate: `gh pr checks` lists only the checks that already
 * reported, so a pass here covers the listed checks only.
 *
 * It never throws. A failed read is `unresolved`, because the reviewer keeps its
 * own read as the fallback and a turn must not fail over supplied evidence.
 *
 * The status comes from the exit code, which is the contract the reviewer rules
 * and `docs/orchestrator-instructions.md` already state: 0 is a pass, 8 is a
 * pending check, and 1 covers a failing check, a pull request with no required
 * check, and a read error. Exit 1 reports failing only when the reply lists a
 * failing required check, which is the same evidence the reviewer rule requires
 * before it calls a blocker. Every other exit code, and any reply that is not a
 * wholly well-formed list, is unresolved.
 *
 * A status is reported only for the head it describes. `head` is the local
 * reviewed head, and a read whose PR head differs from it, or a read with no
 * local head to compare, is unresolved, because a status on one head says
 * nothing about the other. The head is read again after the checks, because the
 * two reads are separate calls and the PR can advance between them: `gh pr
 * checks` reports no commit, so a head that moved is the only signal that the
 * checks belong to a different commit, and it is unresolved.
 * @param {{ pr: number, cwd: string, head?: string | null, gh?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ pr: number, head: string | null, status: "pass" | "failing" | "pending" | "unresolved", checks: string[], summary: string }>}
 */
export async function readRequiredChecks({
  pr,
  cwd,
  head = null,
  gh = runGh,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
}) {
  const unresolved = (summary, prHead = null) => ({
    pr,
    head: prHead,
    status: "unresolved",
    checks: [],
    summary,
  });

  // The read is bounded, and the signal terminates the child, so a hung `gh`
  // cannot stall the dispatch or outlive it. An external abort is reported as a
  // timeout here, because from the read's side the call simply stopped.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const call = (args) => gh(args, cwd, { signal: controller.signal, timeoutMs });
  let reply;
  let prHead;
  try {
    prHead = await readPrHead({ pr, cwd, gh, signal: controller.signal });
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
    reply = await call(["pr", "checks", String(pr), "--required", "--json", "name,bucket"]);
    // The check read is a second call, so the PR can advance between the two.
    // `gh pr checks` reports no commit, so the only way to bind the checks to a
    // commit is to read the head again and refuse a head that moved. Without
    // this the checks describe the new head while the summary names the old one,
    // and a pass would describe a commit the reviewer is not looking at.
    const after = await readPrHead({ pr, cwd, gh, signal: controller.signal });
    if (after === null) {
      return unresolved(
        `unread: the PR head for PR ${pr} could not be re-read after the checks`,
        prHead,
      );
    }
    if (after !== prHead) {
      return unresolved(
        `unread: PR ${pr} head moved from ${prHead} to ${after} while the checks were read`,
        after,
      );
    }
  } catch (err) {
    const detail = controller.signal.aborted
      ? `the read timed out after ${timeoutMs}ms`
      : oneLine(err?.message ?? err);
    return unresolved(`unread: ${detail}`, prHead ?? null);
  } finally {
    clearTimeout(timer);
  }

  const { status, stdout, stderr } = reply;
  const failure = oneLine(stderr) || `exit ${status}`;
  const on = (head) => `on PR head ${head}`;
  const listed = parseListedChecks(stdout);
  if (listed === null) {
    return unresolved(`unread: ${failure} ${on(prHead)}`, prHead);
  }
  const failing = listed.filter((check) => FAILING_BUCKETS.has(check.bucket));
  const pending = listed.filter((check) => check.bucket === "pending");
  const pass = listed.filter((check) => PASS_BUCKETS.has(check.bucket));

  if (status === 0 && failing.length === 0 && pending.length === 0) {
    return {
      pr,
      head: prHead,
      status: "pass",
      checks: pass.map((check) => check.name),
      summary: `all ${pass.length} listed required checks passed ${on(prHead)}`,
    };
  }
  // Exit 8 is a pending check whatever the buckets say. The list names the
  // pending checks when it has them; the exit code is what makes the status
  // pending, so a list whose buckets disagree does not change the status.
  if (status === 8 && failing.length === 0) {
    return {
      pr,
      head: prHead,
      status: "pending",
      checks: pending.map((check) => check.name),
      summary: `a required check is pending ${on(prHead)}${
        pending.length > 0 ? `: ${names(pending)}` : ""
      }`,
    };
  }
  if (status === 1 && failing.length > 0) {
    return {
      pr,
      head: prHead,
      status: "failing",
      checks: failing.map((check) => check.name),
      summary: `failing required checks ${on(prHead)}: ${names(failing)}`,
    };
  }
  return unresolved(`unread: ${failure} ${on(prHead)}`, prHead);
}
