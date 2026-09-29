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
 * Runs `gh` with `args` in `cwd`. Returns `{ status, stdout, stderr, timedOut }`;
 * a non-zero exit is data, not a throw. `timeoutMs` bounds the call and
 * terminates the `gh` child when it expires, so a hung `gh` cannot outlast a
 * caller bound. The kill is `SIGTERM` then `SIGKILL` after
 * `forceKillAfterDelay` on macOS, and `taskkill /T /F` over the process tree on
 * Windows, so no platform keeps a child the bound has given up on (#329).
 */
export async function runGh(args, cwd, { timeoutMs = 0, signal = null } = {}) {
  const options = { cwd, reject: false, cleanup: true, killDescendants: true };
  if (timeoutMs > 0) {
    options.timeout = timeoutMs;
    options.forceKillAfterDelay = 1000;
  }
  if (signal) {
    options.cancelSignal = signal;
  }
  const result = await execa("gh", args, options);
  return {
    status: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: Boolean(result.timedOut),
  };
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
// empty union over an unknown source either way, so the gate treats them alike.
// The second is not a permission problem: the branch simply has no classic
// protection, and a ruleset-only repository answers it for an admin. That one
// also states the absence, so it is the one of the four that establishes it
// (issue #336).
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

// The exact 404 the classic protection endpoint writes only to a caller that can
// read it, on a branch with no classic protection. It is the one unreadable reply
// that proves the source holds no required check (issue #336). It is compared
// whole, like the Free-plan 403 below, because an unanchored search also matches
// the same text inside another error: a reply that merely quotes it, or carries
// it beside a second line, says nothing about the branch and must not read as an
// absence (issue #336 review).
const NOT_PROTECTED_404 = "gh: Branch not protected (HTTP 404)";

// The exact reply a private Free-plan repository writes, compared whole so no
// surrounding text or second line can pass as it.
const FREE_PLAN_403 =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

/** Whether `stderr` is the exact `Branch not protected` 404, one trailing break aside. */
function isNotProtected404(stderr) {
  return stderr.replace(/\r?\n$/, "") === NOT_PROTECTED_404;
}

/** Whether `stderr` is the exact Free-plan 403, ignoring one trailing LF or CRLF. */
function isFreePlan403(stderr) {
  return stderr.replace(/\r?\n$/, "") === FREE_PLAN_403;
}

async function ghApi(gh, args, cwd) {
  const { status, stdout, stderr } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    throw new Error(`gh api ${args[0]} failed: ${stderr.trim() || `exit ${status}`}`);
  }
  const text = stdout.trim();
  return text === "" ? null : JSON.parse(text);
}

/**
 * One required-check configuration source, classified by what its reply proved.
 *
 * The classification is an allowlist, so it fails closed. `ABSENT` is the only
 * answer that lets a finish pass, and each source is allowed exactly one reply
 * shape to produce it:
 *
 * - Repository rulesets: a successful reply whose body is a JSON array in which
 *   every entry is a well-formed rule (an object carrying a string `type`) and no
 *   entry is a `required_status_checks` rule. That is the read of a branch with
 *   no required-status-check rule (#336).
 * - Classic branch protection: the exact `Branch not protected` (404), which the
 *   endpoint writes only to a caller that can read protection, and which names an
 *   unprotected branch (#280, #295).
 *
 * `HAS_CONTEXTS` is a reply that named at least one required check, so the
 * per-check pass runs. Every other reply is `UNKNOWN`, which settles nothing and
 * keeps the empty-union refusal:
 *
 * - any non-zero exit other than the exact `Branch not protected` 404, including
 *   `Not Found` (404), both `Resource not accessible` 403s, and the Free-plan
 *   403, which names the plan and not the branch;
 * - a body that is empty, is not JSON, is JSON that is not the array or object
 *   this endpoint returns, or is an array carrying an entry that is not a
 *   well-formed rule;
 * - a `required_status_checks` rule that names no check, which states neither an
 *   absence nor a context to enforce.
 *
 * A non-zero reply that is not an unreadable shape still throws, which fails the
 * run rather than reaching the gate (issue #280).
 * @param {object} options
 * @param {(stderr: string) => boolean} options.absentOnError the one non-zero
 *   reply that proves this source holds no required check, compared whole.
 *   `isNotProtected404` for classic protection, and a predicate that never matches
 *   for repository rulesets, whose endpoint does not write it.
 * @param {(data: unknown) => ({ state: string, contexts: object[] })} options.classify
 *   the classification of a successful reply body.
 * @returns {Promise<{ state: string, contexts: { name: string, appId: number | null }[] }>}
 */
async function readRequiredSource(gh, args, cwd, { absentOnError, classify }) {
  const { status, stdout, stderr } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    if (absentOnError(stderr)) {
      return { state: ABSENT, contexts: [] };
    }
    if (UNREADABLE.test(stderr) || isFreePlan403(stderr)) {
      return { state: UNKNOWN, contexts: [] };
    }
    throw new Error(`gh api ${args[0]} failed: ${stderr.trim() || `exit ${status}`}`);
  }
  const text = stdout.trim();
  if (text === "") {
    return { state: UNKNOWN, contexts: [] };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: UNKNOWN, contexts: [] };
  }
  const { state, contexts } = classify(body);
  return { state, contexts };
}

