import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import { fakeClock, HEAD_A, HEAD_B, scriptedGh } from "../runtime-helpers.mjs";

// Usefulness: verifies the scripted `gh` routes on the argument elements, so a
// call that merges the arguments into one element gets no reply and its error
// prints the array, which differs from the text of the expected call (issue #530).
test("the scripted gh gives no reply to a merged-argument call", async () => {
  const merged = ["pr checks 42 --required --json name,state,bucket"];
  const reply = await scriptedGh([{ checks: [] }])(merged, ".");
  expect(reply.status).toBe(1);
  expect(reply.stdout).toBe("");
  expect(reply.stderr).toContain(JSON.stringify(merged));
  const unfiltered = ["pr", "checks", "42", "--json", "name,state,bucket"];
  expect((await scriptedGh([{ checks: [] }])(unfiltered, ".")).status).toBe(1);
});

function check(name, bucket, state) {
  return { name, state, bucket };
}

const PENDING_ITEM = check("ci", "pending", "IN_PROGRESS");
const PASSED_ITEM = check("ci", "pass", "SUCCESS");
const FAILED_ITEM = check("ci", "fail", "FAILURE");

/** Runs one wait against a single scripted read, on a fake clock. */
function once(read, timeoutSeconds = 60) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds,
    gh: scriptedGh([read]),
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies the wait returns the required check states and no timeout
// once nothing is pending, and that it keeps polling past a read that reported no
// required check, because `gh pr checks --required` omits a check that has not
// started (issue #329).
test("waitChecks returns the check states and no timeout once nothing is pending", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    gh: scriptedGh([
      { status: 0, checks: [] },
      { status: 8, checks: [PENDING_ITEM] },
      {
        status: 0,
        checks: [PASSED_ITEM],
      },
    ]),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
  expect(clock.elapsed()).toBeLessThan(300_000);
});

// Usefulness: verifies exit 0: every listed required check passed, so the wait is
// settled and reports no timeout (issue #329).
test("waitChecks settles on exit 0 with every required check passed", async () => {
  expect(
    await once({ status: 0, checks: [PASSED_ITEM, check("lint", "pass", "SUCCESS")] }),
  ).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [PASSED_ITEM, check("lint", "pass", "SUCCESS")],
  });
});

// Usefulness: verifies exit 8: a required check is pending, so the wait runs to
// its bound and reports the pending check as the last state it read (issue #329).
test("waitChecks keeps waiting on exit 8 and reports the bound", async () => {
  expect(await once({ status: 8, checks: [PENDING_ITEM] })).toEqual({
    timedOut: true,
    head: HEAD_A,
    checks: [PENDING_ITEM],
  });
});

// Usefulness: verifies exit 1 with a failing required check listed: the wait is
// settled and reports the failure instead of waiting it out to the bound
// (issue #329).
test("waitChecks settles on exit 1 when a failing required check is listed", async () => {
  expect(await once({ status: 1, checks: [FAILED_ITEM] })).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [FAILED_ITEM],
  });
});

// Usefulness: verifies exit 1 on a base branch with no required check refuses
// instead of reading as a pass, because an empty list and a read error share that
// exit code (issue #329).
test("waitChecks refuses exit 1 when the base branch has no required check", async () => {
  await expect(
    once({
      status: 1,
      checks: [],
      stderr: "no required checks found on the 'main' branch",
    }),
  ).rejects.toThrow(/gh pr checks 42 --required/);
});

// Usefulness: verifies the exact `gh` answer for a branch with no required check
// is its own settled outcome, with no check state, so the parent can tell it from
// a read error and never reads it as a pass (issue #894).
test("waitChecks reports a branch with no required check as its own outcome", async () => {
  const result = await once({
    status: 1,
    stdout: "",
    stderr: "no required checks reported on the 'docs/212-adr-0024-agent-reads' branch\n",
  });
  expect(result).toEqual({ timedOut: false, head: HEAD_A, noRequiredChecks: true, checks: [] });
});

