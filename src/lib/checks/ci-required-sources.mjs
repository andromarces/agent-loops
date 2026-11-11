// Reads the required-check sources of a base branch: repository rulesets, classic branch
// protection, and `gh pr checks`. It also reads the pull request state that the CI gate judges
// (#218, #336). The absence and resolution judgments live here.
import {
  ghApiFailure,
  ghFailureText,
  isCleanServerError,
  isTransportFailure,
  pagedRead,
  readOne,
} from "./gh-api.mjs";
import { inOrder } from "./bounded-call.mjs";
import { isJsonObject, tryParseJson } from "../json.mjs";

// A source the caller cannot read answers 404 or 403, and the message names the
// credential. Observed live on the classic-protection endpoint (#280, #295):
//
//   `Not Found`                             404  a token without repository admin.
//   `Branch not protected`                  404  an admin, on a branch with no
//                                                  classic protection.
//   `Resource not accessible by integration` 403  a `GITHUB_TOKEN`.
//   `Resource not accessible by personal
//    access token`                           403  a fine-grained PAT without the
//                                                  Administration permission.
//
// All four leave the source with no required contexts. The caller refuses an
// empty union over an unknown source either way, so the gate treats them alike.
// The second is not a permission problem: the branch simply has no classic
// protection, and a ruleset-only repository answers it for an admin. That one
// also states the absence, so it is the one of the four that establishes it
// (issue #336).
//
// A private repository on the GitHub Free plan answers 403 on the classic
// protection, branch rules, and rulesets endpoints. Its message names the plan
// instead of the credential (#301). The measurement covered two private Free-plan
// repositories, with an admin classic PAT and an admin fine-grained PAT:
//
//   `Upgrade to GitHub Pro or make this repository public
//    to enable this feature.`                     403  a private repository on
//                                                     the Free plan.
//
// The credential is not the problem, so the reasoning above does not carry over
// and this reply has its own argument. The plan does not allow the rule that
// requires a check. No required context can exist on that repository, and the
// source is empty by the same outcome the caller refuses on. The reply is the
// same on a branch that exists and on one that does not, so it carries nothing
// about the branch.
//
// Match the message, not the status. `gh` renders every failure as
// `gh: <message> (HTTP <status>)`. A rate-limit or SSO 403 then carries the same
// suffix as the `GITHUB_TOKEN` 403, and the status cannot tell them apart.
// Reading a rate-limit 403 as an unreadable source silently drops every required
// context. It also downgrades a named check refusal to the generic blocked
// refusal, so anything unrecognized throws instead. A narrower match only costs a
// thrown error, which still fails closed.
//
// The Free-plan reply is compared as a whole string rather than added to
// `UNREADABLE`. That pattern is an unanchored search, so an alternative added to
// it matches any stderr that contains the message anywhere. That includes a reply
// with extra text around it or another error line beside it. Comparing the whole
// stderr keeps the Free-plan reply exact, after one trailing LF or CRLF is
// dropped. Every input that `UNREADABLE` treats a certain way stays untouched.
//
// `Not Found` and the 403s are safe to read as unreadable on these two calls. The
// slug comes from `gh repo view`, and the base branch comes from the pull request.
// The caller has already read both successfully, so a wrong value here cannot
// come from a typo. The `Branch not found` reply is not matched, so it throws. An
// admin gets it for a branch that does not exist, so a typo still surfaces when
// the caller can read protection. It cannot be relied on to surface otherwise.
//
// A non-admin token can read the branch but not its protection settings, so a typo
// answers the same `Not Found` as a protected branch. A fine-grained PAT without
// the Administration permission answers the same 403 whatever the branch is. The
// already-read values are what make a typo impossible here, not the message.
const UNREADABLE =
  /(?:Not Found|Branch not protected) \(HTTP 404\)|Resource not accessible by (?:integration|personal access token) \(HTTP 403\)/;

// The exact 404 the classic protection endpoint writes only to a caller that can
// read it, on a branch with no classic protection. It is the one unreadable reply
// that proves the source holds no required check (issue #336). It is compared
// whole, like the Free-plan 403 below, because an unanchored search also matches
// the same text inside another error. A reply that merely quotes it, or carries
// it beside a second line, says nothing about the branch. It must not read as an
// absence (issue #336 review).
const NOT_PROTECTED_404 = "gh: Branch not protected (HTTP 404)";

