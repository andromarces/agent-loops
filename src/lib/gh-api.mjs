// The general `gh` client: runs `gh`, reads `gh api` endpoints, and judges every reply the way the
// CI gate, the check wait, and the source probe need (#1183). It holds no required-check logic.
import { execBounded } from "./exec.mjs";
import { isJsonObject } from "./json.mjs";

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

/**
 * The text a failed `gh` call reports: its trimmed stderr, or its exit status when stderr is empty.
 * With `stdout` of a `gh api --include` read and an empty stderr, the text is `HTTP <status>` from the
 * first line of that stdout, with no exit status, or `exit <status>, no HTTP status line` when that
 * line is no status line (#1242). Only that number is named, never body text, which carries
 * server-supplied text.
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
 * The error of a failed `gh api` call on `endpoint`. It carries `transient` when the reply did. Only
 * a result marked `include`, a failed `gh api --include` read, passes its stdout on for a status
 * line (#1246): the stdout of any other read is a reply body.
 */
export function ghApiFailure(endpoint, { status, stdout, stderr, transient, include }) {
  const text = ghFailureText({ status, stdout: include ? stdout : undefined, stderr });
  const err = new Error(`gh api ${endpoint} failed: ${text}`);
  if (transient) {
    err.transient = true;
  }
  return err;
}

/**
 * Runs `gh api` with `args` (the `"api"` word is added here) and parses stdout as JSON.
 * @returns {Promise<unknown>} the parsed body, or null when stdout is empty
 * @throws {Error} on a non-zero exit, with `transient` set when the reply was a retryable failure;
 *   stdout that is not JSON throws a raw `SyntaxError`
 */
export async function ghApi(gh, args, cwd) {
  const { status, stdout, stderr, transient, include } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    throw ghApiFailure(args[0], {
      status,
      stdout,
      stderr,
      transient,
      include: include || args.includes("--include"),
    });
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

/**
 * Whether a failed `gh pr` read is a clean server-error failure: no stdout and a retryable status
 * opening stderr. An unparseable reply is never one (#1121).
 */
export const isCleanServerError = ({ stdout, stderr }) =>
  stdout.trim() === "" && isServerErrorText(stderr);

/**
 * The error of a failed `gh pr` read named `label`. It carries `transient` for a clean server error,
 * so the wait retries the read on its next poll (#1121). Every other failure ends the wait.
 */
export function ghReadError(label, result) {
  const { status, stderr } = result;
  const err = new Error(`${label} could not be read: ${ghFailureText({ status, stderr })}`);
  if (isCleanServerError(result)) {
    err.transient = true;
  }
  return err;
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
 * and `{ reply, json }` for a 2xx reply whose body is exactly one JSON value. Both carry `targets`, the
 * `Link` targets of the reply, so a caller does not parse the headers again.
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
      targets,
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
    return {
      reply,
      targets,
      end: { ...result, include: true, ...(transient ? { transient: true } : {}) },
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
  const { reply, end, targets } = await readReply(read, ["api", endpoint, "--include"], cwd, {});
  if (end) {
    const exact =
      end.status !== 0 &&
      reply?.status === 404 &&
      end.stderr.trim() === "gh: Not Found (HTTP 404)" &&
      targets.length === 0 &&
      isJsonBody(reply.body);
    return { ...end, ...(exact ? { notFound: true } : {}) };
  }
  if (targets.length > 0) {
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
 * deadline expired, throws `readTimeout` and never reaches the caller as data, so a gate cannot pass
 * on a read that its bound cut short.
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
// `gh` child outlives the caller. `stopWhen(value)` ends the group early, as a
// sequential caller that returns at that value would: the later reads are
// cancelled and settled, their failures are never surfaced, and the values read
// so far are returned.
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
