// The general `gh` client runs `gh` and reads `gh api` endpoints. It judges every reply the way the
// CI gate, the check wait, and the source probe need (#1183). It holds no required-check logic.
import { execBounded } from "../exec.mjs";
import { isJsonObject, tryParseJson } from "../json.mjs";

/**
 * The default bound on a status read. The read sits in front of a child turn
 * that has its own much longer `--timeout`, so it needs its own bound. A `gh`
 * that hangs must not hold the dispatch open (#320).
 */
export const DEFAULT_READ_TIMEOUT_MS = 60_000;

// `gh` reads these two names and then writes a debug log to stderr, which breaks the exact stderr
// match of the protection read (#1047). Compared in upper case, because Windows names are case-blind.
// Every call also drops `GH_DEBUG` and `DEBUG` (#1047), and the rest of the environment stays.
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
 * Runs `gh` with `args` in `cwd`. Returns `{ status, stdout, stderr, timedOut }`, and a non-zero
 * exit is data, not a throw. `timeoutMs` bounds the call and terminates the `gh` child when it
 * expires, so a hung `gh` cannot outlast a caller bound. On POSIX the kill is `SIGTERM`, then
 * `SIGKILL` after `forceKillAfterDelay`, and on Windows it is `taskkill /T /F` over the process
 * tree. No platform keeps a child the bound has given up on (#329). `dropEnv` names variables that
 * this one call removes from the child environment, compared in upper case because Windows names
 * are case-blind.
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

/**
 * The text a failed `gh` call reports: its trimmed stderr, or its exit status when stderr is empty.
 * With `stdout` of a `gh api --include` read and an empty stderr, the text is `HTTP <status>` from the
 * first line of that stdout. That form names no exit status, and a first line that is no status line
 * gives `exit <status>, no HTTP status line` (#1242). Only that number is named, never body text,
 * which carries server-supplied text.
 */
export function ghFailureText({ status, stderr, stdout }) {
  const text = stderr.trim();
  if (text !== "" || stdout === undefined) {
    return text || `exit ${status}`;
  }
  const line = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(stdout);
  return line ? `HTTP ${line[1]}` : `exit ${status}, no HTTP status line`;
}

/**
 * Sets the `transient` tag on `err` for a retryable failure or a transport failure, and the
 * `transport` tag for a transport failure. Returns `err`, so a caller can throw the same object.
 */
function tagRetry(err, { transient, transport }) {
  if (transient || transport) {
    err.transient = true;
  }
  if (transport) {
    err.transport = true;
  }
  return err;
}

/**
 * The error of a failed `gh api` call on `endpoint`. It carries `transient` when the reply did, or
 * when the failure is a transport failure. A `terminal` result never becomes transport. Only a
 * result marked `include`, a failed `gh api --include` read, passes its stdout on for a status line
 * (#1246). The stdout of any other read is a reply body. A failed 5xx read names only its
 * first-line status and its body class (`bodyClassOf`), never server-supplied text or a body byte
 * (#1519).
 */
export function ghApiFailure(
  endpoint,
  { status, stdout, stderr, transient, include, terminal, bodyClass, replyStatus },
) {
  const serverError = replyStatus >= 500 && replyStatus <= 599;
  const text = serverError
    ? `HTTP ${replyStatus}`
    : ghFailureText({ status, stdout: include ? stdout : undefined, stderr });
  const classDetail = serverError && bodyClass !== undefined ? ` (body: ${bodyClass})` : "";
  const err = new Error(`gh api ${endpoint} failed: ${text}${classDetail}`);
  const transport = !terminal && isTransportFailure({ stdout, stderr });
  return tagRetry(err, { transient, transport });
}

// Cap of a `gh pr list` read. A reply of this size holds too many PRs to name one, so it is ambiguous.
export const PR_LIST_LIMIT = 100;

/** True for the fields every `gh pr list` reader needs: a positive number, a head, and a fork flag. */
export function isPrListEntry(entry) {
  return (
    isJsonObject(entry) &&
    Number.isSafeInteger(entry.number) &&
    entry.number > 0 &&
    typeof entry.headRefOid === "string" &&
    typeof entry.isCrossRepository === "boolean"
  );
}

/**
 * Reads and validates a `gh pr list` reply through `read`. Returns `{ list }`, or `{ failure }`
 * with the reason text that both readers report.
 * @param {(argv: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} read
 * @param {string[]} argv
 * @param {(entry: unknown) => boolean} isEntry
 * @returns {Promise<{ list: object[] } | { failure: string }>}
 */
export async function readPrList(read, argv, isEntry) {
  const reply = await read(argv);
  if (!reply || reply.status !== 0) {
    return {
      failure: `gh pr list failed: ${ghFailureText({
        status: reply?.status ?? "unknown",
        stderr: reply?.stderr ?? "",
      })}`,
    };
  }
  const list = JSON.parse(reply.stdout);
  if (!Array.isArray(list) || list.length >= PR_LIST_LIMIT || !list.every(isEntry)) {
    return { failure: "the gh pr list reply is not a list that names one PR" };
  }
  return { list };
}

/**
 * Reads the open same-repository pull requests of `branch` in `cwd`, through `readPrList`. A `repo`
 * slug pins the read to that repository, and null leaves it unpinned. A cross-repository entry is
 * dropped from `list`. A failed read returns `{ failure }` with the reason text of `readPrList`.
 * @param {{ branch: string, read: (argv: string[]) => Promise<object>, repo?: string | null,
 *   fields: string, isEntry: (entry: unknown) => boolean, limit?: number }} options
 * @returns {Promise<{ list: object[] } | { failure: string }>}
 */
export async function readOpenBranchPrs({
  branch,
  read,
  repo = null,
  fields,
  isEntry,
  limit = PR_LIST_LIMIT,
}) {
  const argv = [
    "pr",
    "list",
    ...(repo === null ? [] : ["--repo", repo]),
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    fields,
    "--limit",
    String(limit),
  ];
  const result = await readPrList(read, argv, isEntry);
  if (result.failure) return { failure: result.failure };
  return { list: result.list.filter((entry) => !entry.isCrossRepository) };
}

// The words that the network stack of `gh` writes for a transport failure, which carries no server
// reply and so no HTTP status (#1312).
const TRANSPORT_FAILURES = [
  /\bdial tcp\b/i,
  /\bconnection refused\b/i,
  /\bconnection reset by peer\b/i,
  /\bconnection timed out\b/i,
  /\bi\/o timeout\b/i,
  /\btls handshake timeout\b/i,
  /\bnetwork is unreachable\b/i,
  /\bno route to host\b/i,
  /\bno such host\b/i,
  /\bserver misbehaving\b/i,
  /\btemporary failure in name resolution\b/i,
  /\bproxyconnect tcp\b/i,
  /\bunexpected EOF\b/i,
  // A bare EOF counts only in the shape the Go HTTP client writes, a quoted URL then `: EOF` at the
  // end. A body or message that holds EOF elsewhere never matches (#1312).
  /"[^"]*": EOF$/,
  /\bbroken pipe\b/i,
  /\bhttp2: client connection lost\b/i,
];