// The exact reply a private Free-plan repository writes, compared whole so no
// surrounding text or second line can pass as it.
const FREE_PLAN_403 =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

/** Whether `stderr` is exactly `text`, one trailing LF or CRLF aside. */
function isExactReply(stderr, text) {
  return stderr.replace(/\r?\n$/, "") === text;
}

/**
 * One required-check configuration source, classified by what its reply proved.
 *
 * The classification is an allowlist, so it fails closed, and `ABSENT` is the only answer that lets
 * a finish pass. `ABSENT` comes only from a ruleset reply with no `required_status_checks` rule, or
 * the exact `Branch not protected` (404) of classic protection (#280, #295, #336).
 * @param {object} options
 * @param {(stderr: string) => boolean} options.absentOnError the one non-zero reply that proves
 *   this source holds no required check, compared whole
 * @param {(data: unknown) => boolean} [options.malformed] whether a parsed body has a shape the
 *   classification cannot interpret
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
  const reply = await gh(["api", ...args], cwd);
  const { status, stdout, stderr, unreadable } = reply;
  if (status !== 0) {
    if (unreadable) {
      return { state: UNKNOWN, contexts: [], unparsed: true };
    }
    // Each source allows exactly one reply shape to produce `ABSENT`.
    // The classic endpoint writes the 404 only to a caller that can read protection, and it names
    // an unprotected branch.
    if (absentOnError(stderr)) {
      return { state: ABSENT, contexts: [] };
    }
    // Every non-zero exit other than the exact 404 is `UNKNOWN`.
    // `Not Found` (404), both `Resource not accessible` 403s, and the Free-plan 403 are `UNKNOWN` too.
    // The Free-plan reply names the plan and not the branch.
    // `UNKNOWN` settles nothing and keeps the empty-union refusal.
    if (UNREADABLE.test(stderr) || isExactReply(stderr, FREE_PLAN_403)) {
      return { state: UNKNOWN, contexts: [] };
    }
    // A non-zero reply that is not an unreadable shape still throws, which fails the run instead of the gate (#280).
    throw ghApiFailure(args[0], reply);
  }
  const text = stdout.trim();
  // An empty body, no JSON, and a body that is not this endpoint's shape are `UNKNOWN` and unparsed.
  if (text === "") {
    return { state: UNKNOWN, contexts: [], unparsed: true };
  }
  const body = tryParseJson(text);
  if (body === null) {
    return { state: UNKNOWN, contexts: [], unparsed: true };
  }
  const { state, contexts } = classify(body);
  // `HAS_CONTEXTS` names at least one required check, so the per-check pass runs, and every other
  // reply is `UNKNOWN`, which settles nothing.
  // `unparsed` marks a successful reply that is not the JSON object or array the
  // endpoint returns, or whose shape `malformed` cannot interpret. The gate
  // ignores it. The status read and the check wait refuse on it, because that
  // reply can hide a required context (issue #349).
  return {
    state,
    contexts,
    unparsed: typeof body !== "object" || malformed(body),
  };
}

// The classifications a required-check configuration source reply can carry.
// `ABSENT` is a reply that states the source holds no required check.
// `HAS_CONTEXTS` names at least one, and `UNKNOWN` settles nothing.
// `EMPTY` is the one outcome the ruleset source alone carries: a successful read
// that found no rule. It is not a positive absence. It does not refuse the
// per-check path, so a classic-only repository still finishes on that path
// (issue #336).
export const ABSENT = "absent";
const HAS_CONTEXTS = "contexts";
export const UNKNOWN = "unknown";
export const EMPTY = "empty";

// Every rule type GitHub documents for a repository ruleset, from the create and
// update ruleset schemas. A rule entry is unknown rather than skipped when its
// `type` is missing, is not a string, or is outside this list. A type this list
// does not carry can be a required-status-check rule under a name the gate has not
// seen (issue #336 review). The list is the documented one, not an observed one.
// A future GitHub rule type makes such a read unknown, which refuses, and that is
// the safe direction.
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

/**
 * Classifies a successful repository rulesets read.
 * `ABSENT` needs a JSON array whose entries are all well-formed rules, and none of them a
 * `required_status_checks` rule. That is the only shape in which the read states that no
 * required-status-check rule applies to the branch. A malformed entry makes the whole read unknown
 * rather than skipped. An entry the gate cannot read can be a required-status-check rule that it
 * never enforced (issue #336).
 * @param {unknown} data the parsed body.
 * @returns {{ state: string, contexts: { name: string, appId: number | null }[] }}
 */