// Usefulness: verifies only the exact `gh` answer is the new outcome: the same
// words inside a longer error text, or on another exit code, stay unresolved
// (issue #894).
test("waitChecks keeps any other exit 1 without a failing check unresolved", async () => {
  const reads = [
    { status: 1, stderr: "error: no required checks reported on the 'main' branch, try later" },
    { status: 2, stderr: "no required checks reported on the 'main' branch" },
    { status: 1, stderr: "no required checks found on the 'main' branch" },
    { status: 1, stderr: "" },
  ];
  for (const read of reads) {
    await expect(once({ ...read, stdout: "" })).rejects.toThrow(/gh pr checks 42 --required/);
  }
});

// Usefulness: verifies a wait that starts before any check reports on a new PR
// head keeps waiting on the exact `gh` reply and settles on a later check list,
// instead of ending as a read error (issue #941).
test("waitChecks keeps waiting while no check has reported on the PR head", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    gh: scriptedGh([
      { status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch\n" },
      { status: 8, checks: [PENDING_ITEM] },
      { status: 0, checks: [PASSED_ITEM] },
    ]),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
  expect(clock.elapsed()).toBeGreaterThan(0);
});

// Usefulness: verifies a wait that reaches its bound with only that reply reports
// `timedOut: true` and an empty `checks`, so it never reads as a pass (issue #941).
test("waitChecks reports a timeout with no checks when none ever reported", async () => {
  const result = await once(
    { status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch" },
    60,
  );
  expect(result).toEqual({ timedOut: true, head: HEAD_A, checks: [] });
});

// Usefulness: verifies only the exact reply keeps the wait running: the same words
// inside a longer error text, or on another exit code, stay unresolved (issue #941).
test("waitChecks keeps any other near-match of the no-checks reply unresolved", async () => {
  const reads = [
    { status: 1, stderr: "error: no checks reported on the 'main' branch, try later" },
    { status: 2, stderr: "no checks reported on the 'main' branch" },
    { status: 1, stderr: "no checks found on the 'main' branch" },
  ];
  for (const read of reads) {
    await expect(once({ ...read, stdout: "" })).rejects.toThrow(/gh pr checks 42 --required/);
  }
});

// Usefulness: verifies exit 1 as a read error refuses instead of reading as a
// pass (issue #329).
test("waitChecks refuses exit 1 when the read itself failed", async () => {
  await expect(
    once({
      status: 1,
      checks: [],
      stderr: "could not resolve to a PullRequest with the number of 999999",
    }),
  ).rejects.toThrow(/gh pr checks 42 --required/);
});

// Usefulness: verifies unparseable output refuses instead of reading as a pass,
// so a `gh` that answers with anything other than a check list is unresolved
// (issue #329).
test("waitChecks refuses output that is not a check list", async () => {
  await expect(once({ status: 0, stdout: "no checks here" })).rejects.toThrow(
    /gh pr checks 42 --required/,
  );
});

// Usefulness: verifies every check item is validated. A malformed item carries
// no state to read, and must be unresolved rather than a settled pass (issue #329).
test("waitChecks refuses a check item that is not well formed", async () => {
  const malformed = [
    [{}],
    [{ name: "ci" }],
    [{ state: "SUCCESS", bucket: "pass" }],
    [{ name: "", state: "SUCCESS", bucket: "pass" }],
    [{ name: "ci", bucket: "unknown" }],
    [{ name: "ci", state: "MADE_UP" }],
    ["pass"],
    [null],
  ];
  for (const checks of malformed) {
    await expect(once({ status: 0, checks })).rejects.toThrow(/gh pr checks 42 --required/);
  }
  // A well-formed item beside a malformed one is still unresolved, so one bad
  // item cannot hide behind a passing one.
  await expect(once({ status: 0, checks: [PASSED_ITEM, {}] })).rejects.toThrow(
    /gh pr checks 42 --required/,
  );
});

// Usefulness: verifies the timeout outcome: a check still pending when the bound
// elapses returns `timedOut` with the last check states, so a parent learns that
// the wait ended on the bound and not on a settled check (issue #329).
test("waitChecks reports the bound as reached when a required check is still pending", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh: scriptedGh([{ status: 8, checks: [PENDING_ITEM] }]),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: true, head: HEAD_A, checks: [PENDING_ITEM] });
  // The wait never runs past the bound it was given.
  expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
  expect(clock.elapsed()).toBeLessThan(120_000);
});

