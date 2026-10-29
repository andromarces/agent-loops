import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import {
  fakeClock,
  HEAD_A,
  HEAD_B,
  scriptedGh,
  PENDING_ITEM,
  PASSED_ITEM,
  FAILED_ITEM,
  pinned,
  waitOn,
  runEntry,
  pagedCheckRunsGh,
} from "./check-wait-helpers.mjs";

// Usefulness: verifies the envelope names the PR head that its checks describe,
// so a parent can compare it with the commit it expects (issue #961).
test("waitChecks names the head that the settled checks describe", async () => {
  expect(await pinned({ reads: [{ status: 0, checks: [PASSED_ITEM] }], heads: [HEAD_B] })).toEqual({
    timedOut: false,
    head: HEAD_B,
    checks: [PASSED_ITEM],
  });
});

// Usefulness: verifies a wait that expects a head keeps waiting while the PR head
// is another commit, so the passing checks of the previous head never settle it
// (issue #961).
test("waitChecks keeps waiting while the PR head is not the expected head", async () => {
  // Reads on the old head would pass; the first two polls must not take them.
  const reads = [{ status: 8, checks: [PENDING_ITEM] }];
  const result = await pinned({ reads, heads: [HEAD_A, HEAD_A, HEAD_B, HEAD_B], head: HEAD_B });
  expect(result).toEqual({ timedOut: true, head: HEAD_B, checks: [PENDING_ITEM] });
});

// Usefulness: verifies a read on the expected head settles the wait, as the issue
// asks (issue #961).
test("waitChecks settles once the PR head reaches the expected head", async () => {
  expect(
    await pinned({
      reads: [{ status: 0, checks: [PASSED_ITEM] }],
      heads: [HEAD_A, HEAD_B, HEAD_B],
      head: HEAD_B,
    }),
  ).toEqual({ timedOut: false, head: HEAD_B, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a wait that reaches its bound before the PR head reaches
// the expected head returns `timedOut: true`, no head, and no checks, never a pass
// (issue #961).
test("waitChecks times out without a pass when the PR head never reaches the expected head", async () => {
  expect(
    await pinned({ reads: [{ status: 0, checks: [PASSED_ITEM] }], heads: [HEAD_A], head: HEAD_B }),
  ).toEqual({ timedOut: true, head: null, checks: [] });
});

// Usefulness: verifies the wait takes check states from the commit it names, by SHA, and
// not from `gh pr checks`, which queries by PR identity. A PR head that moved away and
// returned, or a stale view, leaves `gh pr checks` answering with another commit's passing
// checks, and those never settle a wait on a commit whose own check still runs, in the
// required and the all-checks mode (issue #961).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode never settles on the checks of another commit", async (_mode, all) => {
  const result = await pinned({
    // `gh pr checks` reports the other commit's passing check.
    reads: [{ status: 0, checks: [PASSED_ITEM] }],
    heads: [HEAD_A],
    head: HEAD_A,
    all,
    commits: { [HEAD_A]: [PENDING_ITEM], [HEAD_B]: [PASSED_ITEM] },
  });
  expect(result).toEqual({ timedOut: true, head: HEAD_A, checks: [PENDING_ITEM] });
});

// Usefulness: verifies a failing state of the named commit settles the wait even when
// `gh pr checks` lists a pass, and a pass needs both the PR outcome and the commit states, in
// both modes (issue #961).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode settles on a pass only when the PR and the commit both pass",
  async (_mode, all) => {
    const base = { heads: [HEAD_A], head: HEAD_A, all };
    expect(
      await pinned({
        ...base,
        reads: [{ status: 0, checks: [PASSED_ITEM] }],
        commits: { [HEAD_A]: [PASSED_ITEM] },
      }),
    ).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
    expect(
      await pinned({
        ...base,
        reads: [{ status: 0, checks: [PASSED_ITEM] }],
        commits: { [HEAD_A]: [FAILED_ITEM] },
      }),
    ).toEqual({ timedOut: false, head: HEAD_A, checks: [FAILED_ITEM] });
  },
);

// Usefulness: verifies the commit states only make the outcome stricter: `gh pr checks` exit 8
// (pending) keeps the wait running although the named commit shows a pass, so the command
// reaches the bound with `timedOut: true` and never a pass, in both modes (issue #961).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode keeps waiting on a pending PR outcome", async (_mode, all) => {
  expect(
    await pinned({
      reads: [{ status: 8, checks: [PENDING_ITEM] }],
      heads: [HEAD_A],
      head: HEAD_A,
      all,
      commits: { [HEAD_A]: [PASSED_ITEM] },
    }),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a failure that `gh pr checks` lists settles the wait whatever the named
// commit shows, a pass, a pending check, or no entry, and is reported in `prFailures`, apart from
// `checks`, because `gh pr checks` is not pinned to the commit: `checks` holds only states read
// for `head`, in both modes (issue #961).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode reports a listed failure apart from the states of the commit",
  async (_mode, all) => {
    const missing = all ? [] : [{ name: "ci", state: "PENDING", bucket: "pending" }];
    for (const [commit, checks] of [
      [[PASSED_ITEM], [PASSED_ITEM]],
      [[PENDING_ITEM], [PENDING_ITEM]],
      [[], missing],
    ]) {
      expect(
        await pinned({
          reads: [{ status: 1, checks: [FAILED_ITEM] }],
          heads: [HEAD_A],
          head: HEAD_A,
          all,
          commits: { [HEAD_A]: commit },
        }),
      ).toEqual({ timedOut: false, head: HEAD_A, checks, prFailures: [FAILED_ITEM] });
    }
  },
);

// Usefulness: verifies an app-qualified required context is satisfied only by a run of that
// app, as the `--require-ci` gate judges it: a newer success from another app never masks a
// failure of the required app, in the required and the all-checks mode (issue #961).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode keeps the app of a check run", async (_mode, all) => {
  const required = { ...FAILED_ITEM, appId: 15368, startedAt: "2026-01-01T00:00:00Z" };
  const other = { ...PASSED_ITEM, appId: 99999, startedAt: "2026-01-01T00:05:00Z" };
  const result = await pinned({
    reads: [{ status: 0, checks: [PASSED_ITEM] }],
    heads: [HEAD_A],
    head: HEAD_A,
    all,
    commits: { [HEAD_A]: [required, other] },
    requiredContexts: [{ name: "ci", appId: 15368 }],
  });
  expect(result.timedOut).toBe(false);
  expect(result.checks).toContainEqual(FAILED_ITEM);
  if (!all) {
    expect(result.checks).toEqual([FAILED_ITEM]);
  }
});