export function classifyRulesets(data) {
  // The paged read wraps every page in an outer array, so a complete read is an array
  // of arrays. A body is not that shape when it is not an array of arrays, or when
  // it holds a page that is not an array. Such a read cannot account for every
  // page, so it settles nothing instead of being classified from the pages that
  // arrived (issue #336 review).
  if (!Array.isArray(data) || data.some((page) => !Array.isArray(page))) {
    return { state: UNKNOWN, contexts: [] };
  }
  if (data.length === 0) {
    // A read that returned no page at all is not a read that found no rule. An
    // empty body from the paginated call is the same reply whether the branch has
    // no rule or the read returned nothing. Only the single empty page says the
    // first (issue #336 review).
    return { state: UNKNOWN, contexts: [] };
  }
  if (data.every((page) => page.length === 0)) {
    // Exactly one empty page is the reply that says the branch has no rule, so it
    // is `EMPTY`. More than one empty page is an anomalous sequence. GitHub stops
    // paginating when there is no next page. A second empty page then means the
    // read is not the complete result it claims to be (issue #336 review).
    return { state: data.length === 1 ? EMPTY : UNKNOWN, contexts: [] };
  }
  if (data.some((page) => page.length === 0)) {
    // An empty page beside a page that holds rules settles nothing, for the same
    // reason. A partial read must not be classified from the pages that did arrive
    // (issue #336 review).
    return { state: UNKNOWN, contexts: [] };
  }
  const rules = data.flat();
  const contexts = [];
  for (const rule of rules) {
    if (!isJsonObject(rule)) {
      return { state: UNKNOWN, contexts: [] };
    }
    // A well-formed rule is an object that carries a string `type`.
    if (typeof rule.type !== "string" || !RULE_TYPES.has(rule.type)) {
      // A type the gate does not know can be a required-status-check rule under a
      // name this list does not carry. It is therefore unknown rather than skipped
      // (issue #336 review).
      return { state: UNKNOWN, contexts: [] };
    }
    if (rule.type !== "required_status_checks") {
      continue;
    }
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      // A required-status-check rule that names no check states neither an
      // absence nor a context the gate can enforce.
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
 * The contexts a classic `required_status_checks` object names, from its `contexts` names and its
 * `checks` entries. A missing list is empty.
 * @param {Record<string, unknown>} required
 * @returns {{ name: string, appId: number | null }[] | null} `null` when either list is not an
 *   array or holds an entry that names no check (issue #1265).
 */
function protectionContexts(required) {
  const { contexts = [], checks = [] } = required;
  if (!Array.isArray(contexts) || !Array.isArray(checks)) {
    return null;
  }
  const named = [];
  for (const context of contexts) {
    if (typeof context !== "string" || context === "") {
      return null;
    }
    named.push({ name: context, appId: null });
  }
  for (const check of checks) {
    if (typeof check?.context !== "string" || check.context === "") {
      return null;
    }
    named.push({ name: check.context, appId: check.app_id });
  }
  return named;
}

/**
 * Classifies a successful classic branch-protection read, and no body proves an absence for this
 * source. The reply that states it is the exact `Branch not protected` (404) on the error path, so
 * a successful body never reaches `ABSENT`. A body that is not the endpoint object, or whose
 * `required_status_checks` is present but not an object, is unknown. A body with no
 * `required_status_checks` names no context, but it does not say the branch is unprotected. A
 * classic-protected branch can require reviews or a signed-off push without requiring a check, so
 * that body is unknown too (issue #336).
 * @param {unknown} data the parsed body.
 * @returns {{ state: string, contexts: { name: string, appId: number | null }[] }}
 */
function classifyProtection(data) {
  const required = isJsonObject(data) ? data.required_status_checks : undefined;
  if (!isJsonObject(required)) {
    return { state: UNKNOWN, contexts: [] };
  }
  const contexts = protectionContexts(required);
  if (contexts === null || contexts.length === 0) {
    return { state: UNKNOWN, contexts: [] };
  }
  return { state: HAS_CONTEXTS, contexts };
}

// Whether a classic protection body has a shape the status read and the check wait cannot interpret.
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
  return protectionContexts(required) === null;
}

/**
 * Reads the PR fields the gate judges: `headRefOid`, `baseRefName`, `mergeStateStatus`,
 * `potentialMergeCommit`, and `state`.
 * @returns {Promise<object>} the parsed `gh pr view` stdout, with no shape check
 * @throws {Error} on a non-zero exit, and stdout that is not JSON throws a raw `SyntaxError`
 */
export async function prInfo(gh, pr, cwd) {
  const { status, stdout, stderr } = await gh(
    [
      "pr",
      "view",
      String(pr),
      "--json",
      "headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit,state",
    ],
    cwd,
  );
  if (status !== 0) {
    throw new Error(`gh pr view ${pr} failed: ${ghFailureText({ status, stderr })}`);
  }
  return JSON.parse(stdout);
}

/** The repository slug. `failure` is the verb phrase of the error text that follows `gh repo view`. */
export async function repoSlug(gh, cwd, failure = "failed") {
  const { status, stdout, stderr } = await gh(
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  if (status !== 0 || stdout.trim() === "") {
    throw new Error(`gh repo view ${failure}: ${ghFailureText({ status, stderr })}`);
  }
  return stdout.trim();
}

// The exact `gh pr checks --required` reply on a branch with no required check. It is compared
// against the trimmed stderr of an exit 1 with no stdout.
export const NO_REQUIRED_CHECKS = /^no required checks reported on the '.+' branch$/;

// The `gh pr checks` exit code of a pending check, as `docs/orchestrator/reviewer-evidence.md` states
// it for the reviewer read. Exit 1 covers a failing check, a read error, and a repository with no
// required check, so the check list decides (#329).
export const EXIT_PENDING = 8;

// The exact `gh pr checks` reply on a PR head that no check has reported on yet, as right after a
// push. It is an empty list, not a read error, in the required and the all-checks read alike (#941,
// #950).
export const NO_CHECKS_YET = /^no checks reported on the '.+' branch$/;

/**
 * The required names of one `gh pr checks --required --json` reply. Any field list that includes
 * `name` serves, so the wait passes the reply of its own check-list read instead of a second one.
 * `gh pr checks --required` resolves required check names without admin rights. This source
 * carries no app qualifier, so every name it yields is unqualified. A reply that is no list
 * carries `transient` and the `failure` text for a clean server error or a transport failure.
 * @returns {{ names: string[], ok: boolean, transient?: boolean, failure?: string }}
 */
export function requiredNamesOf({ status, stdout, stderr }) {
  const parsed = tryParseJson(stdout);
  if (Array.isArray(parsed)) {
    // `gh pr checks --required` lists only checks that already reported on the commit. It exits
    // non-zero for a pending or failing check, and prints no JSON when no required check has
    // reported. The output is parsed leniently, so an unparseable reply contributes no names.
    // A read succeeds by its exit code, whatever its stdout holds, and every item must name a check.
    const named = parsed.every((check) => typeof check?.name === "string" && check.name !== "");
    // `ok` is true only for exit 0, or a failing or pending exit with a non-empty list of named checks.
    const succeeded =
      status === 0 || ((status === 1 || status === EXIT_PENDING) && parsed.length > 0);
    return {
      names: parsed.map((check) => check?.name).filter(Boolean),
      ok: named && succeeded,
    };
  }
  // The exact `no required checks reported` answer on exit 1 with no stdout is also `ok`.
  const none = stdout.trim() === "" && status === 1 && NO_REQUIRED_CHECKS.test(stderr.trim());
  // Any other exit, an empty list on a non-zero exit, and an error text that merely contains those
  // words are a failed read. The `NO_CHECKS_YET` reply is a failed read too.
  // The gate ignores `ok`. The status read and the check wait refuse on it, because the list can
  // name a required check that no configuration source did (issue #349).
  // The wait retries a clean server error or a transport failure (#1121, #1312).
  // An unparseable reply is never retried.
  const transient =
    isCleanServerError({ stdout, stderr }) || isTransportFailure({ stdout, stderr });
  return { names: [], ok: none, transient, failure: transient ? stderr.trim() : "" };
}

async function ghRequiredNames(gh, pr, cwd) {
  return requiredNamesOf(
    await gh(["pr", "checks", String(pr), "--required", "--json", "name"], cwd),
  );
}

// A required status context is its name. It also holds the id of the app whose
// check run must satisfy it, when the source qualifies the context with one. A
// null `appId` is unqualified and is satisfied by a check run or a commit status
// with the name. Ruleset entries carry `integration_id`, classic-protection
// entries carry `app_id`, and `gh pr checks --required` carries no app qualifier.
function contextKey(name, appId) {
  return `${name}\0${appId ?? ""}`;
}

function addContext(contexts, name, appId = null) {
  if (name) {
    // A source can report `-1` as the "any app" qualifier. Treat it as absent.
    const qualifier = appId == null || appId === -1 ? null : appId;
    contexts.set(contextKey(name, qualifier), { name, appId: qualifier });
  }
}

// The repository-rulesets source of `base`, classified. The endpoint paginates at 30 rules per page by
// default, so a single read can stop before a required-status-check rule. It can then report an absence
// for a branch that requires one. Every page is fetched by page number, never by a reply-supplied `Link`
// URL. A body the gate cannot account for every page of is unknown or an error (issue #336
// review, #1033).
function readRulesets(gh, slug, base, cwd) {
  // Its absentOnError predicate never matches, because that endpoint does not write the 404.
  return readRequiredSource(pagedRead(gh), [`repos/${slug}/rules/branches/${base}`], cwd, {
    absentOnError: () => false,
    classify: classifyRulesets,
  });
}

// The classic branch-protection source of `base`, classified. With `retryable`, the read is a
// status-classified `--include` read (#1091).
// Classic protection proves an absence only with the exact `Branch not protected` 404.
function readProtection(gh, slug, base, cwd, retryable = false) {
  return readRequiredSource(
    retryable ? (args, readCwd) => readOne(gh, args[1], readCwd) : gh,
    [`repos/${slug}/branches/${base}/protection`],
    cwd,
    {
      absentOnError: (stderr) => isExactReply(stderr, NOT_PROTECTED_404),
      classify: classifyProtection,
      malformed: isProtectionMalformed,
    },
  );
}

/**
 * The ruleset state of `base` is the one answer a caller that judges nothing else needs.
 * It holds the result of `requiredContexts` and none of its reads that cannot change it.
 * The ruleset and protection reads start together, as in `requiredContexts`, so both fit one deadline.
 * A ruleset state that settled something (not `UNKNOWN`) is the answer whatever the protection
 * read does. A failed protection read throws, so a caller treats it as no answer, and a successful
 * one adds nothing.
 * @returns {Promise<string>} `ABSENT`, `EMPTY`, `UNKNOWN`, or the state of a source that names a context
 */
export async function readRulesetState(gh, slug, base, cwd) {
  // The protection read is canceled once the ruleset state settles.
  // Only an `UNKNOWN` state waits for the protection read, because a failed read leaves no refusal standing.
  // The names read of `gh pr checks --required` never decides the answer, so it is not made (#1182).
  const [rules] = await inOrder(
    gh,
    [
      (read) => readRulesets(read, slug, base, cwd),
      (read) => readProtection(read, slug, base, cwd),
    ],
    ({ state }) => state !== UNKNOWN,
  );
  return rules.state;
}

/**
 * Required status contexts from every source: repository rulesets, classic branch
 * protection, and `gh pr checks --required`. The union is deduplicated by name and app qualifier.
 * `unknown` names every configuration source whose reply settled nothing, because such a source
 * can hold a required check that this caller never saw. An empty union is then a refusal that names
 * each source that settled nothing. An empty union over sources that each stated they hold no
 * required check is an established absence that the gate records (issue #336).
 * `gh pr checks --required` contributes names and nothing else, so it never appears among those
 * sources and never establishes an absence.
 */
export async function requiredContexts(
  gh,
  slug,
  base,
  pr,
  cwd,
  { retryable = false, names = null, sourceCache = null } = {},
) {
  const contexts = new Map();
  const unknown = [];
  const unparsed = [];
  // With `retryable`, the protection read is a status-classified `--include` read like the paged rules read (#1091).
  // A failed read of either source with a retryable status then carries `transient` for the next poll.
  // The default reads stay as the gate pins them.
  // With `names`, the `requiredNamesOf` result of a reply the caller already holds, the names read is not repeated (#1125).
  // `sourceCache` is a Map the caller owns, and a clean ruleset or protection result is kept per base branch (#1267).
  // A repeated caller then reads each source once through the same Map.

  const cached = async (kind, read) => {
    const key = `${kind}\0${base}`;
    if (sourceCache?.has(key)) {
      return sourceCache.get(key);
    }
    const source = await read();
    // Only a result that settled a class other than `UNKNOWN` is kept.
    // An unknown, unreadable, unparsed, or failed read is read again by the next call.
    // A change to the rules after the first read is not seen through the same Map.
    if (sourceCache && source.state !== UNKNOWN && !source.unparsed) {
      sourceCache.set(key, source);
    }
    return source;
  };
  const [rules, protection, listed] = await inOrder(gh, [
    (read) => cached("rules", () => readRulesets(read, slug, base, cwd)),
    (read) => cached("protection", () => readProtection(read, slug, base, cwd, retryable)),
    (read) => (names ? Promise.resolve(names) : ghRequiredNames(read, pr, cwd)),
  ]);
  for (const [source, label] of [
    [rules, RULESETS],
    [protection, PROTECTION],
  ]) {
    if (source.state === UNKNOWN) {
      unknown.push(label);
    }
    if (source.unparsed) {
      unparsed.push(label);
    }
    for (const context of source.contexts) {
      addContext(contexts, context.name, context.appId);
    }
  }

  // It lists only the checks that already reported, so it can name a required check and cannot prove one absent.
  // On a base branch with no required check it prints nothing, which is the same silence as a read failure.
  for (const name of listed.names) {
    addContext(contexts, name);
  }

  // An unqualified copy of an app-qualified name cannot express which app must
  // pass. It judges the name by the newest run from any app and can refuse a
  // passing qualified check. Drop it in favor of the qualified context, which the
  // per-context check enforces.
  const values = [...contexts.values()];
  const qualifiedNames = new Set(
    values.filter((context) => context.appId !== null).map((context) => context.name),
  );
  return {
    unknown,
    unparsed,
    namesRead: listed.ok,
    // A failed names read that named a server error, and the error text. Only the wait retries it,
    // the gate ignores both.
    namesTransient: Boolean(listed.transient),
    namesFailure: listed.failure ?? "",
    // The ruleset state is carried separately from `unknown`, because an empty read
    // is neither an absence nor a refusal. It contributes no contexts. It leaves
    // the per-check path to the other sources (issue #336).
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

/**
 * Whether the required contexts that `requiredContexts` resolved state an absence of a required
 * check. The gate and the check wait share it, so one rule decides it (issue #1013).
 *
 * Returns `null` when a source names a required check, so there is no absence to decide, and the
 * caller judges each named check. With no named check, returns `{ absent: true }` when both the
 * rulesets and the classic protection stated they hold none. With no named check, returns
 * `{ unproven }` when the listed sources did not state an absence. A parent can only fix a source
 * it can see (issue #336).
 * @param {{ unknown: string[], rulesetState: string, protectionState: string, contexts: object[] }} required
 * @returns {{ absent: true } | { unproven: string[] } | null}
 */
export function requiredAbsence({ unknown, rulesetState, protectionState, contexts }) {
  if (contexts.length > 0) {
    return null;
  }
  // `classifyProtection` returns only `HAS_CONTEXTS` or `UNKNOWN`, and `ABSENT` comes from the
  // exact-404 path in `readRequiredSource`, so an unreadable protection reply is already in
  // `unknown`.
  if (rulesetState === ABSENT && protectionState === ABSENT) {
    return { absent: true };
  }
  // A source that settled nothing and a ruleset read that found no rule are both named.
  const unproven = [...unknown];
  // The protection source cannot be `EMPTY`: only the ruleset source returns it.
  if (rulesetState === EMPTY) {
    unproven.push(RULESETS);
  }
  return { unproven };
}

/**
 * Why a failed read of the required names, or of a reply that cannot be parsed, leaves the
 * required contexts unresolved. Returns null when neither applies. `requiredResolutionRefusal`
 * and the wait on a no-required-checks answer share it.
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
 * - A reply that is not parseable JSON can hide a required context, so it is unresolved whatever
 *   the other source names.
 * - An unreadable 404 or 403 reply is not this case, because the gate accepts it too.
 * - A failed names read can drop a required check that no other source names, so it is unresolved
 *   whatever the rest of the union holds.
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
