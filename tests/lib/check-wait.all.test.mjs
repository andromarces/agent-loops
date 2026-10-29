import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import {
  fakeClock,
  HEAD_A,
  scriptedGh,
  check,
  PENDING_ITEM,
  PASSED_ITEM,
  FAILED_ITEM,
  pinned,
  FORBIDDEN,
  NOT_FOUND,
} from "./check-wait-helpers.mjs";

/** Runs one wait in all-checks mode against scripted reads, on a fake clock. */
function onceAll(reads, timeoutSeconds = 60) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds,
    all: true,
    gh: scriptedGh(reads, { all: true }),
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies the all-checks mode waits on a check that is not required,
// the case a branch with no required check leaves unwaited, and settles once every
// listed check passed (issue #896).
test("waitChecks in all mode waits for every listed check to settle", async () => {
  const lint = check("lint", "pass", "SUCCESS");
  expect(
    await onceAll([
      { status: 8, checks: [PENDING_ITEM, lint] },
      { status: 0, checks: [PASSED_ITEM, lint] },
    ]),
  ).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM, lint] });
});

// Usefulness: verifies the all-checks mode keeps the exit-code rules of the
// required read: exit 8 runs to the bound, a listed failure settles, and an exit 1
// with no failing check is unresolved, never a pass (issue #896).
test("waitChecks in all mode keeps the exit-code rules of the required read", async () => {
  expect(await onceAll([{ status: 8, checks: [PENDING_ITEM] }])).toEqual({
    timedOut: true,
    head: HEAD_A,
    checks: [PENDING_ITEM],
  });
  expect(await onceAll([{ status: 1, checks: [FAILED_ITEM] }])).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [FAILED_ITEM],
    prFailures: [FAILED_ITEM],
  });
  await expect(
    onceAll([{ status: 1, checks: [PENDING_ITEM], stderr: "could not read the checks" }]),
  ).rejects.toThrow(/gh pr checks 42/);
  await expect(
    onceAll([{ status: 0, checks: [{ name: "ci", state: "MYSTERY", bucket: null }] }]),
  ).rejects.toThrow(/not well formed/);
});

// Usefulness: verifies an all-checks wait that starts before any check reports
// keeps waiting on the exact `gh` reply and settles on a later check list, so a
// parent that runs `--all` right after a push does not get an error (issue #950).
test("waitChecks in all mode keeps waiting while no check has reported", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    all: true,
    gh: scriptedGh(
      [
        { status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch\n" },
        { status: 8, checks: [PENDING_ITEM] },
        { status: 0, checks: [PASSED_ITEM] },
      ],
      { all: true },
    ),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
  expect(clock.elapsed()).toBeGreaterThan(0);
});

// Usefulness: verifies an all-checks wait that reaches its bound with only that
// reply reports `timedOut: true` and an empty `checks`, never a pass or a
// `noRequiredChecks` outcome (issue #950).
test("waitChecks in all mode reports a timeout with no checks when none ever reported", async () => {
  expect(
    await onceAll([{ status: 1, stdout: "", stderr: "no checks reported on the 'main' branch" }]),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [] });
});

// Usefulness: verifies the all-checks mode has no required-check answer, and a
// near-match of the no-checks reply stays unresolved there (issues #896, #950).
test("waitChecks in all mode refuses the required-check answer and near-matches", async () => {
  const reads = [
    { status: 1, stderr: "no required checks reported on the 'main' branch" },
    { status: 1, stderr: "error: no checks reported on the 'main' branch, try later" },
    { status: 2, stderr: "no checks reported on the 'main' branch" },
  ];
  for (const read of reads) {
    await expect(onceAll([{ ...read, stdout: "" }])).rejects.toThrow(/gh pr checks 42/);
  }
});

