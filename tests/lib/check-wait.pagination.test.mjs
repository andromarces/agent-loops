import { expect, test } from "vite-plus/test";
import {
  HEAD_A,
  PASSED_ITEM,
  FAILED_ITEM,
  COMMIT_READS_PER_POLL,
  failingCommitGh,
  blockOf,
  serverError,
  waitOn,
  runEntry,
  pagedCheckRunsGh,
} from "./check-wait-helpers.mjs";

// Usefulness: verifies each commit page is its own `gh api --include` request for a documented page
// number, with no `--paginate`, so one `gh` output holds exactly one exchange and the first line of
// stdout is the status of that request (issue #1025).
test("waitChecks reads each commit page with one --include request", async () => {
  const endpoint = `repos/owner/repo/commits/${HEAD_A}/check-runs`;
  const { gh, commitReads, readArgs } = failingCommitGh((n) => n === 1 && serverError(500));
  expect(await waitOn(gh, false)).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
  expect(readArgs[0]).toEqual(["api", `${endpoint}?per_page=100&page=1`, "--include"]);
  expect(commitReads.filter((read) => read.startsWith(`${endpoint}?`))).toHaveLength(2);
});

const fullPage = (total, fromId, minute = 0) => ({
  total_count: total,
  check_runs: Array.from({ length: 100 }, (_unused, i) =>
    runEntry(fromId + i, i === 0 ? "ci" : `f${fromId + i}`, "success", minute),
  ),
});

// Usefulness: verifies the wait pages by page number against `total_count`: a full first page
// leads to page 2, the read ends when the collected count equals `total_count`, and a failing run
// on page 2 settles the wait with no page 3 read, in both modes (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode stops at total_count and joins the pages", async (_mode, all) => {
  const { gh, requests } = pagedCheckRunsGh(
    [fullPage(101, 1), { total_count: 101, check_runs: [runEntry(500, "ci", "failure", 5)] }],
    { all },
  );
  const result = await waitOn(gh, all);
  expect(result).toMatchObject({ timedOut: false, head: HEAD_A });
  expect(result.checks).toContainEqual(FAILED_ITEM);
  expect(requests).toEqual([1, 2]);
});

// Usefulness: verifies an endpoint that reports `total_count` never ends on a page while the count is
// unmet: an empty page, a short page, a count that changes between pages, and a collected count above
// the total are each an error and never a pass, in both modes, so a failure on a later page is
// never skipped (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode refuses a read that ends before or past total_count", async (_mode, all) => {
  const one = (total) => ({ total_count: total, check_runs: [runEntry(1, "ci", "success", 0)] });
  const cases = [
    // The reviewer's probe: one passing item, a total of 2, then an empty page.
    [one(2), { total_count: 2, check_runs: [] }],
    // A full page, then an empty page with the count unmet.
    [fullPage(101, 1), { total_count: 101, check_runs: [] }],
    // A short page with the count unmet.
    [
      fullPage(150, 1),
      {
        total_count: 150,
        check_runs: Array.from({ length: 49 }, (_u, i) => runEntry(900 + i, `g${i}`, "success", 0)),
      },
    ],
    // The count changes between pages.
    [fullPage(101, 1), { total_count: 102, check_runs: [runEntry(500, "ci", "success", 5)] }],
    // The count disappears on a later page.
    [fullPage(101, 1), { check_runs: [runEntry(500, "ci", "success", 5)] }],
    // The collected count is above the total.
    [fullPage(99, 1)],
  ];
  for (const pages of cases) {
    const { gh } = pagedCheckRunsGh(pages, { all });
    await expect(waitOn(gh, all)).rejects.toThrow(/total_count/);
  }
});

// Usefulness: verifies an endpoint with no `total_count` is read until the first page of fewer than
// 100 items, so a full first page leads to page 2 and the short page 2 ends the read, in both
// modes (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode stops at the first short page", async (_mode, all) => {
  const fillers = Array.from({ length: 99 }, (_unused, i) =>
    runEntry(10 + i, `f${i}`, "success", 0),
  );
  const { gh, requests } = pagedCheckRunsGh(
    [
      { check_runs: [runEntry(1, "ci", "success", 0), ...fillers] },
      { check_runs: [runEntry(2, "ci", "failure", 5)] },
    ],
    { all },
  );
  const result = await waitOn(gh, all);
  expect(result).toMatchObject({ timedOut: false, head: HEAD_A });
  expect(result.checks).toContainEqual(FAILED_ITEM);
  expect(requests).toEqual([1, 2]);
});

