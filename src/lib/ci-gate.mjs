// Evaluates the `--require-ci` finish gate: every required status check passed
// on the commit GitHub evaluates for the pull request. Check runs and commit
// statuses are both considered, because a required name can appear as either
// type (issue #218).
//
// The `gh` runner is injected so a caller can run the gate against captured
// responses. The default runner shells out to the `gh` CLI.
import { execa } from "execa";
import { readableErrorMessage } from "./error-message.mjs";
import { isJsonObject } from "./json.mjs";

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
 * @param {(data: unknown) => boolean} [options.malformed] whether a parsed body has a
 *   shape the classification cannot interpret; read by the status read only.
 * @param {(data: unknown) => ({ state: string, contexts: object[] })} options.classify
 *   the classification of a successful reply body.
 * @returns {Promise<{ state: string, contexts: { name: string, appId: number | null }[], unparsed?: boolean }>}
 */
async function readRequiredSource(
  gh,
  args,
  cwd,
  { absentOnError, classify, malformed = () => false },
) {
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
    return { state: UNKNOWN, contexts: [], unparsed: true };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: UNKNOWN, contexts: [], unparsed: true };
  }
  const { state, contexts } = classify(body);
  // `unparsed` marks a successful reply that is not the JSON object or array the
  // endpoint returns, or whose shape `malformed` cannot interpret. The gate
  // ignores it. The status read refuses on it, because that reply may hide a
  // required context (issue #349).
  return {
    state,
    contexts,
    unparsed: typeof body !== "object" || body === null || malformed(body),
  };
}