// The three classifications a required-check configuration source reply can
// carry. A source that settles nothing is `UNKNOWN`; only the two that state an
// outcome are definitive (issue #336).
const ABSENT = "absent";
const HAS_CONTEXTS = "contexts";
const UNKNOWN = "unknown";

// Every rule type GitHub documents for a repository ruleset, from the create and
// update ruleset schemas. A rule entry whose `type` is missing, is not a string, or
// is outside this list is unknown rather than skipped, because a type this list does
// not carry may be a required-status-check rule under a name the gate has not seen
// (issue #336 review). The list is the documented one, not an observed one: a
// future GitHub rule type makes such a read unknown, which refuses, and that is the
// safe direction.
const RULE_TYPES = new Set([
  "branch_name_pattern",
  "code_coverage",
  "code_quality",
  "code_scanning",
  "commit_author_email_pattern",
  "commit_message_pattern",
  "committer_email_pattern",
  "copilot_code_review",
  "creation",
  "deletion",
  "file_extension_restriction",
  "file_path_restriction",
  "license_compliance_scanning",
  "max_file_path_length",
  "max_file_size",
  "merge_queue",
  "non_fast_forward",
  "pull_request",
  "required_deployments",
  "required_linear_history",
  "required_signatures",
  "required_status_checks",
  "tag_name_pattern",
  "update",
  "workflows",
]);

// The names used in the refusal when a source settles nothing, so a parent can
// tell which source it must fix.
const RULESETS = "repository rulesets";
const PROTECTION = "classic branch protection";

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

/**
 * Classifies a successful repository rulesets read. `ABSENT` needs a JSON array
 * whose entries are all well-formed rules and none of them a
 * `required_status_checks` rule, because that is the only shape in which the
 * read states that no required-status-check rule applies to the branch. A
 * malformed entry makes the whole read unknown rather than skipped: an entry the
 * gate cannot read may be a required-status-check rule it never enforced
 * (issue #336).
 * @param {unknown} data the parsed body.
 * @returns {{ state: string, contexts: { name: string, appId: number | null }[] }}
 */
function classifyRulesets(data) {
  // `--slurp` wraps every page in an outer array, so a complete read is an array
  // of arrays. A body that is not that shape, or that holds a page which is not an
  // array, is a read the gate cannot account for every page of, so it settles
  // nothing rather than being classified from the pages that arrived (issue #336
  // review).
  if (!Array.isArray(data) || data.some((page) => !Array.isArray(page))) {
    return { state: UNKNOWN, contexts: [] };
  }
  const rules = data.flat();
  if (rules.length === 0) {
    // An empty result does not state that no required check exists. It is the same
    // reply for a branch no ruleset applies to and for a caller or endpoint that
    // enumerates no rule for this branch, and the reply carries nothing that tells
    // those apart, so it settles nothing (issue #336 review).
    return { state: UNKNOWN, contexts: [] };
  }
  const contexts = [];
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      return { state: UNKNOWN, contexts: [] };
    }
    if (typeof rule.type !== "string" || !RULE_TYPES.has(rule.type)) {
      // A type the gate does not know may be a required-status-check rule under a
      // name this list does not carry, so it is unknown rather than skipped
      // (issue #336 review).
      return { state: UNKNOWN, contexts: [] };
    }
    if (rule.type !== "required_status_checks") {
      continue;
    }
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      // A required-status-check rule that names no check states neither an
      // absence nor a context the gate could enforce.
      return { state: UNKNOWN, contexts: [] };
    }
    for (const check of checks) {
      if (typeof check?.context !== "string" || check.context === "") {
        return { state: UNKNOWN, contexts: [] };
      }
      contexts.push({ name: check.context, appId: check.integration_id });
    }
  }
  return { state: contexts.length > 0 ? HAS_CONTEXTS : ABSENT, contexts };
}