// An HTTP status in the form of `gh`, or the first line that `gh api --include` writes.
const HTTP_STATUS_TEXT = /\bHTTP(?:\/\d(?:\.\d)?)?\s+\d{3}\b/i;

/**
 * Whether a failed read is a transport failure. Such a read names a known transport failure, names
 * no HTTP status, and wrote no reply body. A status line decides first, so a 4xx or 5xx reply whose
 * body or error text also holds transport wording stays as it was (#1312). Text that the server
 * supplies arrives in the body, which is never scanned.
 */
export function isTransportFailure({ stdout, stderr }) {
  const text = stderr.trim();
  return (
    stdout.trim() === "" &&
    !HTTP_STATUS_TEXT.test(text) &&
    TRANSPORT_FAILURES.some((pattern) => pattern.test(text))
  );
}

/**
 * Runs `gh api` with `args` (the `"api"` word is added here) and parses stdout as JSON.
 * @returns {Promise<unknown>} the parsed body, or null when stdout is empty
 * @throws {Error} on a non-zero exit, with `transient` set when the reply was a retryable failure
 *   stdout that is not JSON throws a raw `SyntaxError`
 */
export async function ghApi(gh, args, cwd) {
  const result = await gh(["api", ...args], cwd);
  if (result.status !== 0) {
    throw ghApiFailure(args[0], result);
  }
  const text = result.stdout.trim();
  return text === "" ? null : JSON.parse(text);
}