// The classifications a required-check configuration source reply can carry.
// `ABSENT` is a reply that states the source holds no required check, `HAS_CONTEXTS`
// a reply that names at least one, and `UNKNOWN` a reply that settles nothing.
// `EMPTY` is the one outcome the ruleset source alone carries: a successful read
// that found no rule. It is not a positive absence, and it does not refuse the
// per-check path, so a classic-only repository keeps the behavior origin/main gave
// it (issue #336 review).
const ABSENT = "absent";
const HAS_CONTEXTS = "contexts";
const UNKNOWN = "unknown";
const EMPTY = "empty";

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
  if (data.length === 0) {
    // A read that returned no page at all is not a read that found no rule. An
    // empty body from the paginated call is the same reply whether the branch has
    // no rule or the read returned nothing, and only the single empty page says
    // the first (issue #336 review).
    return { state: UNKNOWN, contexts: [] };
  }
  if (data.every((page) => page.length === 0)) {
    // Exactly one empty page is the reply that says the branch has no rule, so it
    // is `EMPTY`. More than one empty page is an anomalous sequence: GitHub stops
    // paginating when there is no next page, so a second empty page means the read
    // is not the complete result it claims to be (issue #336 review).
    return { state: data.length === 1 ? EMPTY : UNKNOWN, contexts: [] };
  }
  if (data.some((page) => page.length === 0)) {
    // An empty page beside a page that holds rules settles nothing, for the same
    // reason: a partial read must not be classified from the pages that did arrive
    // (issue #336 review).
    return { state: UNKNOWN, contexts: [] };
  }
  const rules = data.flat();
  const contexts = [];
  for (const rule of rules) {
    if (!isJsonObject(rule)) {
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
  if (!isJsonObject(data)) {
    return { state: UNKNOWN, contexts: [] };
  }
  const required = data.required_status_checks;
  if (required === undefined) {
    return { state: UNKNOWN, contexts: [] };
  }
  if (required === null) {
    return { state: UNKNOWN, contexts: [] };
  }
  if (!isJsonObject(required)) {
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

// Whether a classic protection body has a shape the status read cannot interpret.
// A body with no `required_status_checks` is interpretable: the branch is
// protected without a required check. Any other shape that is not an object, a
// list of names, or a list of `{ context }` entries is not (issue #349).
function isProtectionMalformed(data) {
  if (!isJsonObject(data)) {
    return true;
  }
  const required = data.required_status_checks;
  if (required === undefined || required === null) {
    return false;
  }
  if (!isJsonObject(required)) {
    return true;
  }
  const { contexts = [], checks = [] } = required;
  return (
    !Array.isArray(contexts) ||
    !Array.isArray(checks) ||
    contexts.some((context) => typeof context !== "string" || context === "") ||
    checks.some((check) => typeof check?.context !== "string" || check.context === "")
  );
}

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
//
// `ok` is true only for a read that succeeded, whatever its stdout holds: exit 0
// with a list of named checks, exit 1 or 8 (a failing or pending check) with a
// non-empty list of named checks, or the exact `no required checks reported`
// answer on exit 1 with no stdout. Any other exit, an empty list on a non-zero
// exit, and an error text that merely contains those words are a failed read. The
// gate ignores `ok`. The status read refuses on it, because the list may name a
// required check no configuration source did (issue #349).
const NO_REQUIRED_CHECKS = /^no required checks reported on the '.+' branch$/;

async function ghRequiredNames(gh, pr, cwd) {
  const { status, stdout, stderr } = await gh(
    ["pr", "checks", String(pr), "--required", "--json", "name"],
    cwd,
  );
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON: judged below.
  }
  if (Array.isArray(parsed)) {
    const named = parsed.every((check) => typeof check?.name === "string" && check.name !== "");
    const succeeded = status === 0 || ((status === 1 || status === 8) && parsed.length > 0);
    return {
      names: parsed.map((check) => check?.name).filter(Boolean),
      ok: named && succeeded,
    };
  }
  const none = stdout.trim() === "" && status === 1 && NO_REQUIRED_CHECKS.test(stderr.trim());
  return { names: [], ok: none };
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
  const unparsed = [];

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
  if (rules.unparsed) {
    unparsed.push(RULESETS);
  }
  for (const context of rules.contexts) {
    addContext(contexts, context.name, context.appId);
  }
  const protection = await readRequiredSource(
    gh,
    [`repos/${slug}/branches/${base}/protection`],
    cwd,
    {
      absentOnError: isNotProtected404,
      classify: classifyProtection,
      malformed: isProtectionMalformed,
    },
  );
  if (protection.state === UNKNOWN) {
    unknown.push(PROTECTION);
  }
  if (protection.unparsed) {
    unparsed.push(PROTECTION);
  }
  for (const context of protection.contexts) {
    addContext(contexts, context.name, context.appId);
  }

  const listed = await ghRequiredNames(gh, pr, cwd);
  for (const name of listed.names) {
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
    unparsed,
    namesRead: listed.ok,
    // The ruleset state is carried separately from `unknown`, because an empty read
    // is neither an absence nor a refusal: it contributes no contexts and leaves the
    // per-check path to the other sources, exactly as origin/main did (issue #336
    // review).
    rulesetState: rules.state,
    protectionState: protection.state,
    contexts: values
      .filter((context) => context.appId !== null || !qualifiedNames.has(context.name))
      .sort((a, b) => {
        const left = contextKey(a.name, a.appId);
        const right = contextKey(b.name, b.appId);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  };
}

const CHECK_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const COMMIT_STATUS_STATES = new Set(["error", "failure", "pending", "success"]);

// The status read parses the check-run and commit-status replies strictly. The
// gate accepts a missing or malformed field as an empty list. A reply that is not
// the paginated shape, or that holds an entry the judgment cannot read, throws in
// strict mode, and the read reports it as unresolved instead of judging the
// entries that did parse. The latest entry for a name decides, so an id or a
// timestamp that cannot be ordered is malformed too: it could rank an old pass
// above a newer failure (issue #349).
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

const isOrderable = (entry, fields) =>
  Number.isFinite(entry.id) &&
  fields.some(
    (field) => typeof entry[field] === "string" && !Number.isNaN(Date.parse(entry[field])),
  ) &&
  fields.every((field) => entry[field] == null || !Number.isNaN(Date.parse(entry[field])));

/** The check runs of `sha`, every page. `strict` makes a malformed reply throw. */
async function checkRuns(gh, slug, sha, cwd, strict = false) {
  const pages = await ghApi(
    gh,
    [`repos/${slug}/commits/${sha}/check-runs`, "--paginate", "--slurp"],
    cwd,
  );
  if (!strict) {
    return Array.isArray(pages) ? pages.flatMap((page) => page?.check_runs ?? []) : [];
  }
  const runs = pagesOf(pages, "check_runs", "check-runs");
  for (const run of runs) {
    if (
      !isJsonObject(run) ||
      typeof run.name !== "string" ||
      run.name === "" ||
      !CHECK_RUN_STATUSES.has(run.status) ||
      (run.status === "completed" && typeof run.conclusion !== "string") ||
      // A queued run has not started, so it may carry no start time.
      !(run.status === "completed" || run.status === "in_progress"
        ? isOrderable(run, ["started_at", "completed_at"])
        : Number.isFinite(run.id))
    ) {
      throw new Error("malformed check-runs reply");
    }
  }
  return runs;
}

/** The commit statuses of `sha`, every page. `strict` makes a malformed reply throw. */
async function commitStatuses(gh, slug, sha, cwd, strict = false) {
  const pages = await ghApi(
    gh,
    [`repos/${slug}/commits/${sha}/status`, "--paginate", "--slurp"],
    cwd,
  );
  if (!strict) {
    if (Array.isArray(pages)) {
      return pages.flatMap((page) => page?.statuses ?? []);
    }
    return pages?.statuses ?? [];
  }
  const statuses = pagesOf(pages, "statuses", "commit status");
  for (const status of statuses) {
    if (
      !isJsonObject(status) ||
      typeof status.context !== "string" ||
      status.context === "" ||
      !COMMIT_STATUS_STATES.has(status.state) ||
      !isOrderable(status, ["updated_at", "created_at"])
    ) {
      throw new Error("malformed commit status reply");
    }
  }
  return statuses;
}

// The commit GitHub evaluates: the test merge commit when it carries a check
// run or a commit status, the head commit otherwise. The same selection yields
// the result GitHub shows for the pull request.
async function evaluatedState(gh, slug, info, cwd, strict = false) {
  const head = info.headRefOid;
  const merge = info.potentialMergeCommit?.oid ?? null;
  if (merge && merge !== head) {
    const runs = await checkRuns(gh, slug, merge, cwd, strict);
    const statuses = await commitStatuses(gh, slug, merge, cwd, strict);
    if (runs.length > 0 || statuses.length > 0) {
      return { commit: merge, runs, statuses };
    }
  }
  const runs = await checkRuns(gh, slug, head, cwd, strict);
  const statuses = await commitStatuses(gh, slug, head, cwd, strict);
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

// Null when the required context passes, or `{ kind, reason }` where `kind` is
// `missing`, `pending`, or `failing` and `reason` names the condition. An app-qualified context is satisfied only by a check run from that
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
    return { kind: "missing", reason: `required check ${label} is missing on ${commit}` };
  }

  // The reason is the first unmet condition, which is what the gate reports. The
  // kind is the worst condition among all entries that share the name: a pending
  // latest entry does not hide a failing entry beside it, whether that entry is
  // another run, an earlier run, or a commit status (issue #349).
  let problem = null;
  if (matchingRuns.length > 0) {
    const run = latestRun(matchingRuns);
    if (run.status !== "completed") {
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
    const status = latestStatus(matchingStatuses);
    if (status.state !== "success" && problem === null) {
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
  const anyFailure =
    matchingRuns.some(
      (run) => run.status === "completed" && !PASS_CHECK_CONCLUSIONS.has(run.conclusion),
    ) || matchingStatuses.some((status) => status.state === "error" || status.state === "failure");
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
 * union holds, because that reply may carry a required-status rule this caller
 * never saw, so a non-empty union from another source must not let the per-check
 * pass judge only the names it saw. origin/main treated a failed ruleset read as an
 * empty source and refused only on an unrecognized message, so this is stricter than
 * that (issue #336 review).
 *
 * An empty union of required checks refuses when the classic-protection source
 * settled nothing, so a source this caller cannot read fails closed and the reason
 * names it. An empty union over sources that each stated they hold no required check
 * is an established absence, which passes and reports `noRequiredChecks: true` so a
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
  const early = earlyMergeRefusal(info.mergeStateStatus);
  if (early) {
    return fail(early);
  }
  if (info.headRefOid !== reviewed.head) {
    return fail("the PR head differs from the reviewed commit");
  }

  const slug = await repoSlug(gh, cwd);
  const {
    unknown,
    rulesetState,
    protectionState,
    contexts: required,
  } = await requiredContexts(gh, slug, info.baseRefName, pr, cwd);
  // An unknown ruleset read refuses the finish whatever the rest of the union
  // holds. Its own reply may carry a required-status rule this caller never saw,
  // and a non-empty union from another source would otherwise let the per-check
  // pass judge only the names it saw, so a ruleset-required check could be skipped
  // (issue #336 review).
  //
  // A successful read that found no rule is not in this branch. It contributes no
  // contexts and the per-check pass runs on the other sources, which is what
  // origin/main did for every unreadable ruleset reply, so a classic-only
  // repository whose required checks passed still finishes. It is still not a
  // positive absence, so the empty-union refusal below names it.
  if (rulesetState === UNKNOWN) {
    return fail(
      "the repository rulesets could not be read, so the gate cannot tell which required checks the base branch requires",
    );
  }
  // No required check exists only when both sources stated they hold none. A source
  // that settled nothing, and a ruleset read that found no rule, are both named in
  // the refusal, because a parent can only fix a source it can see (issue #336). A
  // blocked merge state still refuses below, so an absent check set cannot pass a
  // pull request another required rule blocks.
  const noRequiredChecks =
    required.length === 0 && rulesetState === ABSENT && protectionState === ABSENT;
  if (required.length === 0 && !noRequiredChecks) {
    const unproven = [...unknown];
    if (rulesetState === EMPTY) {
      unproven.push(RULESETS);
    }
    // The protection source cannot be `EMPTY`: `classifyProtection` returns
    // `ABSENT`, `HAS_CONTEXTS`, or `UNKNOWN` and nothing else, so an unreadable
    // protection reply is already in `unknown` and needs no second push (#336).
    return fail(
      `no required checks were found for the base branch, and ${unproven.join(" and ")} did not state that it holds no required check, so the gate cannot tell a base branch with no required check from one whose check it never saw`,
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
    const failure = evaluateContext(context, commit, runs, statuses);
    if (failure) {
      return fail(failure.reason);
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
 * It never throws. A failed read is `unresolved`, because the reviewer keeps its
 * own read as the fallback and a turn must not fail over supplied evidence.
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
 * @param {{ pr: number, cwd: string, head?: string | null, clean?: boolean, gh?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ pr: number, head: string | null, status: "pass" | "failing" | "pending" | "unresolved", checks: string[], summary: string, advisory: true }>}
 */
export async function readRequiredChecks({
  pr,
  cwd,
  head = null,
  clean = false,
  gh = runGh,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
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

  // The read is bounded, and the signal terminates the child, so a hung `gh`
  // cannot stall the dispatch or outlive it. An external abort is reported as a
  // timeout here, because from the read's side the call simply stopped.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const call = (args, callCwd) => gh(args, callCwd, { signal: controller.signal, timeoutMs });
  let prHead = null;
  try {
    const info = await prInfo(call, pr, cwd);
    prHead = typeof info.headRefOid === "string" && info.headRefOid !== "" ? info.headRefOid : null;
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
    const slug = await repoSlug(call, cwd);
    const { unknown, unparsed, namesRead, rulesetState, contexts } = await requiredContexts(
      call,
      slug,
      info.baseRefName,
      pr,
      cwd,
    );
    // The same refusals the gate makes: a ruleset read that settled nothing may
    // hide a required check, and an empty union is no status to report.
    if (rulesetState === UNKNOWN) {
      return unresolved(
        `unread: the repository rulesets could not be read for PR ${pr} on PR head ${head}`,
        head,
      );
    }
    // A successful reply that is not parseable JSON may hide a required context,
    // so it is unresolved whatever the other source names. An unreadable source
    // (a 404 or 403) is not this case: it is a reply the gate also accepts.
    if (unparsed.length > 0) {
      return unresolved(
        `unread: ${unparsed.join(" and ")} returned a reply that could not be parsed for PR ${pr} on PR head ${head}`,
        head,
      );
    }
    // A failed read of the required names may have dropped a required check no
    // other source names, so it is unresolved whatever the rest of the union holds.
    if (!namesRead) {
      return unresolved(
        `unread: the required check names for PR ${pr} could not be read on PR head ${head}`,
        head,
      );
    }
    if (contexts.length === 0) {
      const sources = unknown.length > 0 ? ` (${unknown.join(" and ")} settled nothing)` : "";
      return unresolved(`unread: no required checks were found for PR ${pr}${sources}`, head);
    }
    // The commit is the gate's own selection, so the read judges the state the
    // gate judges and cannot pass a state the gate refuses.
    const { commit, runs, statuses } = await evaluatedState(call, slug, info, cwd, true);
    const findings = contexts.map((context) => ({
      context,
      failure: evaluateContext(context, commit, runs, statuses),
    }));
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
      (info.mergeStateStatus === "BLOCKED"
        ? "the PR merge state is blocked (a required check, review, or other required rule is unmet)"
        : null);
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
    const detail = controller.signal.aborted
      ? `the read timed out after ${timeoutMs}ms`
      : oneLine(readableErrorMessage(err));
    return unresolved(`unread: ${detail}`, prHead);
  } finally {
    clearTimeout(timer);
  }
}