/**
 * Classifies a successful classic branch-protection read. No body proves an
 * absence for this source: the only reply that states the branch is unprotected
 * is the exact `Branch not protected` (404), handled on the error path, so a
 * successful body reaches `ABSENT` never. A body that is not the object
 * `repos/{slug}/branches/{base}/protection` returns, or whose
 * `required_status_checks` is present but not an object, is unknown. A body that
 * was read and carries no `required_status_checks` names no context but does not
 * say the branch is unprotected, because a classic-protected branch can require
 * reviews or a signed-off push without requiring a check, so it is unknown too
 * (issue #336).
 * @param {unknown} data the parsed body.
 * @returns {{ state: string, contexts: { name: string, appId: number | null }[] }}
 */
function classifyProtection(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { state: UNKNOWN, contexts: [] };
  }
  const required = data.required_status_checks;
  if (required === undefined) {
    return { state: UNKNOWN, contexts: [] };
  }
  if (required === null) {
    return { state: UNKNOWN, contexts: [] };
  }
  if (typeof required !== "object" || Array.isArray(required)) {
    return { state: UNKNOWN, contexts: [] };
  }
  const contexts = [];
  for (const context of required.contexts ?? []) {
    if (typeof context !== "string" || context === "") {
      return { state: UNKNOWN, contexts: [] };
    }
    contexts.push({ name: context, appId: null });
  }
  for (const check of required.checks ?? []) {
    if (typeof check?.context !== "string" || check.context === "") {
      return { state: UNKNOWN, contexts: [] };
    }
    contexts.push({ name: check.context, appId: check.app_id });
  }
  if (contexts.length === 0) {
    return { state: UNKNOWN, contexts: [] };
  }
  return { state: HAS_CONTEXTS, contexts };
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

