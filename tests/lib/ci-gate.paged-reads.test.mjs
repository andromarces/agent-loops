// Requirement (#1033): the gate reads and the ruleset read page by documented page number, one
// `gh api` request per page, and never follow a reply-supplied `Link` URL. A `Link` target on a host
// other than the request host ends the read with an error, and a read that the runtime cannot account
// for page by page is an error or an unknown source, never a pass.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { checkRuns, commitStatuses } from "../../src/lib/ci-gate.mjs";
import {
  ABSENT,
  UNKNOWN,
  failureOf,
  requiredContexts,
} from "../../src/lib/ci-required-sources.mjs";
import { readOne } from "../../src/lib/gh-api.mjs";
import { SLUG } from "./ci-gate-helpers.mjs";

const SHA = "1111111111111111111111111111111111111111";
const LINK = 'Link: <https://other.example/repos/x/y/check-runs?page=2>; rel="next"\r\n';
const SAME_HOST_LINK =
  'Link: <https://api.github.com/repositories/1/commits/x/check-runs?per_page=100&page=2>; rel="next"\r\n';

// The request host comes from `GH_HOST`, so each test pins it to the default.
let savedHost;
beforeEach(() => {
  savedHost = process.env.GH_HOST;
  delete process.env.GH_HOST;
});
afterEach(() => {
  if (savedHost === undefined) {
    delete process.env.GH_HOST;
  } else {
    process.env.GH_HOST = savedHost;
  }
});

/** One `gh api --include` stdout: the status block of one request, then one JSON body. */
const reply = (body, { status = 200, headers = "" } = {}) => ({
  status: 0,
  stdout: `HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(body)}`,
  stderr: "",
});

/**
 * The `gh auth status --json hosts` reply for the listed hosts. A host is a name, whose login is read
 * from the configuration file, or `[name, tokenSource]`, as `gh` reports the source of a login.
 */
const authHosts = (...hosts) => ({
  status: 0,
  stdout: JSON.stringify({
    hosts: Object.fromEntries(
      hosts.map((spec) => {
        const [host, tokenSource = "hosts.yml"] = [spec].flat();
        return [host, [{ host, tokenSource }]];
      }),
    ),
  }),
  stderr: "",
});

/**
 * A `gh` double that serves `pages` by endpoint and records every `api` call as joined text. `auth`
 * is its `gh auth status --json hosts` reply, by default the one github.com login, or a function of the
 * options of that call.
 */
function serve(pages, auth = authHosts("github.com")) {
  const calls = [];
  const gh = async (args, _cwd, options) => {
    if (args[0] === "auth") {
      return typeof auth === "function" ? auth(options) : auth;
    }
    calls.push(args.join(" "));
    const served = args[0] === "api" ? pages[args[1]] : undefined;
    return (
      served ?? { status: 1, stdout: "", stderr: `unmatched gh call: ${JSON.stringify(args)}` }
    );
  };
  return { gh, calls };
}

const runs = (count, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: from + i + 1,
    name: `run ${from + i}`,
    status: "completed",
    conclusion: "success",
    started_at: "2026-01-01T00:00:00Z",
  }));
const statuses = (count, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: from + i + 1,
    context: `status ${from + i}`,
    state: "success",
    updated_at: "2026-01-01T00:00:00Z",
  }));

const RUNS = `repos/${SLUG}/commits/${SHA}/check-runs`;
const STATUS = `repos/${SLUG}/commits/${SHA}/status`;
const RULES = `repos/${SLUG}/rules/branches/main`;
const page = (endpoint, n) => `${endpoint}?per_page=100&page=${n}`;

// Every request names the endpoint of the read and a page number, and none is a native paginated one.
function expectBoundedCalls(calls, endpoint, pageCount) {
  assert.equal(calls.length, pageCount, calls.join("\n"));
  calls.forEach((call, i) => {
    assert.equal(call, `api ${page(endpoint, i + 1)} --include`);
    assert.ok(!call.includes("--paginate"), call);
  });
}