// The reply statuses of a failed paged read that the wait retries on the next poll (#1025). The
// status is the one on the first line of the stdout that `gh api --include` wrote for that one
// request, never a number in the error text of `gh`, which carries server-supplied text.
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

// The body classes of a retryable status that the wait retries. A cut-short JSON value is a
// GitHub-shaped reply that a transient failure truncated, and the body never decides the status
// (#1519). A complete value followed by text, and other text, stay terminal: their bytes cannot be
// told apart from forged text (#1025).
const RETRYABLE_BODY_CLASSES = new Set(["empty", "JSON", "truncated JSON"]);

/**
 * Whether the stderr of a failed `gh pr` read names a retryable server error.
 * `gh` words it `HTTP <status>: <message> (<url>)`, and the status opens the text, so only that
 * opening counts. A status in later text or inside a 4xx message never makes a retry (#1121).
 */
function isServerErrorText(stderr) {
  const status = /^HTTP (\d{3})\b/.exec(stderr.trimStart());
  return status !== null && RETRYABLE_STATUSES.has(Number(status[1]));
}

/**
 * Whether a failed `gh pr` read is a clean server-error failure: no stdout and a retryable status
 * opening stderr. An unparseable reply is never one (#1121).
 */
export const isCleanServerError = ({ stdout, stderr }) =>
  stdout.trim() === "" && isServerErrorText(stderr);

/**
 * The error of a failed `gh pr` read named `label`. It carries `transient` for a clean server error
 * or a transport failure, so the wait retries the read on its next poll (#1121, #1312). Every other
 * failure ends the wait.
 */