// Required status contexts from every source: repository rulesets, classic branch
// protection, and `gh pr checks --required`.
// Deduplicated by name and app qualifier. `unknown` names every configuration
// source whose reply settled nothing, because such a source may hold a required
// check this caller never saw. An empty union is then a refusal, naming each
// source that settled nothing; an empty union over sources that each stated they
// hold no required check is an established absence the gate records (issue #336).
// `gh pr checks --required` contributes names and nothing else, so it never
// appears among the sources that settled nothing and never establishes an
// absence. It lists only the checks that already reported, so it can name a
// required check and it cannot prove one is absent: on a base branch with no
// required check it prints nothing, which is the same silence as a read failure.
async function requiredContexts(gh, slug, base, pr, cwd) {
  const contexts = new Map();
  const unknown = [];

  const rules = await readRequiredSource(
    gh,
    // The endpoint paginates at 30 rules per page by default, so a single read can
    // stop before a required-status-check rule and report an absence for a branch
    // that requires one. Every page is fetched, and a body the gate cannot account
    // for every page of is unknown (issue #336 review).
    [`repos/${slug}/rules/branches/${base}`, "--paginate", "--slurp"],
    cwd,
    { absentOnError: () => false, classify: classifyRulesets },
  );
  if (rules.state === UNKNOWN) {
    unknown.push(RULESETS);
  }
  for (const context of rules.contexts) {
    addContext(contexts, context.name, context.appId);
  }

  const protection = await readRequiredSource(
    gh,
    [`repos/${slug}/branches/${base}/protection`],
    cwd,
    { absentOnError: isNotProtected404, classify: classifyProtection },
  );
  if (protection.state === UNKNOWN) {
    unknown.push(PROTECTION);
  }
  for (const context of protection.contexts) {
    addContext(contexts, context.name, context.appId);
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
  return {
    unknown,
    contexts: values
      .filter((context) => context.appId !== null || !qualifiedNames.has(context.name))
      .sort((a, b) => {
        const left = contextKey(a.name, a.appId);
        const right = contextKey(b.name, b.appId);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  };
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
 * rule) fails closed.
 *
 * An empty union of required checks refuses when a configuration source settled
 * nothing, so a source this caller cannot read fails closed and the reason names
 * it. An empty union over sources that each stated they hold no required check is
 * an established absence, which passes and reports `noRequiredChecks: true` so a
 * caller can tell it apart from a gated pass on a branch that required a check
 * (issue #336).
 * @param {{ pr: number, reviewed: object | null, cwd: string, gh?: Function }} options
 * @returns {Promise<{ ok: true, commit: string, noRequiredChecks?: true } | { ok: false, reason: string }>}
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
  if (info.mergeStateStatus === "DIRTY") {
    return fail("the PR has merge conflicts (merge state DIRTY)");
  }
  // The merge state is validated before either path, so the relaxed absence path
  // applies exactly the same merge-state condition as the per-check path. A state
  // that is missing, null, empty, or not one GitHub documents settles nothing, and
  // a state the gate cannot read is not a clean one, so it refuses on both paths
  // rather than passing the absence path on a reply it never understood
  // (issue #336 review).
  if (!MERGE_STATES.has(info.mergeStateStatus)) {
    return fail("GitHub reports the PR merge state as unknown (computed lazily; retry shortly)");
  }
  if (info.headRefOid !== reviewed.head) {
    return fail("the PR head differs from the reviewed commit");
  }

  const slug = await repoSlug(gh, cwd);
  const { unknown, contexts: required } = await requiredContexts(
    gh,
    slug,
    info.baseRefName,
    pr,
    cwd,
  );
  // No required check exists only when no source named one and every
  // configuration source stated that it holds none. A source that settled nothing
  // is named in the refusal, because a parent can only fix the source it can see
  // (issue #336). A blocked merge state still refuses below, so an absent check
  // set cannot pass a pull request another required rule blocks.
  const noRequiredChecks = required.length === 0 && unknown.length === 0;
  if (required.length === 0 && unknown.length > 0) {
    return fail(
      `no required checks were found for the base branch, and ${unknown.join(" and ")} could not be read, so the gate cannot tell a base branch with no required check from one whose check it never saw`,
    );
  }
  if (noRequiredChecks) {
    if (info.mergeStateStatus === "BLOCKED") {
      return fail(
        "the PR merge state is blocked (a required review or another required rule is unmet)",
      );
    }
    return { ok: true, commit: info.headRefOid, noRequiredChecks: true };
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
 *
 * known-limit: every status carries `advisory: true`, because one window survives
 * the re-read. A head that advances to another commit and returns between the
 * two head reads leaves both reads naming the same commit while the checks
 * describe the other one, and no re-read separates that. The alternative,
 * reading check runs for the exact commit, needs `gh api
 * repos/{owner}/{repo}/commits/{sha}/check-runs`, which reports every check run
 * on that commit rather than the required ones, so it would have to rebuild the
 * required-name source from repository rulesets and classic protection. That is
 * the gate's own resolution and duplicating it here would drift from the gate,
 * which is the one read that enforces. The supplied status is therefore advisory
 * evidence: the reviewer treats it as a report, and `--require-ci` re-reads
 * GitHub and refuses the finish on the real condition. Ceiling: one reviewer
 * turn whose `Checks` line reports a pass for a commit other than the reviewed
 * head, in a run where the PR head moved away and back within the read. Upgrade
 * path: read the required contexts and the check runs for the exact commit, and
 * share that resolution with `checkCi` so the two cannot drift.
 * @param {{ pr: number, cwd: string, head?: string | null, gh?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ pr: number, head: string | null, status: "pass" | "failing" | "pending" | "unresolved", checks: string[], summary: string, advisory: true }>}
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
    advisory: true,
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
      advisory: true,
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
      advisory: true,
    };
  }
  if (status === 1 && failing.length > 0) {
    return {
      pr,
      head: prHead,
      status: "failing",
      checks: failing.map((check) => check.name),
      summary: `failing required checks ${on(prHead)}: ${names(failing)}`,
      advisory: true,
    };
  }
  return unresolved(`unread: ${failure} ${on(prHead)}`, prHead);
}
