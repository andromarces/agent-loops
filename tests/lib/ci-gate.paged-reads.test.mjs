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

/** The `gh auth status --json hosts` stdout for hosts in the `gh` configuration. */
const authHosts = (...hosts) => ({
  status: 0,
  stdout: JSON.stringify({ hosts: Object.fromEntries(hosts.map((host) => [host, [{ host }]])) }),
  stderr: "",
});

/**
 * A `gh` double that serves `pages` by endpoint and records every `api` call as joined text. `auth`
 * is its `gh auth status --json hosts` reply, by default the one github.com login.
 */
function serve(pages, auth = authHosts("github.com")) {
  const calls = [];
  const gh = async (args) => {
    if (args[0] === "auth") {
      return auth;
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