export function ghReadError(label, result) {
  const { status, stderr } = result;
  const err = new Error(`${label} could not be read: ${ghFailureText({ status, stderr })}`);
  const transport = isTransportFailure(result);
  return tagRetry(err, { transient: isCleanServerError(result), transport });
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
 * The host that `gh api` sends a request to when `GH_HOST` is unset, or null when the reply states
 * none. It comes from the parsed stdout of `gh auth status --json hosts`, run without `TOKEN_NAMES`.
 * Observed with `gh` 2.103.1: the default host is the one host of the configuration, and github.com
 * for none or several. That listing then holds the configured hosts only. A reply that is not
 * the documented shape states no host, so it never widens the accepted hosts.
 * @param {unknown} reply
 */
function defaultHost(reply) {
  const hosts = reply?.hosts;
  if (!isJsonObject(hosts)) {
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
    const reply = tryParseJson(stdout);
    // An unreadable reply states no host.
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

/**
 * The class of a reply body: `empty`, `JSON`, `truncated JSON`, `unparseable JSON`, or `other text`.
 * A truncated body opens one JSON object or array whose closing bracket is missing.
 * A cut reply is then told from a complete value followed by text. Only the class is reported,
 * never a body byte (#1519).
 */
export function bodyClassOf(body) {
  const text = body.trim();
  if (text === "") {
    return "empty";
  }
  if (isEmptyOrJson(text)) {
    return "JSON";
  }
  if (!/^[{[]/.test(text)) {
    return "other text";
  }
  return openJsonValue(text) ? "truncated JSON" : "unparseable JSON";
}

/**
 * Whether the first JSON value of `text` is still open at the end. The scan tracks braces,
 * brackets, and strings, so a bracket inside a string never closes the value.
 */
function openJsonValue(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return false;
      }
    }
  }
  return depth > 0 || inString;
}

/** A refusal about the shape of a reply: a read the runtime cannot account for, as no `gh` failure. */
const refusal = (stderr) => ({ status: 1, stdout: "", stderr, unreadable: true });
// A refusal carries `unreadable`, so the ruleset source reads as unknown and the gate reads throw.
// A foreign `Link` target is no `unreadable` refusal, so every read throws on it.

/**
 * One `gh api --include` request, judged as the pager judges every page, in the one place that
 * judges it. The `Link` header of every reply is judged before its status, so a status-retryable
 * failure is still terminal on a foreign target. The request host is resolved once per read
 * (`state.hosts`), and only for a reply that carries a `Link` target. A failure or refusal returns
 * `{ end, reply }`, where `end` is the `gh`-shaped result and `reply` is the parsed reply. `reply` is
 * null with no status block, and a 2xx reply with one JSON value returns `{ reply, json }`.
 * @param {Function} read
 * @param {string[]} args the `gh` arguments of the request
 * @param {string} cwd
 * @param {{ hosts?: Set<string> }} state
 */
async function readReply(read, args, cwd, state) {
  // A single read and a paged read share this judgment, so they cannot drift apart.
  const result = await read(args, cwd);
  const reply = parseReply(result.stdout);
  // Both forms carry `targets`, so a caller does not parse the headers again.
  const targets = reply === null ? [] : linkTargets(reply.headers);
  if (targets.length > 0) {
    state.hosts ??= await requestHosts(read, cwd);
  }
  const foreign = targets.length > 0 ? foreignTarget(targets, state.hosts) : null;
  if (foreign !== null) {
    // A foreign target is an error on a failed reply too, and it is never `transient`.
    // The read never requests that target, and it ends instead of returning steered pages.
    return {
      reply,
      targets,
      end: {
        status: 1,
        stdout: "",
        stderr: `a Link header names a host other than the request host: ${foreign}`,
        // A refused target is terminal, whatever its text, so the transport retry never applies.
        terminal: true,
      },
    };
  }
  if (result.status !== 0) {
    // A reply with no status block is a failure that wrote no reply, so a transport failure is its
    // only retryable form (#1312). A reply with a status block keeps the 5xx rule.
    const transport = reply === null && isTransportFailure(result);
    const bodyClass = reply === null ? null : bodyClassOf(reply.body);
    // `transient` is set for a first-line status of 500, 502, 503, or 504 with an empty, JSON,
    // or truncated JSON body (#1519). A transport failure with no status block is transient too.
    const transient =
      reply === null
        ? transport
        : RETRYABLE_STATUSES.has(reply.status) && RETRYABLE_BODY_CLASSES.has(bodyClass);
    return {
      reply,
      targets,
      end: {
        ...result,
        include: true,
        ...(reply === null ? {} : { bodyClass, replyStatus: reply.status }),
        ...(transient ? { transient: true } : {}),
        ...(transport ? { transport: true } : {}),
      },
    };
  }
  if (reply === null || reply.status < 200 || reply.status > 299) {
    return { reply, targets, end: refusal("the reply carries no 2xx HTTP status block") };
  }
  try {
    return { reply, targets, json: JSON.parse(reply.body) };
  } catch {
    return { reply, targets, end: refusal("the reply body is not exactly one JSON value") };
  }
}

/**
 * Reads every page of the list endpoint `endpoint`, with one `gh api --include` request per
 * documented page number. The result is `gh`-shaped, and its stdout holds the pages as one JSON
 * array. `field` names the list in an object reply (`check_runs`, `statuses`), and with `null` each
 * page is the list itself. A `total_count` reply ends only at the collected count, and a short or
 * empty page with the count unmet is an error. A foreign `Link` target is an error, never
 * `transient`, and a shape refusal carries `unreadable`.
 * @param {Function} read one `gh` read, as `(args, cwd) => result`
 * @param {string} endpoint
 * @param {string} cwd
 * @param {string | null} field
 */
async function readPages(read, endpoint, cwd, field) {
  // `endpoint` carries no query.
  // Each request uses the documented page number, never the `Link` header, so no request goes to
  // a target that a reply named. An empty page is kept, so a classifier sees the whole sequence.
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
      // A count that changes between pages is an error.
      return refusal("the total_count of the reply changed between pages");
    }
    const done = () => ({ status: 0, stdout: JSON.stringify(pages), stderr: "" });
    // Every page that arrived is kept, so a classifier sees the whole sequence.
    pages.push(json);
    collected += items;
    if (total === null) {
      // No count to check against: the first short page ends the read.
      if (items < PAGE_SIZE) {
        return done();
      }
    } else if (collected > total) {
      // A collected count above the total is an error.
      return refusal("the pages hold more items than the total_count of the reply");
    } else if (collected === total) {
      return done();
    } else if (items < PAGE_SIZE) {
      // A short page proves nothing while the count is unmet, so the read is an error.
      return refusal("the read ended before the total_count of the reply");
    }
  }
  // The page cap is an error.
  return refusal(`the read has more than ${MAX_PAGES} pages`);
}

