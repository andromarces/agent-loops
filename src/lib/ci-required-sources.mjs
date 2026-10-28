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

/** Whether `stderr` is exactly `text`, one trailing LF or CRLF aside. */
function isExactReply(stderr, text) {
  return stderr.replace(/\r?\n$/, "") === text;
}

// `gh` reads these two names and then writes a debug log to stderr, which breaks the exact stderr
// match of the protection read (#1047). Compared in upper case, because Windows names are case-blind.
const GH_DEBUG_NAMES = new Set(["GH_DEBUG", "DEBUG"]);

/**
 * The environment of this process without the names that turn on the debug log of `gh`, and
 * without the names in `dropEnv`.
 */
function ghEnv(dropEnv) {
  const dropped = new Set([...GH_DEBUG_NAMES, ...dropEnv.map((name) => name.toUpperCase())]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !dropped.has(name.toUpperCase())),
  );
}

/**
 * Runs `gh` with `args` in `cwd`. Returns `{ status, stdout, stderr, timedOut }`;
 * a non-zero exit is data, not a throw. `timeoutMs` bounds the call and
 * terminates the `gh` child when it expires, so a hung `gh` cannot outlast a
 * caller bound. On POSIX systems the kill is `SIGTERM`, then `SIGKILL` after
 * `forceKillAfterDelay`. On Windows it is `taskkill /T /F` over the process tree.
 * No platform keeps a child the bound has given up on (#329). `dropEnv` names variables that this
 * one call removes from the child environment, compared in upper case because Windows names are
 * case-blind. Every call also drops `GH_DEBUG` and `DEBUG` (#1047), and the rest of the
 * environment stays.
 */
export async function runGh(args, cwd, { timeoutMs = 0, signal = null, dropEnv = [] } = {}) {
  const result = await execBounded("gh", args, {
    cwd,
    timeoutMs,
    signal,
    env: ghEnv(dropEnv),
    extendEnv: false,
  });
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

/** The error of a failed `gh api` call on `endpoint`. It carries `transient` when the reply did. */
function ghApiFailure(endpoint, { status, stderr, transient }) {
  const err = new Error(`gh api ${endpoint} failed: ${ghFailureText({ status, stderr })}`);
  if (transient) {
    err.transient = true;
  }
  return err;
}

export async function ghApi(gh, args, cwd) {
  const { status, stdout, stderr, transient } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    throw ghApiFailure(args[0], { status, stderr, transient });
  }
  const text = stdout.trim();
  return text === "" ? null : JSON.parse(text);
}

