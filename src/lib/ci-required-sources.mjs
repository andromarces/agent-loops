// Reads the required-check sources of a base branch (repository rulesets, classic branch
// protection, and `gh pr checks`) and the pull request state that the CI gate judges (#218, #336).
// The judgment lives in `ci-gate.mjs`.
import { execBounded } from "./exec.mjs";
import { isJsonObject } from "./json.mjs";

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

/**
 * Runs `gh` with `args` in `cwd`. Returns `{ status, stdout, stderr, timedOut }`;
 * a non-zero exit is data, not a throw. `timeoutMs` bounds the call and
 * terminates the `gh` child when it expires, so a hung `gh` cannot outlast a
 * caller bound. On POSIX systems the kill is `SIGTERM`, then `SIGKILL` after
 * `forceKillAfterDelay`. On Windows it is `taskkill /T /F` over the process tree.
 * No platform keeps a child the bound has given up on (#329).
 */
export async function runGh(args, cwd, { timeoutMs = 0, signal = null } = {}) {
  const result = await execBounded("gh", args, { cwd, timeoutMs, signal });
  return {
    status: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: Boolean(result.timedOut),
  };
}

/** The text a failed `gh` call reports: its trimmed stderr, or its exit status when stderr is empty. */
export function ghFailureText({ status, stderr }) {
  return stderr.trim() || `exit ${status}`;
}

/** The refusal for a pull request whose merge state is `BLOCKED` after the check pass. */
export const MERGE_BLOCKED_REFUSAL =
  "the PR merge state is blocked (a required check, review, or other required rule is unmet)";

export async function ghApi(gh, args, cwd) {
  const { status, stdout, stderr } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    throw new Error(`gh api ${args[0]} failed: ${ghFailureText({ status, stderr })}`);
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
    throw new Error(`gh api ${args[0]} failed: ${ghFailureText({ status, stderr })}`);
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
// that found no rule. It is not a positive absence. It does not refuse the
// per-check path. A classic-only repository therefore keeps the behavior it had
// before the ruleset read was classified (issue #336 review).
export const ABSENT = "absent";
const HAS_CONTEXTS = "contexts";
export const UNKNOWN = "unknown";
export const EMPTY = "empty";

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
export const RULESETS = "repository rulesets";
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
  const required = isJsonObject(data) ? data.required_status_checks : undefined;
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
export function earlyMergeRefusal(mergeState) {
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

// A runner whose calls also end when `signal` aborts, beside any signal the
// caller's runner already carries.
const withSignal =
  (gh, signal) =>
  (args, cwd, options = {}) =>
    gh(args, cwd, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    });

// The first failure of a group, in sequential order, carried past the wait for
// the cancelled siblings. `expired` is whether the caller's deadline (`gh.deadline`)
// had already fired when the failure was captured. A failure captured before the
// deadline stays the outcome, so a deadline that expires during the wait cannot
// replace it. The entry points unwrap it with `failureOf`.
export class ReadFailure {
  constructor(cause, expired) {
    this.cause = cause;
    this.expired = expired;
  }
}

export const failureOf = (err) => (err instanceof ReadFailure ? err.cause : err);

// Runs independent reads together. Each maker receives a runner that the group
// can cancel. The reads are awaited in list order, so the first failure in that
// order throws as soon as it is reached, the error the same reads run in sequence
// surfaced. A later sibling that is slow or stalled never delays that error. On a
// failure the remaining reads are cancelled and settled before the throw, so no
// `gh` child outlives the caller.
export async function inOrder(gh, makers) {
  const group = new AbortController();
  const scoped = withSignal(gh, group.signal);
  const reads = makers.map((make) => make(scoped));
  for (const read of reads) {
    read.catch(() => {});
  }
  try {
    const values = [];
    for (const read of reads) {
      values.push(await read);
    }
    return values;
  } catch (err) {
    const expired = gh.deadline?.aborted ?? false;
    group.abort();
    await Promise.allSettled(reads);
    throw new ReadFailure(err, expired);
  }
}

// Starts the repository read beside the PR read. A failure surfaces only when the
// caller awaits `read`, after the PR checks that came first in sequence. `cancel`
// ends and settles the read, so an early return leaves no `gh` child running.
export function startRepoSlug(gh, cwd) {
  const controller = new AbortController();
  const read = repoSlug(withSignal(gh, controller.signal), cwd);
  read.catch(() => {});
  return {
    read,
    cancel: async () => {
      controller.abort();
      await Promise.allSettled([read]);
    },
  };
}

export async function prInfo(gh, pr, cwd) {
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
    throw new Error(`gh pr view ${pr} failed: ${ghFailureText({ status, stderr })}`);
  }
  return JSON.parse(stdout);
}

async function repoSlug(gh, cwd) {
  const { status, stdout, stderr } = await gh(
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  if (status !== 0 || stdout.trim() === "") {
    throw new Error(`gh repo view failed: ${ghFailureText({ status, stderr })}`);
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
export const NO_REQUIRED_CHECKS = /^no required checks reported on the '.+' branch$/;

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
export async function requiredContexts(gh, slug, base, pr, cwd) {
  const contexts = new Map();
  const unknown = [];
  const unparsed = [];

  const [rules, protection, listed] = await inOrder(gh, [
    (read) =>
      readRequiredSource(
        read,
        // The endpoint paginates at 30 rules per page by default, so a single read can
        // stop before a required-status-check rule and report an absence for a branch
        // that requires one. Every page is fetched, and a body the gate cannot account
        // for every page of is unknown (issue #336 review).
        [`repos/${slug}/rules/branches/${base}`, "--paginate", "--slurp"],
        cwd,
        { absentOnError: () => false, classify: classifyRulesets },
      ),
    (read) =>
      readRequiredSource(read, [`repos/${slug}/branches/${base}/protection`], cwd, {
        absentOnError: isNotProtected404,
        classify: classifyProtection,
        malformed: isProtectionMalformed,
      }),
    (read) => ghRequiredNames(read, pr, cwd),
  ]);
  if (rules.state === UNKNOWN) {
    unknown.push(RULESETS);
  }
  if (rules.unparsed) {
    unparsed.push(RULESETS);
  }
  for (const context of rules.contexts) {
    addContext(contexts, context.name, context.appId);
  }
  if (protection.state === UNKNOWN) {
    unknown.push(PROTECTION);
  }
  if (protection.unparsed) {
    unparsed.push(PROTECTION);
  }
  for (const context of protection.contexts) {
    addContext(contexts, context.name, context.appId);
  }

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
    // is neither an absence nor a refusal. It contributes no contexts. It leaves
    // the per-check path to the other sources, as it did before the ruleset read
    // was classified (issue #336 review).
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