// Usefulness: verifies the exact `no checks reported` reply of `gh pr checks` keeps the
// `--all` wait running although the named commit already shows a pass, so the bound ends it
// with `timedOut: true` and never a pass (issue #961).
test("waitChecks in all mode keeps waiting on the no-checks-reported reply", async () => {
  expect(
    await pinned({
      reads: [{ status: 1, stdout: "", stderr: "no checks reported on the 'main' branch" }],
      heads: [HEAD_A],
      head: HEAD_A,
      all: true,
      commits: { [HEAD_A]: [PASSED_ITEM] },
    }),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies the all-checks wait judges every check of the named commit, including
// one that `gh pr checks` does not list, so a pending check of the commit holds the wait
// (issue #961).
test("waitChecks in all mode judges a check of the commit that gh does not list", async () => {
  const lint = check("lint", "pending", "IN_PROGRESS");
  expect(
    await pinned({
      reads: [{ status: 0, checks: [PASSED_ITEM] }],
      heads: [HEAD_A],
      head: HEAD_A,
      all: true,
      commits: { [HEAD_A]: [PASSED_ITEM, lint] },
    }),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [PASSED_ITEM, lint] });
});

// Usefulness: verifies the all-checks wait reads no required-check source, so an unreadable
// source cannot stop it (issue #961).
test("waitChecks in all mode does not read the required-check sources", async () => {
  expect(
    await pinned({
      reads: [{ status: 0, checks: [PASSED_ITEM] }],
      heads: [HEAD_A],
      all: true,
      commits: { [HEAD_A]: [PASSED_ITEM] },
      rules: FORBIDDEN,
      protection: NOT_FOUND,
    }),
  ).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies an expected check that registers after an earlier check passed keeps the
// all-checks wait running, and that the wait settles once that check has a run on the head, so a
// late third-party check is never missed (issue #978).
test("waitChecks in all mode waits for an expected check that registers late", async () => {
  const deploy = check("deploy", "pass", "SUCCESS");
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    all: true,
    expect: ["deploy"],
    gh: scriptedGh(
      [
        { status: 0, checks: [PASSED_ITEM] },
        { status: 0, checks: [PASSED_ITEM] },
        { status: 0, checks: [PASSED_ITEM, deploy] },
      ],
      { all: true },
    ),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM, deploy] });
  expect(clock.elapsed()).toBeGreaterThan(0);
});

// Usefulness: verifies an expected check that never registers ends the wait at the bound with
// `timedOut: true`, never as a pass, and names the check still awaited (issue #978).
test("waitChecks in all mode times out when an expected check never registers", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    all: true,
    expect: ["deploy"],
    gh: scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], { all: true }),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({
    timedOut: true,
    head: HEAD_A,
    checks: [PASSED_ITEM],
    awaiting: ["deploy"],
  });
});

// Usefulness: verifies a failing check still settles the wait while an expected check is absent,
// so a failure is reported at once instead of waited out (issue #978).
test("waitChecks in all mode settles on a failing check while an expected check is absent", async () => {
  expect(
    (
      await waitChecks({
        pr: 42,
        cwd: ".",
        timeoutSeconds: 60,
        all: true,
        expect: ["deploy"],
        gh: scriptedGh([{ status: 1, checks: [FAILED_ITEM] }], { all: true }),
        now: fakeClock().now,
        sleep: fakeClock().sleep,
      })
    ).timedOut,
  ).toBe(false);
});

// Usefulness: verifies an expected name is matched against check runs only, so a successful
// commit status with the same name is not a check run on the head and the wait times out,
// never a pass (issue #978).
test("waitChecks in all mode does not match an expected name to a commit status", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    all: true,
    expect: ["deploy"],
    gh: scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
      all: true,
      statuses: [
        {
          id: 1,
          context: "deploy",
          state: "success",
          created_at: "2026-10-21T00:00:00Z",
          updated_at: "2026-10-21T00:00:00Z",
        },
      ],
    }),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result.timedOut).toBe(true);
  expect(result.awaiting).toEqual(["deploy"]);
});