// The reply statuses of a failed paged read that the wait retries on the next poll (#1025). The
// status is the one on the first line of the stdout that `gh api --include` wrote for that one
// request, never a number in the error text of `gh`, which carries server-supplied text.
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Whether the stderr of a failed `gh pr` read names a retryable server error. `gh` words it
 * `HTTP <status>: <message> (<url>)` and the status opens the text, so only that opening counts: a
 * status in later text or inside a 4xx message never makes a retry (#1121).
 */
export function isServerErrorText(stderr) {
  const status = /^HTTP (\d{3})\b/.exec(stderr.trimStart());
  return status !== null && RETRYABLE_STATUSES.has(Number(status[1]));
}

// The status line, header lines, and blank line that open the stdout of one `gh api --include`
// request. Body bytes can only follow them, so they never form a status block of their own.
const STATUS_BLOCK = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*\r?\n(?:[^\r\n:]+:[^\r\n]*\r?\n)*\r?\n/;

// Items per page, and the most pages one read takes: 10,000 items, far above any one commit.
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/**
 * The status, header text, and body of the one reply in a `gh api --include` stdout, or null with no
 * status block.
 */
function parseReply(stdout) {
  const block = STATUS_BLOCK.exec(stdout);
  return block
    ? {
        status: Number(block[1]),
        headers: block[0].slice(block[0].indexOf("\n") + 1),
        body: stdout.slice(block[0].length),
      }
    : null;
}

// The variables that make `gh auth status` list github.com beside the configured hosts. `gh` does
// not count that listing as a configured host when it picks its default host, so the lookup of the
// default host runs without them.
const TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"];

/**
 * The host that `gh api` sends a request to when `GH_HOST` is unset, from the parsed stdout of
 * `gh auth status --json hosts` run without `TOKEN_NAMES`, or null when the reply states none.
 * Observed with `gh` 2.103.1: the default host is the one host of the configuration, and github.com
 * for none or several, and that listing then holds the configured hosts only. A reply that is not
 * the documented shape states no host, so it never widens the accepted hosts.
 * @param {unknown} reply
 */
function defaultHost(reply) {
  const hosts = reply?.hosts;
  if (typeof hosts !== "object" || hosts === null || Array.isArray(hosts)) {
    return null;
  }
  const configured = [];
  for (const [name, logins] of Object.entries(hosts)) {
    const host = name.trim().toLowerCase();
    const sound =
      host !== "" &&
      Array.isArray(logins) &&
      logins.length > 0 &&
      logins.every(
        (login) =>
          isJsonObject(login) &&
          typeof login.host === "string" &&
          login.host.trim().toLowerCase() === host &&
          typeof login.tokenSource === "string" &&
          login.tokenSource !== "",
      );
    if (!sound) {
      return null;
    }
    configured.push(host);
  }
  return configured.length === 1 ? configured[0] : "github.com";
}

// The hosts that a request of `gh api` goes to: the host from `GH_HOST`, else the default host of
// `gh` (see `defaultHost`), and the host that serves its API. A host that only starts like one of
// these is another host. The set is empty when no host is stated, so every target then counts as
// another host.
async function requestHosts(read, cwd) {
  let host = (process.env.GH_HOST ?? "").trim().toLowerCase();
  if (host === "") {
    const { status, stdout } = await read(["auth", "status", "--json", "hosts"], cwd, {
      dropEnv: TOKEN_NAMES,
    });
    let reply = null;
    try {
      reply = JSON.parse(stdout);
    } catch {
      // An unreadable reply states no host.
    }
    host = status === 0 ? defaultHost(reply) : null;
    if (host === null) {
      return new Set();
    }
  }
  if (host === "github.com") {
    return new Set([host, "api.github.com"]);
  }
  return new Set(host.endsWith(".ghe.com") ? [host, `api.${host}`] : [host]);
}

/** The targets of the `Link` headers in `headers`. */
function linkTargets(headers) {
  const targets = [];
  for (const line of headers.split(/\r?\n/)) {
    if (/^link:/i.test(line)) {
      targets.push(...Array.from(line.matchAll(/<([^>]*)>/g), ([, target]) => target));
    }
  }
  return targets;
}

/**
 * The first of `targets` that names a host outside `hosts`, or null. A target that is not a URL
 * counts as another host, so a header the runtime cannot read is no pass.
 */
function foreignTarget(targets, hosts) {
  const [home] = hosts;
  for (const target of targets) {
    let host = null;
    try {
      host = home === undefined ? null : new URL(target, `https://${home}`).host.toLowerCase();
    } catch {
      // An unreadable target is refused below.
    }
    if (host === null || !hosts.has(host)) {
      return target;
    }
  }
  return null;
}

/** Whether `body` is exactly one JSON value, an empty body not included. */
function isJsonBody(body) {
  return body.trim() !== "" && isEmptyOrJson(body);
}

/** Whether `body` is empty or exactly one JSON value. */
function isEmptyOrJson(body) {
  if (body.trim() === "") {
    return true;
  }
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/** A refusal about the shape of a reply: a read the runtime cannot account for, as no `gh` failure. */
const refusal = (stderr) => ({ status: 1, stdout: "", stderr, unreadable: true });

/**
 * One `gh api --include` request, judged as the pager judges every page, and the one place that
 * judges it, so a single read and a paged read cannot drift apart. The `Link` header of every reply
 * is judged before its status, so a failure that is retryable by its status is still terminal when a
 * target names another host. The request host is resolved once per read (`state.hosts`), and only
 * for a reply that carries a `Link` target. It returns `{ end, reply }` for a failure or a refusal,
 * where `end` is the `gh`-shaped result and `reply` the parsed reply, or null with no status block,
 * and `{ reply, json }` for a 2xx reply whose body is exactly one JSON value.
 * @param {Function} read
 * @param {string[]} args the `gh` arguments of the request
 * @param {string} cwd
 * @param {{ hosts?: Set<string> }} state
 */
async function readReply(read, args, cwd, state) {
  const result = await read(args, cwd);
  const reply = parseReply(result.stdout);
  const targets = reply === null ? [] : linkTargets(reply.headers);
  if (targets.length > 0) {
    state.hosts ??= await requestHosts(read, cwd);
  }
  const foreign = targets.length > 0 ? foreignTarget(targets, state.hosts) : null;
  if (foreign !== null) {
    return {
      reply,
      end: {
        status: 1,
        stdout: "",
        stderr: `a Link header names a host other than the request host: ${foreign}`,
      },
    };
  }
  if (result.status !== 0) {
    const transient =
      reply !== null && RETRYABLE_STATUSES.has(reply.status) && isEmptyOrJson(reply.body);
    return { reply, end: { ...result, ...(transient ? { transient: true } : {}) } };
  }
  if (reply === null || reply.status < 200 || reply.status > 299) {
    return { reply, end: refusal("the reply carries no 2xx HTTP status block") };
  }
  try {
    return { reply, json: JSON.parse(reply.body) };
  } catch {
    return { reply, end: refusal("the reply body is not exactly one JSON value") };
  }
}

/**
 * Reads every page of the list endpoint `endpoint` with one `gh api --include` request per page,
 * by documented page number and never by the `Link` header, so no request goes to a target that a
 * reply named. It returns a `gh`-shaped result whose stdout is the pages as one JSON array.
 * `field` names the list in an object reply (`check_runs`, `statuses`);
 * with `null`, each page is the list itself. Every page that the read received is in the result, an
 * empty page included, so a classifier sees the whole sequence. For a reply with `total_count`, the
 * read ends only when the collected count equals it, and a count that changes between pages, a
 * collected count above it, and a short or empty page with the count unmet are errors. For a reply
 * with no `total_count`, the first page of fewer than `PAGE_SIZE` items ends the read. The page cap is
 * an error. A `Link` header that names a host other than the request host (see `requestHosts`) is an error too, on a failed reply
 * with a retryable status as on a successful one, and never `transient`: the read
 * never requests that target, and it ends rather than return pages that a reply could have steered.
 * A refusal about the shape of a reply carries `unreadable`, so the ruleset source reads as unknown
 * and the gate reads throw; a foreign `Link` target is no `unreadable` refusal, so every read throws
 * on it. `transient` is set on a failed result only when the failed
 * request's first-line status is 500, 502, 503, or 504 and its body is empty or JSON.
 * @param {Function} read one `gh` read, as `(args, cwd) => result`
 * @param {string} endpoint the endpoint with no query
 * @param {string} cwd
 * @param {string | null} field
 */
async function readPages(read, endpoint, cwd, field) {
  const pages = [];
  let collected = 0;
  let expected;
  const state = {};
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { end, json } = await readReply(
      read,
      ["api", `${endpoint}?per_page=${PAGE_SIZE}&page=${page}`, "--include"],
      cwd,
      state,
    );
    if (end) {
      return end;
    }
    const list = field === null ? json : json?.[field];
    const items = Array.isArray(list) ? list.length : 0;
    const total =
      Number.isInteger(json?.total_count) && json.total_count >= 0 ? json.total_count : null;
    expected ??= { total };
    if (total !== expected.total) {
      return refusal("the total_count of the reply changed between pages");
    }
    const done = () => ({ status: 0, stdout: JSON.stringify(pages), stderr: "" });
    pages.push(json);
    collected += items;
    if (total === null) {
      // No count to check against: the first short page ends the read.
      if (items < PAGE_SIZE) {
        return done();
      }
    } else if (collected > total) {
      return refusal("the pages hold more items than the total_count of the reply");
    } else if (collected === total) {
      return done();
    } else if (items < PAGE_SIZE) {
      // A short page proves nothing while the count is unmet, so the read is an error.
      return refusal("the read ended before the total_count of the reply");
    }
  }
  return refusal(`the read has more than ${MAX_PAGES} pages`);
}

/**
 * A `gh` runner whose `api <endpoint>` call reads every page of `endpoint` through `readPages`,
 * so a caller of `ghApi` or `readRequiredSource` never uses `gh --paginate` (#1033).
 * @param {Function} gh
 * @param {string | null} field see `readPages`
 */
export const pagedRead =
  (gh, field = null) =>
  (args, cwd, options) =>
    readPages(
      (pageArgs, pageCwd, extra) => gh(pageArgs, pageCwd, { ...options, ...extra }),
      args[1],
      cwd,
      field,
    );

/**
 * Reads one endpoint that is no list with `gh api --include`, and judges the reply with the one
 * validation of the pager (`readReply`): the `Link` host check of every reply (#1033), the first-line
 * status, a 2xx status block, and a body that is exactly one JSON value, and the 5xx retry
 * classification of a failed reply (#1025), so `transient` is set as the pager sets it. A success
 * returns a `gh`-shaped result whose stdout is that body. A `Link` target of the request host on a
 * success is a refusal too, because it says the reply is one page of a longer list that this read
 * would take as complete. A refusal about the shape of a reply carries `unreadable`. `notFound` is
 * set on a failed result only for the exact absence reply: a 404 status line, exactly
 * `gh: Not Found (HTTP 404)` on stderr, a body that is one JSON value, and no `Link` target.
 * @param {Function} read one `gh` read, as `(args, cwd) => result`
 * @param {string} endpoint the endpoint with its query
 * @param {string} cwd
 */
export async function readOne(read, endpoint, cwd) {
  const { reply, end } = await readReply(read, ["api", endpoint, "--include"], cwd, {});
  if (end) {
    const exact =
      end.status !== 0 &&
      reply?.status === 404 &&
      end.stderr.trim() === "gh: Not Found (HTTP 404)" &&
      linkTargets(reply.headers).length === 0 &&
      isJsonBody(reply.body);
    return { ...end, ...(exact ? { notFound: true } : {}) };
  }
  if (linkTargets(reply.headers).length > 0) {
    return refusal("the reply carries a Link header, so it may be one page of a longer list");
  }
  return { status: 0, stdout: reply.body, stderr: "" };
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
 *   the exact `Branch not protected` 404 for classic protection, and a predicate that never matches
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
  const { status, stdout, stderr, unreadable, transient } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    if (unreadable) {
      return { state: UNKNOWN, contexts: [], unparsed: true };
    }
    if (absentOnError(stderr)) {
      return { state: ABSENT, contexts: [] };
    }
    if (UNREADABLE.test(stderr) || isExactReply(stderr, FREE_PLAN_403)) {
      return { state: UNKNOWN, contexts: [] };
    }
    throw ghApiFailure(args[0], { status, stderr, transient });
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
export function classifyRulesets(data) {
  // The paged read wraps every page in an outer array, so a complete read is an array
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

/** A runner whose calls also end when `signal` aborts, beside any signal the caller's runner already carries. */
export const withSignal =
  (gh, signal) =>
  (args, cwd, options = {}) =>
    gh(args, cwd, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    });

/**
 * A runner for one gate call: every `gh` call ends when `timeoutMs` expires or `signal` aborts, and
 * `timeoutMs` also bounds each child. `deadline` is the deadline signal alone, so a caller tells a
 * timeout from a caller cancel.
 * @param {Function} gh
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [signal]
 */
export function boundedCall(gh, timeoutMs, signal = null) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const call = withSignal(
    (args, cwd, options) => gh(args, cwd, { timeoutMs, ...options }),
    signal ? AbortSignal.any([deadline, signal]) : deadline,
  );
  call.deadline = deadline;
  return call;
}

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

// The exact `gh pr checks --required` reply on a branch with no required check, compared against
// the trimmed stderr of an exit 1 with no stdout.
export const NO_REQUIRED_CHECKS = /^no required checks reported on the '.+' branch$/;

// The exact `gh pr checks` reply on a PR head that no check has reported on yet, as right after a
// push. It is an empty list, not a read error, in the required and the all-checks read alike (#941,
// #950).
export const NO_CHECKS_YET = /^no checks reported on the '.+' branch$/;

/**
 * The required names of one `gh pr checks --required --json` reply. Any field list that includes
 * `name` serves, so the wait passes the reply of its own check-list read instead of a second one.
 *
 * `gh pr checks --required` resolves required check names without admin rights. It lists only
 * checks that already reported on the commit, exits non-zero for pending or failing checks, and
 * prints no JSON when no required check has reported, so the output is parsed leniently and an
 * unparseable reply contributes no names. This source carries no app qualifier, so every name it
 * yields is unqualified.
 *
 * `ok` is true only for a read that succeeded, whatever its stdout holds: exit 0 with a list of
 * named checks, exit 1 or 8 (a failing or pending check) with a non-empty list of named checks, or
 * the exact `no required checks reported` answer on exit 1 with no stdout. Any other exit, an empty
 * list on a non-zero exit, an error text that merely contains those words, and the `no checks
 * reported` reply (`NO_CHECKS_YET`) are a failed read. The gate ignores `ok`. The status read
 * refuses on it, because the list may name a required check no configuration source did (issue
 * #349). A reply that is no list carries `transient` and the `failure` text only for a clean
 * server-error failure, which the wait retries (#1121).
 * @returns {{ names: string[], ok: boolean, transient?: boolean, failure?: string }}
 */
export function requiredNamesOf({ status, stdout, stderr }) {
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
  // A clean server-error failure only: an unparseable reply is never retried (#1121).
  const transient = stdout.trim() === "" && isServerErrorText(stderr);
  return { names: [], ok: none, transient, failure: transient ? stderr.trim() : "" };
}

async function ghRequiredNames(gh, pr, cwd) {
  return requiredNamesOf(
    await gh(["pr", "checks", String(pr), "--required", "--json", "name"], cwd),
  );
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
//
// With `retryable`, the protection read is a status-classified `--include` read like the paged
// rules read, so a failed read of either source with a retryable status carries `transient`
// and a caller can retry it on its next poll (#1091). The default reads stay as the gate pins them.
//
// With `names`, the `requiredNamesOf` result of a reply the caller already holds, the names read is
// not repeated (#1125).
export async function requiredContexts(
  gh,
  slug,
  base,
  pr,
  cwd,
  { retryable = false, names = null } = {},
) {
  const contexts = new Map();
  const unknown = [];
  const unparsed = [];

  const [rules, protection, listed] = await inOrder(gh, [
    (read) =>
      readRequiredSource(
        // The endpoint paginates at 30 rules per page by default, so a single read can
        // stop before a required-status-check rule and report an absence for a branch
        // that requires one. Every page is fetched by page number, never by a reply-supplied
        // `Link` URL, and a body the gate cannot account for every page of is unknown or an
        // error (issue #336 review, #1033).
        pagedRead(read),
        [`repos/${slug}/rules/branches/${base}`],
        cwd,
        { absentOnError: () => false, classify: classifyRulesets },
      ),
    (read) =>
      readRequiredSource(
        retryable ? (args, readCwd) => readOne(read, args[1], readCwd) : read,
        [`repos/${slug}/branches/${base}/protection`],
        cwd,
        {
          absentOnError: (stderr) => isExactReply(stderr, NOT_PROTECTED_404),
          classify: classifyProtection,
          malformed: isProtectionMalformed,
        },
      ),
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
    // A failed names read that named a server error, and the error text. Only the wait retries it,
    // the gate ignores both.
    namesTransient: Boolean(listed.transient),
    namesFailure: listed.failure ?? "",
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