/**
 * A `gh` runner whose `api <endpoint>` call reads every page of `endpoint` through `readPages`.
 * A caller of `ghApi` or `readRequiredSource` then never uses `gh --paginate` (#1033).
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
 * Reads one endpoint that is no list with `gh api --include`.
 * It applies the pager's one validation (`readReply`): the `Link` host check of every reply (#1033)
 * and a body of one JSON value. A success returns a `gh`-shaped result whose stdout is the reply
 * body. A `Link` target of the request host on a success is a refusal, because the reply is one
 * page of a longer list. `notFound` is set on a failed result only for the exact absence reply.
 * @param {Function} read one `gh` read, as `(args, cwd) => result`
 * @param {string} endpoint
 * @param {string} cwd
 */
export async function readOne(read, endpoint, cwd) {
  // `transient` is set as the pager sets it (#1025, #1519), and `endpoint` carries its query.
  // That validation also checks the first-line status and the 2xx status block (#1025, #1519).
  // A success that names a longer list is a refusal, so this read never takes one page as complete.
  const { reply, end, targets } = await readReply(read, ["api", endpoint, "--include"], cwd, {});
  if (end) {
    // The exact absence reply: a 404 line, `gh: Not Found (HTTP 404)`, one JSON body, and no `Link` target.
    const exact =
      end.status !== 0 &&
      reply?.status === 404 &&
      end.stderr.trim() === "gh: Not Found (HTTP 404)" &&
      targets.length === 0 &&
      reply.body.trim() !== "" &&
      isEmptyOrJson(reply.body);
    return { ...end, ...(exact ? { notFound: true } : {}) };
  }
  if (targets.length > 0) {
    // A refusal about the shape of a reply carries `unreadable`.
    // The 5xx retry classification of a failed reply is the pager's too (#1025, #1519).
    return refusal("the reply carries a Link header, so it may be one page of a longer list");
  }
  return { status: 0, stdout: reply.body, stderr: "" };
}

/** A runner whose calls also end when `signal` aborts, beside any signal the caller's runner already carries. */
export const withSignal =
  (gh, signal) =>
  (args, cwd, options = {}) =>
    gh(args, cwd, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    });

/** The error of a read that reached its deadline. `timedOut` tells it from a cancel and from another read error. */
export const readTimeout = (timeoutMs) =>
  Object.assign(new Error(`the read timed out after ${timeoutMs}ms`), { timedOut: true });

/**
 * A runner for one gate call: every `gh` call ends when `timeoutMs` expires or `signal` aborts, and
 * `timeoutMs` also bounds each child. `deadline` is the deadline signal alone, so a caller tells a
 * timeout from a caller cancel. A reply that the runner marks `timedOut`, or that arrives after the
 * deadline expired, throws `readTimeout` and never reaches the caller as data. A gate then cannot
 * pass on a read that its bound cut short.
 * @param {Function} gh
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [signal]
 */