// Usefulness: verifies a required check that `gh pr checks` lists but that has no entry on the
// named commit has not reported there, so it is pending and never a pass (issue #961).
test("waitChecks reads a required check with no entry on the commit as pending", async () => {
  expect(
    await pinned({
      reads: [{ status: 0, checks: [PASSED_ITEM] }],
      heads: [HEAD_A],
      head: HEAD_A,
      commits: { [HEAD_A]: [] },
    }),
  ).toEqual({
    timedOut: true,
    head: HEAD_A,
    checks: [{ name: "ci", state: "PENDING", bucket: "pending" }],
  });
});

// Usefulness: verifies a commit read that fails is unresolved, never a pass (issue #961).
test("waitChecks refuses a commit read that fails", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }]);
  const gh = async (args, cwd, options) =>
    args[0] === "api" ? { status: 1, stdout: "", stderr: "boom" } : inner(args, cwd, options);
  const clock = fakeClock();
  await expect(
    waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 60, gh, now: clock.now, sleep: clock.sleep }),
  ).rejects.toThrow(/gh api repos\/owner\/repo\/commits\/.+ failed: boom/);
});

// Usefulness: verifies a failed slug read keeps the text `gh repo view could not be read`, so the shared
// slug read does not change the wait error (issue #1126).
test("waitChecks names a failed repository read as one that could not be read", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }]);
  const gh = async (args, cwd, options) =>
    args[0] === "repo" ? { status: 1, stdout: "", stderr: "boom" } : inner(args, cwd, options);
  const clock = fakeClock();
  await expect(
    waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 60, gh, now: clock.now, sleep: clock.sleep }),
  ).rejects.toThrow("gh repo view could not be read: boom");
});

// Usefulness: verifies a lone check run whose timestamp has no `T` still passes, because no order
// is read from a single entry, so the strict timestamp parse stays out of the read validation (issue #1126).
test("waitChecks accepts a lone check run with a timestamp that is only a parseable date", async () => {
  const at = "2026-01-01 00:00:00Z";
  const { gh } = pagedCheckRunsGh([
    {
      total_count: 1,
      check_runs: [{ ...runEntry(1, "ci", "success", 0), started_at: at, completed_at: at }],
    },
  ]);
  expect(await waitOn(gh, false)).toMatchObject({ timedOut: false, head: HEAD_A });
});

// Usefulness: verifies the last checks kept for a timeout envelope are never the
// checks of a head the envelope does not name (issue #961).
test("waitChecks drops the kept checks of an earlier head when the head moves", async () => {
  const result = await pinned({
    reads: [
      { status: 8, checks: [PENDING_ITEM] },
      { status: 0, checks: [] },
    ],
    heads: [HEAD_A, HEAD_A, HEAD_B, HEAD_B],
  });
  expect(result.timedOut).toBe(true);
  expect(result.head).toBe(HEAD_B);
  expect(result.checks).toEqual([]);
});

// Usefulness: verifies an unreadable head is unresolved, never a pass (issue #961).
test("waitChecks refuses a head read it cannot parse", async () => {
  const gh = async (args) =>
    args[1] === "view"
      ? { status: 0, stdout: JSON.stringify({ headRefOid: "not-a-sha" }), stderr: "" }
      : { status: 0, stdout: JSON.stringify([PASSED_ITEM]), stderr: "" };
  const clock = fakeClock();
  await expect(
    waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 60, gh, now: clock.now, sleep: clock.sleep }),
  ).rejects.toThrow(/gh pr view 42/);
});