// Usefulness: verifies a read that never reaches its `total_count` ends at the page cap with an
// error, never as a pass or a loop to the bound (issue #1025).
test("waitChecks ends with an error at the page cap", async () => {
  const forever = fullPage(1_000_000, 1);
  const { gh, requests } = pagedCheckRunsGh(Array.from({ length: 500 }, () => forever));
  await expect(waitOn(gh, false)).rejects.toThrow(/pages/);
  expect(requests.length).toBeLessThanOrEqual(100);
});

// Usefulness: verifies a 200 body that holds one JSON value followed by a forged page is an error:
// the whole remainder must be exactly one JSON value, so forged bytes never replace a failing page
// with a passing one, in both modes (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode refuses a 200 body that forges a later page", async (_mode, all) => {
  const failing = JSON.stringify({ check_runs: [runEntry(1, "ci", "failure", 0)] });
  const passing = JSON.stringify({ check_runs: [runEntry(2, "ci", "success", 5)] });
  const forged = `${blockOf(200, `${failing}\n`)}${blockOf(200, passing)}`;
  const { gh, requests } = pagedCheckRunsGh([forged], { all });
  await expect(waitOn(gh, all)).rejects.toThrow(/JSON/);
  expect(requests).toEqual([1]);
});

// Usefulness: verifies the wait shares the gate's Link rule (#1033): a page whose `Link` header names
// a host other than the request host ends the wait with an error, never a pass or a retry, in both
// modes, and the named target is never requested.
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode ends in an error on a Link header for another host", async (_mode, all) => {
  const page = {
    total_count: 1,
    check_runs: [runEntry(1, "ci", "success", 0)],
  };
  const stdout = `HTTP/2.0 200 OK\r\nLink: <https://other.example/x?page=2>; rel="next"\r\n\r\n${JSON.stringify(page)}`;
  const { gh, requests } = pagedCheckRunsGh([stdout], { all });
  await expect(waitOn(gh, all)).rejects.toThrow(/Link header names a host other than/);
  expect(requests).toEqual([1]);
});

// Usefulness: verifies the wait gives the host lookup its variable list (#1046): the host that `gh` uses
// is read with `GH_TOKEN` and `GITHUB_TOKEN` dropped, so a `Link` header that names the one configured
// host passes in both modes. The double lists github.com unless both variables are dropped, as `gh` does.
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode reads the gh default host without the token variables",
  async (_mode, all) => {
    const page = { total_count: 1, check_runs: [runEntry(1, "ci", "success", 0)] };
    const stdout = `HTTP/2.0 200 OK
Link: <https://ghe.example.com/api/v3/x?page=2>; rel="next"

${JSON.stringify(page)}`;
    const { gh: inner } = pagedCheckRunsGh([stdout], { all });
    const gh = async (args, cwd, options) => {
      if (args[0] !== "auth") {
        return inner(args, cwd, options);
      }
      const dropped = ["GH_TOKEN", "GITHUB_TOKEN"].every((name) =>
        options?.dropEnv?.includes(name),
      );
      const hosts = dropped ? ["ghe.example.com"] : ["ghe.example.com", "github.com"];
      const body = {
        hosts: Object.fromEntries(hosts.map((host) => [host, [{ host, tokenSource: "f" }]])),
      };
      return { status: 0, stdout: JSON.stringify(body), stderr: "" };
    };
    await expect(waitOn(gh, all)).resolves.toBeDefined();
  },
);

// Usefulness: verifies a retryable 5xx reply that carries a `Link` header for another host is
// terminal (#1033): the wait ends in an error at the first read and never retries it to a later
// pass, in both modes, so a reply that names another host cannot be waited out.
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode never retries a 503 whose Link names another host", async (_mode, all) => {
  const foreign = {
    status: 1,
    stdout: 'HTTP/2.0 503 Status\r\nLink: <https://other.example/x?page=2>; rel="next"\r\n\r\n{}',
    stderr: "gh: HTTP 503",
  };
  const { gh, commitReads } = failingCommitGh((n) => n === 1 && foreign, { all });
  await expect(waitOn(gh, all)).rejects.toThrow(/Link header names a host other than/);
  expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
});