export function boundedCall(gh, timeoutMs, signal = null) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = withSignal(
    (args, cwd, options) => gh(args, cwd, { timeoutMs, ...options }),
    signal ? AbortSignal.any([deadline, signal]) : deadline,
  );
  const call = async (args, cwd, options) => {
    const reply = await bounded(args, cwd, options);
    if (reply?.timedOut || deadline.aborted) {
      throw readTimeout(timeoutMs);
    }
    return reply;
  };
  call.deadline = deadline;
  return call;
}

/**
 * A runner for one long command, such as a batch run. Every call ends when its bound expires or
 * a signal aborts. A caller bound wins over the default, and a caller signal joins the run signal.
 * A reply that ends after an abort throws and reaches the caller as no data. The first abort
 * source decides between a cancel and a timeout.
 * @param {Function} gh
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [signal]
 */
export function boundedRunner(gh, timeoutMs, signal = null) {
  return async (args, cwd, options = {}) => {
    const bound = options.timeoutMs ?? timeoutMs;
    const deadline = AbortSignal.timeout(bound);
    const signals = [options.signal, signal, deadline].filter(Boolean);
    const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let canceled = false;
    let cancelReason;
    combined.addEventListener(
      "abort",
      () => {
        if (deadline.aborted) return;
        canceled = true;
        cancelReason = combined.reason;
      },
      { once: true },
    );
    if (deadline.aborted) throw readTimeout(bound);
    if (combined.aborted) {
      canceled = true;
      cancelReason = combined.reason;
    }
    if (canceled) throw canceledCall(cancelReason);
    const reply = await gh(args, cwd, { ...options, timeoutMs: bound, signal: combined });
    if (canceled) throw canceledCall(cancelReason);
    if (reply?.timedOut || deadline.aborted) throw readTimeout(bound);
    return reply;
  };
}

/** The error of a call that ended after a caller signal aborted, with that reason as `cause`. */
function canceledCall(reason) {
  return Object.assign(new Error("the call was canceled"), { name: "AbortError", cause: reason });
}

/**
 * The first failure of a group, in sequential order, carried past the wait for
 * the cancelled siblings. `expired` is whether the caller's deadline (`gh.deadline`)
 * had already fired when the failure was captured. A failure captured before the
 * deadline stays the outcome, so a deadline that expires during the wait cannot
 * replace it. The entry points unwrap it with `failureOf`.
 */
export class ReadFailure {
  constructor(cause, expired) {
    this.cause = cause;
    this.expired = expired;
  }
}

export const failureOf = (err) => (err instanceof ReadFailure ? err.cause : err);

/**
 * Runs independent reads together, and each maker receives a runner that the group can cancel.
 * The reads are awaited in list order, so the first failure throws as soon as it is reached, with
 * the error a sequential run surfaces. A later sibling that is slow or stalled never delays that
 * error. On a failure the remaining reads are cancelled and settled before the throw, so no `gh`
 * child outlives the caller. `stopWhen(value)` ends the group early, as a sequential caller that
 * returns at that value does, and the later reads are then cancelled and settled.
 */
export async function inOrder(gh, makers, stopWhen = () => false) {
  const group = new AbortController();
  const scoped = withSignal(gh, group.signal);
  const reads = makers.map((make) => make(scoped));
  for (const read of reads) {
    read.catch(() => {});
  }
  try {
    const values = [];
    for (const read of reads) {
      const value = await read;
      values.push(value);
      if (stopWhen(value)) {
        group.abort();
        await Promise.allSettled(reads);
        // Their failures are never surfaced, and the values read so far are returned.
        break;
      }
    }
    return values;
  } catch (err) {
    const expired = gh.deadline?.aborted ?? false;
    group.abort();
    await Promise.allSettled(reads);
    throw new ReadFailure(err, expired);
  }
}