describe("gate reads and the ruleset read page by page number", () => {
  // Verifies the page-number paging of the check-run read, so no read depends on `--paginate`.
  it("reads every page of the check runs with one request per page", async () => {
    const { gh, calls } = serve({
      [page(RUNS, 1)]: reply({ total_count: 150, check_runs: runs(100) }),
      [page(RUNS, 2)]: reply({ total_count: 150, check_runs: runs(50, 100) }),
    });
    const read = await checkRuns(gh, SLUG, SHA, ".", true);
    assert.equal(read.length, 150);
    expectBoundedCalls(calls, RUNS, 2);
  });

  // Verifies the same paging for the commit status read, which has no other covering test.
  it("reads every page of the commit statuses with one request per page", async () => {
    const { gh, calls } = serve({
      [page(STATUS, 1)]: reply({ total_count: 101, statuses: statuses(100) }),
      [page(STATUS, 2)]: reply({ total_count: 101, statuses: statuses(1, 100) }),
    });
    const read = await commitStatuses(gh, SLUG, SHA, ".", true);
    assert.equal(read.length, 101);
    expectBoundedCalls(calls, STATUS, 2);
  });

  // Verifies that a `Link` URL on the request host is never requested either: the runtime sends no
  // request that the reply named.
  it("never requests the target that a same-host Link header names", async () => {
    const { gh, calls } = serve({
      [page(RUNS, 1)]: reply({ total_count: 1, check_runs: runs(1) }, { headers: SAME_HOST_LINK }),
    });
    const read = await checkRuns(gh, SLUG, SHA, ".", true);
    assert.equal(read.length, 1);
    expectBoundedCalls(calls, RUNS, 1);
  });

  // Verifies acceptance item 2: a `Link` target on a host other than the request host ends the read
  // with an error, never a pass, and the target is never requested.
  it.each([
    ["a next link", LINK],
    ["a lower-case header name", LINK.replace("Link:", "link:")],
    [
      "a last link beside a same-host next link",
      `${SAME_HOST_LINK}Link: <https://other.example/x?page=9>; rel="last"\r\n`,
    ],
    [
      "one header that lists both hosts",
      'Link: <https://api.github.com/x?page=2>; rel="next", <https://other.example/x?page=9>; rel="last"\r\n',
    ],
    [
      "a host that only starts like the request host",
      'Link: <https://api.github.com.evil.example/x>; rel="next"\r\n',
    ],
    ["a link that is not a URL", 'Link: <http://>; rel="next"\r\n'],
  ])("ends the check-run read in an error for %s on another host", async (_name, headers) => {
    const { gh, calls } = serve({
      [page(RUNS, 1)]: reply({ total_count: 1, check_runs: runs(1) }, { headers }),
    });
    await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
    expectBoundedCalls(calls, RUNS, 1);
  });

  it("ends the commit-status read in an error for a Link header on another host", async () => {
    const { gh } = serve({
      [page(STATUS, 1)]: reply({ total_count: 1, statuses: statuses(1) }, { headers: LINK }),
    });
    await expect(commitStatuses(gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
  });

  // Verifies a retryable 5xx reply is judged by its Link header first: a target on another host is a
  // terminal error that is never marked transient, and the same reply with a same-host target stays
  // retryable.
  const failure503 = (headers) => ({
    status: 1,
    stdout: `HTTP/2.0 503 Service Unavailable
${headers}
{}`,
    stderr: "gh: HTTP 503",
  });

  it.each([
    ["check-run", RUNS, (gh) => checkRuns(gh, SLUG, SHA, ".", true)],
    ["commit-status", STATUS, (gh) => commitStatuses(gh, SLUG, SHA, ".", true)],
  ])(
    "ends the %s read in a terminal error for a 503 with a Link on another host",
    async (_name, endpoint, read) => {
      const { gh, calls } = serve({ [page(endpoint, 1)]: failure503(LINK) });
      const err = await read(gh).catch((error) => error);
      assert.match(err.message, /Link/);
      assert.ok(!err.transient, "a foreign Link is never retryable");
      expectBoundedCalls(calls, endpoint, 1);
    },
  );

  it("keeps a 503 with a same-host Link retryable", async () => {
    const { gh } = serve({ [page(RUNS, 1)]: failure503(SAME_HOST_LINK) });
    const err = await checkRuns(gh, SLUG, SHA, ".", true).catch((error) => error);
    assert.equal(err.transient, true);
  });

  // Verifies #1242: a failed `--include` read whose stderr is empty names the first-line status of its
  // stdout, never the body text, so the parent can tell a 4xx, a terminal 5xx, and a retryable one apart.
  const silent = (stdout) => ({ status: 1, stdout, stderr: "" });
  const SECRET = "server-supplied-text";

  it.each([
    ["check-run", RUNS, (gh) => checkRuns(gh, SLUG, SHA, ".", true)],
    ["commit-status", STATUS, (gh) => commitStatuses(gh, SLUG, SHA, ".", true)],
  ])("names the status of a failed %s read with empty stderr", async (_name, endpoint, read) => {
    const { gh } = serve({
      [page(endpoint, 1)]: silent(`HTTP/2.0 403 Forbidden\r\n\r\n{"message":"${SECRET}"}`),
    });
    const err = await read(gh).catch((error) => error);
    assert.match(err.message, /failed: HTTP 403$/);
    assert.ok(!err.transient);
  });

  it("names a terminal 5xx status and keeps its body out of the error", async () => {
    const { gh } = serve({
      [page(RUNS, 1)]: silent(`HTTP/2.0 502 Bad Gateway\r\n\r\n<html>${SECRET}</html>`),
    });
    const err = await checkRuns(gh, SLUG, SHA, ".", true).catch((error) => error);
    assert.match(err.message, /failed: HTTP 502$/);
    assert.ok(!err.transient, "a 5xx with a body that is not JSON stays terminal (#1025)");
  });

  it("keeps a retryable 503 transient and names its status", async () => {
    const { gh } = serve({ [page(RUNS, 1)]: silent("HTTP/2.0 503 Service Unavailable\r\n\r\n{}") });
    const err = await checkRuns(gh, SLUG, SHA, ".", true).catch((error) => error);
    assert.match(err.message, /failed: HTTP 503$/);
    assert.equal(err.transient, true);
  });

  it("says that a failed read with empty stderr and no status line has none", async () => {
    const { gh } = serve({ [page(RUNS, 1)]: silent(SECRET) });
    const err = await checkRuns(gh, SLUG, SHA, ".", true).catch((error) => error);
    assert.match(err.message, /failed: exit 1, no HTTP status line$/);
    assert.ok(!err.message.includes(SECRET));
  });

  it("names the status of a failed ruleset read with empty stderr", async () => {
    const gh = source([], {
      [page(RULES, 1)]: silent(`HTTP/2.0 500 Internal Server Error\r\n\r\n<b>${SECRET}</b>`),
    });
    const err = await requiredContexts(gh, SLUG, "main", 42, ".").catch((error) =>
      failureOf(error),
    );
    assert.match(err.message, /HTTP 500$/);
    assert.ok(!err.message.includes(SECRET));
  });

  // Verifies #1246: a read without `--include` writes the reply body to stdout, so a body that opens
  // with a status line is no status. The default protection read reports its exit status only.
  const PROTECTION_ENDPOINT = `repos/${SLUG}/branches/main/protection`;
  const protectionRead = (protection, options) => {
    const { gh } = serve({ [page(RULES, 1)]: reply([]), [PROTECTION_ENDPOINT]: protection });
    return requiredContexts(gh, SLUG, "main", 42, ".", options).catch((error) => failureOf(error));
  };

  it("reports the exit status of a failed read without --include whose body opens with a status line", async () => {
    const err = await protectionRead(silent(`HTTP/1.1 403 Forbidden\r\n\r\n{"x":"${SECRET}"}`));
    assert.match(err.message, /failed: exit 1$/);
    assert.ok(!err.message.includes("403"));
  });

  it("still names the status of a failed --include protection read", async () => {
    const err = await protectionRead(silent(`HTTP/2.0 403 Forbidden\r\n\r\n{}`), {
      retryable: true,
    });
    assert.match(err.message, /failed: HTTP 403$/);
  });

  it("ends the ruleset read in an error for a 503 with a Link on another host", async () => {
    const gh = source([], { [page(RULES, 1)]: failure503(LINK) });
    await expect(
      requiredContexts(gh, SLUG, "main", 42, ".").catch((err) => {
        throw failureOf(err);
      }),
    ).rejects.toThrow(/Link/);
  });

  // Verifies the host comes from `GH_HOST`, so an enterprise host is not refused for naming itself.
  it("accepts a Link header that names the GH_HOST host", async () => {
    process.env.GH_HOST = "ghe.example.com";
    const { gh } = serve({
      [page(RUNS, 1)]: reply(
        { total_count: 1, check_runs: runs(1) },
        { headers: 'Link: <https://ghe.example.com/api/v3/x?page=2>; rel="next"\r\n' },
      ),
    });
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  // Verifies acceptance item 1 (#1046): with no `GH_HOST`, the host `gh` sends the request to is the
  // one host of its configuration, and a Link header that names it is accepted.
  const GHE_LINK = 'Link: <https://ghe.example.com/api/v3/x?page=2>; rel="next"\r\n';
  const gheRuns = (auth, headers = GHE_LINK) =>
    serve({ [page(RUNS, 1)]: reply({ total_count: 1, check_runs: runs(1) }, { headers }) }, auth);

  it("accepts a Link header that names the only host in the gh configuration", async () => {
    const { gh } = gheRuns(authHosts("ghe.example.com"));
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  // Verifies acceptance item 2 (#1046): any other host still ends the read with an error.
  it("ends the read in an error for a Link header on a host other than the gh default", async () => {
    const { gh } = gheRuns(authHosts("ghe.example.com"), LINK);
    await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
  });

  // Verifies that `gh` falls back to github.com when several hosts are configured, so the
  // configured enterprise host is not accepted then.
  it("reads github.com as the request host when several hosts are configured", async () => {
    const hosts = authHosts("ghe.example.com", "ghe2.example.com");
    await expect(checkRuns(gheRuns(hosts).gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
    const { gh } = gheRuns(hosts, SAME_HOST_LINK);
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  // Verifies #1046 acceptance item 1 with a token in the environment: `gh auth status` lists github.com
  // for `GH_TOKEN` or `GITHUB_TOKEN` beside the configured hosts, so the lookup runs with both
  // variables dropped, and the one configured host is then the host `gh` uses. The double answers
  // as `gh` does: github.com is listed unless both variables are dropped.
  const TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"];
  const withToken =
    (...configured) =>
    (options) =>
      TOKEN_NAMES.every((name) => options?.dropEnv?.includes(name))
        ? authHosts(...configured)
        : authHosts(...configured, ["github.com", "GH_TOKEN"]);

  it("accepts the Link header of the one configured host when a token is in the environment", async () => {
    const { gh } = gheRuns(withToken("ghe.example.com"));
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  it("refuses github.com when one host is configured and a token is in the environment", async () => {
    const { gh } = gheRuns(withToken("ghe.example.com"), SAME_HOST_LINK);
    await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
  });

  it("reads github.com as the request host when two hosts are configured and a token is set", async () => {
    const hosts = withToken("ghe.example.com", "ghe2.example.com");
    await expect(checkRuns(gheRuns(hosts).gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
    const { gh } = gheRuns(hosts, SAME_HOST_LINK);
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  it("reads github.com as the request host when only a token is set", async () => {
    const { gh } = gheRuns(withToken(), SAME_HOST_LINK);
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  // Verifies the lookup is the only call that drops variables, so a page read keeps its token.
  it("drops no variable from a page read", async () => {
    const seen = [];
    const gh = async (args, cwd, options) => {
      seen.push(options?.dropEnv);
      return serve({
        [page(RUNS, 1)]: reply({ total_count: 1, check_runs: runs(1) }),
      }).gh(args, cwd, options);
    };
    await checkRuns(gh, SLUG, SHA, ".", true);
    assert.deepEqual(seen, [undefined]);
  });

  it("accepts the one enterprise host when its own login comes from GH_ENTERPRISE_TOKEN", async () => {
    const { gh } = gheRuns(authHosts(["ghe.example.com", "GH_ENTERPRISE_TOKEN"]));
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  // Verifies #1046 review blocker 2: a reply that is not the documented shape never widens the
  // allowlist, so a host key with no login list names no host.
  it.each([
    ["a null login list", { hosts: { "ghe.example.com": null } }],
    ["an empty login list", { hosts: { "ghe.example.com": [] } }],
    ["a login list that is not an array", { hosts: { "ghe.example.com": {} } }],
    ["a login that is not an object", { hosts: { "ghe.example.com": ["x"] } }],
    [
      "a login for another host",
      { hosts: { "ghe.example.com": [{ host: "x.example", tokenSource: "f" }] } },
    ],
    [
      "a login with no token source",
      { hosts: { "ghe.example.com": [{ host: "ghe.example.com" }] } },
    ],
    ["hosts as an array", { hosts: [{ host: "ghe.example.com", tokenSource: "f" }] }],
    ["hosts as null", { hosts: null }],
    ["a reply that is an array", []],
    ["a reply that is null", null],
  ])("refuses every Link header for a gh reply with %s", async (_name, reply) => {
    const auth = { status: 0, stdout: JSON.stringify(reply), stderr: "" };
    for (const headers of [GHE_LINK, SAME_HOST_LINK]) {
      const { gh } = gheRuns(auth, headers);
      await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
    }
  });

  // Verifies fail-closed handling of a default host that cannot be resolved: no Link target passes.
  it.each([
    ["a failed gh call", { status: 1, stdout: "", stderr: "gh: boom" }],
    ["output that is not JSON", { status: 0, stdout: "nope", stderr: "" }],
    ["JSON with no hosts", { status: 0, stdout: "{}", stderr: "" }],
  ])("refuses a Link header when the gh default host is unreadable: %s", async (_name, auth) => {
    const { gh } = gheRuns(auth, SAME_HOST_LINK);
    await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow(/Link/);
  });

  // Verifies that `GH_HOST` still decides the request host and `gh` is never asked.
  it("does not ask gh for its default host when GH_HOST is set", async () => {
    process.env.GH_HOST = "ghe.example.com";
    const { gh } = gheRuns({ status: 1, stdout: "", stderr: "must not be read" });
    assert.equal((await checkRuns(gh, SLUG, SHA, ".", true)).length, 1);
  });

  // Verifies that a count the pages cannot meet, because the Link-named next page would be needed,
  // ends the read with an error and not a pass.
  it("ends a read in an error when a page ends before the total_count", async () => {
    const { gh, calls } = serve({
      [page(RUNS, 1)]: reply(
        { total_count: 150, check_runs: runs(100) },
        { headers: SAME_HOST_LINK },
      ),
      [page(RUNS, 2)]: reply(
        { total_count: 150, check_runs: runs(10, 100) },
        { headers: SAME_HOST_LINK },
      ),
    });
    await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow(/total_count/);
    expectBoundedCalls(calls, RUNS, 2);
  });

  // Verifies fail-closed handling of a reply that is not one 2xx exchange.
  it.each([
    ["a 2xx reply with no status block", { status: 0, stdout: '{"total_count":0}', stderr: "" }],
    ["a redirect status", reply({ total_count: 0, check_runs: [] }, { status: 302 })],
    [
      "a body that is not one JSON value",
      { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"total_count":0}{"x":1}', stderr: "" },
    ],
    ["a failed request", { status: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" }],
  ])("ends the check-run read in an error for %s", async (_name, first) => {
    const { gh } = serve({ [page(RUNS, 1)]: first });
    await expect(checkRuns(gh, SLUG, SHA, ".", true)).rejects.toThrow();
  });

  const ruleset = (rules) => [{ type: "required_status_checks", parameters: rules }];
  const OTHER = { type: "deletion" };
  const source = (calls, pages) => {
    const { gh, calls: seen } = serve({
      ...pages,
      [`repos/${SLUG}/branches/main/protection`]: {
        status: 1,
        stdout: "",
        stderr: "gh: Branch not protected (HTTP 404)",
      },
    });
    calls.push(seen);
    const wrapped = async (args, cwd, options) =>
      args[0] === "pr" ? { status: 0, stdout: "[]", stderr: "" } : gh(args, cwd, options);
    return wrapped;
  };

  // Verifies that a required-status-check rule on a later ruleset page is found by page number.
  it("finds a required check on a later page of the ruleset read", async () => {
    const seen = [];
    const gh = source(seen, {
      [page(RULES, 1)]: reply(Array(100).fill(OTHER), { headers: SAME_HOST_LINK }),
      [page(RULES, 2)]: reply(
        ruleset({ required_status_checks: [{ context: "ci (ubuntu-latest)" }] }),
      ),
    });
    const found = await requiredContexts(gh, SLUG, "main", 42, ".");
    assert.deepEqual(
      found.contexts.map((context) => context.name),
      ["ci (ubuntu-latest)"],
    );
    expectBoundedCalls(
      seen[0].filter((call) => call.includes("/rules/")),
      RULES,
      2,
    );
  });

  // Verifies that a Link header on another host ends the ruleset read with an error, not with an
  // unknown source and not with a pass, and that the target is never requested.
  it("ends the ruleset read in an error for a Link header on another host", async () => {
    const seen = [];
    const gh = source(seen, {
      [page(RULES, 1)]: reply(Array(100).fill(OTHER), { headers: LINK }),
      [page(RULES, 2)]: reply([]),
    });
    await expect(
      requiredContexts(gh, SLUG, "main", 42, ".").catch((err) => {
        throw failureOf(err);
      }),
    ).rejects.toThrow(/Link/);
    expectBoundedCalls(
      seen[0].filter((call) => call.includes("/rules/")),
      RULES,
      1,
    );
  });

  // Verifies ADR 0012 is unchanged: the pager hands the classifier every page it received, so a
  // full page then an empty page is the sequence the classifier calls unknown, not an absence.
  it("reads a full ruleset page then an empty page as an unknown source", async () => {
    const seen = [];
    const gh = source(seen, {
      [page(RULES, 1)]: reply(Array(100).fill(OTHER)),
      [page(RULES, 2)]: reply([]),
    });
    const found = await requiredContexts(gh, SLUG, "main", 42, ".");
    assert.equal(found.rulesetState, UNKNOWN);
    assert.deepEqual(found.unknown, ["repository rulesets"]);
    expectBoundedCalls(
      seen[0].filter((call) => call.includes("/rules/")),
      RULES,
      2,
    );
  });

  // Verifies a short first page still reads as the complete list and as an absence.
  it("reads a short ruleset page with no required rule as an absence", async () => {
    const gh = source([], { [page(RULES, 1)]: reply([OTHER]) });
    const found = await requiredContexts(gh, SLUG, "main", 42, ".");
    assert.equal(found.rulesetState, ABSENT);
  });

  // Verifies that a ruleset read the runtime cannot account for is an unknown source, never an absence.
  it.each([
    [
      "pages that never end",
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [page(RULES, i + 1), reply(Array(100).fill(OTHER))]),
      ),
    ],
    [
      "a body that is not JSON",
      { [page(RULES, 1)]: { status: 0, stdout: "HTTP/2.0 200 OK\r\n\r\nnope", stderr: "" } },
    ],
    ["a reply with no status block", { [page(RULES, 1)]: { status: 0, stdout: "[]", stderr: "" } }],
  ])("reads the ruleset source as unknown for %s", async (_name, pages) => {
    const found = await requiredContexts(source([], pages), SLUG, "main", 42, ".");
    assert.deepEqual(found.unknown, ["repository rulesets"]);
    assert.equal(found.rulesetState, UNKNOWN);
  });
});

// Requirement (#1054): a single read, as the workflow-file probe makes, validates a reply exactly as
// the pager validates a page, so a failed reply cannot state an absence before its `Link` hosts, its
// status line, and its body are judged, and the 5xx retry classification of the pager (#1025) holds.
describe("a single read validates its reply as the pager does", () => {
  const NOT_FOUND_TEXT = "gh: Not Found (HTTP 404)";
  const ENDPOINT = `repos/${SLUG}/contents/.github/workflows?ref=${SHA}`;
  const failed = (status, body, { headers = "", stderr = NOT_FOUND_TEXT } = {}) => ({
    status: 1,
    stdout: `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n${headers}\r\n${body}`,
    stderr,
  });
  const single = (served) => serve({ [ENDPOINT]: served }).gh;

  // Verifies the one absence the probe accepts: the exact 404 reply with a valid JSON body and no `Link`.
  it("marks the exact 404 reply with a JSON body and no Link target as not found", async () => {
    const read = await readOne(single(failed(404, '{"message":"Not Found"}')), ENDPOINT, ".");
    assert.equal(read.status, 1);
    assert.equal(read.notFound, true);
  });

  // Verifies every other 404 states no absence: a body that is not one JSON value, a `Link` target
  // on a foreign or the request host, another error text, and a status line that is not 404.
  it.each([
    ["a malformed body", failed(404, "oops")],
    ["an empty body", failed(404, "")],
    ["two JSON values", failed(404, "{} {}")],
    ["a foreign Link target", failed(404, "{}", { headers: LINK })],
    ["a same-host Link target", failed(404, "{}", { headers: SAME_HOST_LINK })],
    ["another error text", failed(404, "{}", { stderr: "gh: Not Found for x (HTTP 404)" })],
    ["a 403 status line", failed(403, "{}")],
  ])("never marks a 404 reply with %s as not found", async (_name, served) => {
    const read = await readOne(single(served), ENDPOINT, ".");
    assert.equal(read.status, 1);
    assert.ok(!read.notFound);
  });

  // Verifies the host check of the pager on a failed reply: a foreign target is a terminal error,
  // never transient, so no absence or retry follows it.
  it("ends on a foreign Link target of a failed reply, never as transient", async () => {
    const read = await readOne(single(failed(502, "{}", { headers: LINK })), ENDPOINT, ".");
    assert.equal(read.status, 1);
    assert.match(read.stderr, /other\.example/);
    assert.ok(!read.transient);
  });

  // Verifies the 5xx classification of the pager (#1025): a retryable status with an empty or JSON
  // body is transient, and the same status with another body is not.
  it.each([
    [500, "{}", true],
    [502, '{"message":"bad"}', true],
    [503, "", true],
    [504, "{}", true],
    [502, "<html>bad gateway</html>", false],
    [501, "{}", false],
  ])("classifies a %s reply with body %j as transient: %s", async (status, body, transient) => {
    const read = await readOne(single(failed(status, body, { stderr: "gh: bad" })), ENDPOINT, ".");
    assert.equal(read.status, 1);
    assert.equal(Boolean(read.transient), transient);
    assert.ok(!read.notFound);
  });

  // Verifies a successful reply: the body of one JSON value comes back, and a Link target, a missing
  // status block, a non-2xx status, and a body of two values are refusals marked unreadable or errors.
  it("returns the body of a successful reply and refuses every other shape", async () => {
    const ok = await readOne(single(reply({ a: 1 })), ENDPOINT, ".");
    assert.deepEqual([ok.status, ok.stdout], [0, '{"a":1}']);
    for (const served of [
      reply({}, { headers: SAME_HOST_LINK }),
      reply({}, { headers: LINK }),
      { status: 0, stdout: "{}", stderr: "" },
      reply({}, { status: 302 }),
      { status: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n{} {}", stderr: "" },
    ]) {
      const read = await readOne(single(served), ENDPOINT, ".");
      assert.equal(read.status, 1, JSON.stringify(served));
    }
  });
});