// Usefulness: verifies a bound already spent before the first read performs no
// read at all. The caller owns that bound, which is how the work that runs before
// the first read, such as work-tree validation, stays inside it (#329).
test("waitChecks performs no read when the caller deadline has passed", async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    deadline: 1000,
    gh: async () => {
      reads += 1;
      return { status: 0, stdout: JSON.stringify([PASSED_ITEM]), stderr: "" };
    },
    now: () => 1000,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: true, head: null, checks: [] });
  expect(reads).toBe(0);
});

// Usefulness: verifies the child-exit claim. When the ceiling expires with the
// read still unaccounted for, the envelope says so, because the command cannot
// claim an exit it did not observe (issue #329).
test("waitChecks reports an unconfirmed child exit when the ceiling expires", async () => {
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 0.2,
    // Never settles, so the exit of this read is never observed.
    gh: () => new Promise(() => {}),
  });
  expect(result).toEqual({ timedOut: true, head: null, checks: [], childExitUnconfirmed: true });
}, 20000);

// Usefulness: verifies a read abandoned on the bound is not reported before the
// `gh` child exits. The command waits for the child, so a parent that runs the
// command again does not stack a second read on top of a live one (issue #329).
test("waitChecks waits for an abandoned gh read to exit before it returns", async () => {
  const started = Date.now();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 0.2,
    // Answers only after the bound, as a slow child does.
    gh: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ status: 0, stdout: "[]", stderr: "" }), 900);
      }),
  });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(850);
  // The read settled, so its exit was observed and the envelope does not claim
  // otherwise.
  expect(result.childExitUnconfirmed).toBeUndefined();
});

// Usefulness: verifies the child-exit ceiling. A read that never answers cannot
// hold the command open forever, so the command returns within the bound plus
// the ceiling and reports the bound (issue #329).
test("waitChecks returns within the bound plus the child-exit ceiling", async () => {
  const signals = [];
  const started = Date.now();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 0.2,
    // Never settles, and records the signal that must stop it.
    gh: async (args, cwd, { signal } = {}) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  expect(result.timedOut).toBe(true);
  const elapsed = Date.now() - started;
  // The ceiling is spent, and the total stays inside the stated bound.
  expect(elapsed).toBeGreaterThanOrEqual(5000);
  expect(elapsed).toBeLessThan(10_000);
  // Every read is bounded by the time left and is signaled to stop when the
  // bound is reached, which is what terminates the `gh` child.
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
}, 20000);

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

/** Runs one wait on a fake clock against scripted reads and PR heads. */
function pinned({ reads, heads, head, timeoutSeconds = 60, all = false, commits }) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds,
    all,
    head,
    gh: scriptedGh(reads, { all, heads, commits }),
    now: clock.now,
    sleep: clock.sleep,
  });
}

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

// Usefulness: verifies the states of the named commit decide the outcome in both
// directions: its passing checks settle the wait when `gh pr checks` still lists a pending
// check of another commit, and its failing check settles it when `gh pr checks` lists a
// pass (issue #961).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode reports the states of the named commit", async (_mode, all) => {
  expect(
    await pinned({
      reads: [{ status: 8, checks: [PENDING_ITEM] }],
      heads: [HEAD_A],
      head: HEAD_A,
      all,
      commits: { [HEAD_A]: [PASSED_ITEM] },
    }),
  ).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
  expect(
    await pinned({
      reads: [{ status: 0, checks: [PASSED_ITEM] }],
      heads: [HEAD_A],
      head: HEAD_A,
      all,
      commits: { [HEAD_A]: [FAILED_ITEM] },
    }),
  ).toEqual({ timedOut: false, head: HEAD_A, checks: [FAILED_ITEM] });
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
