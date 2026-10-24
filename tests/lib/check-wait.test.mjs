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
    prFailures: [FAILED_ITEM],
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

// The exact reply a private repository on the GitHub Free plan writes to the required-context
// API endpoints (#301).
const FREE_PLAN =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

// The sources that each state the absence of a required check, as the gate reads them: a
// ruleset reply with a rule but no required-status-check rule, and an unprotected branch.
const ABSENT_SOURCES = {
  rules: { status: 0, stdout: JSON.stringify([[{ type: "deletion" }]]), stderr: "" },
};

/** Runs one wait whose `gh pr checks --required` answers that the branch has no required check. */
function noRequiredChecksWait(sources) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh: scriptedGh(
      [
        {
          status: 1,
          stdout: "",
          stderr: "no required checks reported on the 'docs/212-adr-0024-agent-reads' branch\n",
        },
      ],
      sources,
    ),
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies the exact `gh` answer for a branch with no required check
// is its own settled outcome, with no check state, so the parent can tell it from
// a read error and never reads it as a pass (issue #894).
test("waitChecks reports a branch with no required check as its own outcome", async () => {
  expect(await noRequiredChecksWait(ABSENT_SOURCES)).toEqual({
    timedOut: false,
    head: HEAD_A,
    noRequiredChecks: true,
    checks: [],
  });
});

// Usefulness: verifies the `gh` no-required-checks answer is not an absence while a source of
// the `--require-ci` gate cannot state one, so the wait and the gate give the same answer on a
// base branch whose rulesets cannot be read, such as the Free-plan 403 (issue #1013).
test.each([
  [
    "an unreadable ruleset source",
    { rules: { status: 1, stdout: "", stderr: FREE_PLAN } },
    /repository rulesets/,
  ],
  ["a ruleset read that found no rule", {}, /repository rulesets/],
  [
    "an unreadable protection source",
    {
      ...ABSENT_SOURCES,
      protection: { status: 1, stdout: "", stderr: FREE_PLAN },
    },
    /classic branch protection/,
  ],
  [
    "a ruleset reply that cannot be parsed",
    { rules: { status: 0, stdout: "not json", stderr: "" } },
    /repository rulesets/,
  ],
])("waitChecks refuses the no-required-checks answer over %s", async (_name, sources, message) => {
  await expect(noRequiredChecksWait(sources)).rejects.toThrow(message);
});

// Usefulness: verifies a failed read of the required names refuses the no-required-checks
// answer, as it refuses every other required wait, so the wait never reports an absence while
// the names read has failed (issue #1013).
test("waitChecks refuses the no-required-checks answer when the names read failed", async () => {
  await expect(
    noRequiredChecksWait({ ...ABSENT_SOURCES, names: { status: 1, stdout: "", stderr: "boom" } }),
  ).rejects.toThrow(/required check names/);
});

// Usefulness: verifies the wait agrees with the `--require-ci` gate on a ruleset read that found
// no rule beside a classic-protection required check: the gate judges that check and does not
// refuse, so the wait goes on to judge it instead of erroring (issue #1013).
test("waitChecks does not error on an empty ruleset read beside a classic required check", async () => {
  expect(
    await noRequiredChecksWait({
      protection: {
        status: 0,
        stdout: JSON.stringify({ required_status_checks: { contexts: ["ci"] } }),
        stderr: "",
      },
    }),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [] });
});

// Usefulness: verifies a ruleset that names a required check is not an absence, even when
// `gh` lists none yet: the check has not reported, so the wait continues to the bound (#1013).
test("waitChecks keeps waiting when a source names a required check that gh lists none of", async () => {
  expect(
    await noRequiredChecksWait({
      rules: {
        status: 0,
        stdout: JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "ci" }] },
            },
          ],
        ]),
        stderr: "",
      },
    }),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [] });
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

/** Runs one wait on a fake clock against scripted reads and PR heads. */
function pinned({
  reads,
  heads,
  head,
  timeoutSeconds = 60,
  all = false,
  commits,
  requiredContexts,
  ...sources
}) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds,
    all,
    head,
    gh: scriptedGh(reads, { all, heads, commits, required: requiredContexts, ...sources }),
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

/**
 * A `gh` whose commit reads fail as `fail(n)` says, for the nth such read. A failure is the whole
 * result of the failed `gh api --paginate --include` read: `{ status, stdout, stderr }`, with the
 * status block of the reply on stdout. A reply with status 0 is a read that exits 0 with that
 * stdout. Every other read passes through. `commitReads` lists the endpoint of each commit read
 * and `readArgs` its arguments.
 */
function failingCommitGh(fail, { all = false, heads } = {}) {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
    all,
    heads,
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  const commitReads = [];
  const readArgs = [];
  const gh = async (args, cwd, options) => {
    if (args[0] === "api" && args[1].includes("/commits/")) {
      commitReads.push(args[1]);
      readArgs.push(args);
      const reply = fail(commitReads.length);
      if (reply) {
        return reply;
      }
    }
    return inner(args, cwd, options);
  };
  return { gh, commitReads, readArgs };
}

/** The status block `gh api --include` prints for a reply of status `code`, then `body`. */
const blockOf = (code, body = "{}") =>
  `HTTP/2.0 ${code} Status\r\nContent-Type: application/json\r\n\r\n${body}`;

/** The failed `gh api --include` read of status `code`: the status block on stdout, the error text on stderr. */
function replyOf(code, stderr, body = "{}") {
  return { status: 1, stdout: blockOf(code, body), stderr };
}

const serverError = (code) => replyOf(code, `gh: HTTP ${code}`);

function waitOn(gh, all, head = null) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    all,
    head,
    gh,
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies a GitHub 5xx on one commit read does not end the wait: the next poll
// reads again and a passing read settles the wait inside the bound, for the check-run read and
// the status read, in both modes (issue #1025).
test.each([
  ["required", "check-runs", 500, false, 1],
  ["all", "check-runs", 502, true, 1],
  ["required", "status", 503, false, 2],
  ["all", "status", 504, true, 2],
])(
  "waitChecks %s mode retries a %s read that fails with HTTP %i",
  async (_mode, _endpoint, code, all, failingRead) => {
    // The check-runs read comes first in a poll, then the status read.
    const { gh, commitReads } = failingCommitGh((n) => n === failingRead && serverError(code), {
      all,
    });
    expect(await waitOn(gh, all)).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
    expect(commitReads.length).toBeGreaterThan(2);
  },
);

// Usefulness: verifies a 5xx on every poll until the bound is an error that names the last
// failure, never a pass and never a timeout envelope (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode reports an error when every poll fails with HTTP 5xx",
  async (_mode, all) => {
    const { gh, commitReads } = failingCommitGh(() => serverError(500), { all });
    await expect(waitOn(gh, all)).rejects.toThrow(
      /gh api repos\/owner\/repo\/commits\/.+ failed: gh: HTTP 500/,
    );
    expect(commitReads.length).toBeGreaterThan(1);
  },
);

// Usefulness: verifies the commit read is the paginated `gh api` read with `--include` and no
// other request, so the failing request itself reports its status, `gh` owns pagination, and no
// separate classifying request runs (issue #1025).
test("waitChecks reads each commit endpoint once with --paginate --include", async () => {
  const endpoint = `repos/owner/repo/commits/${HEAD_A}/check-runs`;
  const { gh, commitReads, readArgs } = failingCommitGh((n) => n === 1 && serverError(500));
  expect(await waitOn(gh, false)).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
  expect(readArgs[0]).toEqual(["api", endpoint, "--paginate", "--include"]);
  expect(commitReads.filter((read) => read === endpoint)).toHaveLength(2);
});

// Usefulness: verifies the pages of a successful `--paginate --include` read are joined into the
// array that the slurped read gave, so a check run on a later page is judged and a failure there
// settles the wait, in both modes (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode joins the pages of a paginated read", async (_mode, all) => {
  const run = (id, conclusion, at) => ({
    id,
    name: "ci",
    status: "completed",
    conclusion,
    started_at: at,
    completed_at: at,
  });
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
    all,
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  const gh = async (args, cwd, options) => {
    if (args[0] === "api" && args[1].endsWith("/check-runs")) {
      const link = 'Link: <https://api.github.com/next>; rel="next"\r\n';
      return {
        status: 0,
        stdout:
          `HTTP/2.0 200 OK\r\n${link}\r\n${JSON.stringify({ check_runs: [run(1, "success", "2026-01-01T00:00:00Z")] })}\n` +
          `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ check_runs: [run(2, "failure", "2026-01-01T00:05:00Z")] })}`,
        stderr: "",
      };
    }
    return inner(args, cwd, options);
  };
  expect(await waitOn(gh, all)).toEqual({ timedOut: false, head: HEAD_A, checks: [FAILED_ITEM] });
});

// Usefulness: verifies only a failed read whose final status block is exactly 500, 502, 503, or
// 504 is retried. The status comes from the status block that `gh` wrote for the failing reply,
// never from the error text, so a 4xx or a 501 stays terminal whatever its body or message says,
// and so does a failure with no status block and a success whose body fails to parse (issue #1025).
test.each([
  ["a 404", replyOf(404, "gh: Not Found (HTTP 404)"), /HTTP 404/],
  ["an HTTP 501", replyOf(501, "gh: Not Implemented (HTTP 501)"), /HTTP 501/],
  [
    "a failure with no status block",
    { status: 1, stdout: "", stderr: "gh: could not reach api.github.com (HTTP 500)" },
    /could not reach/,
  ],
  [
    "a status line that is no status block",
    { status: 1, stdout: "Server Error\r\n\r\n{}", stderr: "gh: HTTP 500" },
    /HTTP 500/,
  ],
  [
    "a success body that fails to parse",
    { status: 0, stdout: blockOf(200, "<html>"), stderr: "" },
    /JSON/,
  ],
  ["a success with no status block", { status: 0, stdout: "[]", stderr: "" }, /status block/],
])("waitChecks does not retry %s on a commit read", async (_name, reply, message) => {
  const { gh, commitReads } = failingCommitGh(() => reply);
  await expect(waitOn(gh, false)).rejects.toThrow(message);
  expect(commitReads).toHaveLength(1);
});

// Usefulness: verifies a 4xx reply is never retryable, whatever text its body or its error holds:
// an errors array that quotes a 500, lowercase, extra-space, and split-line forms of that quote, a
// 502 inside the body text, and a 403 whose message ends in a status are all terminal, in both
// modes, so message text the server supplies never makes a 4xx a retry (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode never retries a 4xx whatever its text says", async (_mode, all) => {
  const forbidden = (errors, stderr) => replyOf(403, stderr, JSON.stringify({ errors }));
  const replies = [
    forbidden(
      ["Forbidden (403)", "upstream replied HTTP 500"],
      "gh: Forbidden (403)\nupstream replied HTTP 500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied http 500"],
      "gh: Forbidden (403)\nupstream replied http 500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied HTTP  500"],
      "gh: Forbidden (403)\nupstream replied HTTP  500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied HTTP\n500"],
      "gh: Forbidden (403)\nupstream replied HTTP\n500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied (HTTP 500)"],
      "gh: upstream replied (HTTP 500)\naccess denied (HTTP 403)",
    ),
    forbidden(["x\nHTTP/1.1 502 Bad Gateway\r\n\r\n"], "gh: x\nHTTP/1.1 502 Bad Gateway"),
  ];
  for (const reply of replies) {
    const { gh, commitReads } = failingCommitGh((n) => n === 1 && reply, { all });
    await expect(waitOn(gh, all)).rejects.toThrow(/gh api/);
    expect(commitReads).toHaveLength(1);
  }
});

// Usefulness: verifies a retryable reply is retried whatever its error text looks like, since the
// status block decides: the message form, a multi-line message, and a trailing hint line (issue #1025).
test.each([
  ["the message form", "gh: Server Error (HTTP 502)"],
  ["a multi-line message", "gh: Bad Gateway\nupstream detail one\nupstream detail two (HTTP 502)"],
  ["a quoted 404", "gh: upstream said not found (HTTP 404)\nBad Gateway (HTTP 502)"],
  ["a trailing hint line", "gh: Bad Gateway (HTTP 502)\nAuthorize in your web browser: https://x"],
])("waitChecks retries a 502 reply with %s", async (_name, stderr) => {
  const { gh } = failingCommitGh((n) => n === 1 && replyOf(502, stderr));
  expect(await waitOn(gh, false)).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a server error of an earlier poll is dropped once a later poll completes, so
// a head that never reaches `--head` ends at the bound with `timedOut: true`, `head: null`, and no
// checks, never the earlier error, in both modes (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode clears a server error when a later poll completes", async (_mode, all) => {
  const { gh } = failingCommitGh((n) => n === 1 && serverError(500), {
    all,
    heads: [HEAD_A, HEAD_B],
  });
  expect(await waitOn(gh, all, HEAD_A)).toEqual({ timedOut: true, head: null, checks: [] });
});

// Usefulness: verifies the failed read is classified on the final status block of its stdout, the
// reply that ends the exchange: an earlier page, an interim block, or a proxy block before it never
// decides, so a final 502 is retried and a final 403 stays terminal whatever block came first
// (issue #1025).
test.each([
  [
    "a 200 page then a 502",
    `${blockOf(200, '{"check_runs":[]}')}\n${blockOf(502, "<html>")}`,
    true,
  ],
  ["a 200 block then a 502", "HTTP/1.1 200 OK\r\n\r\nHTTP/1.1 502 Bad Gateway\r\n\r\n", true],
  ["a 100 block then a 503", "HTTP/1.1 100 Continue\r\n\r\nHTTP/2 503 Unavailable\r\n\r\n{}", true],
  ["a 200 page then a 403", `${blockOf(200, '{"check_runs":[]}')}\n${blockOf(403)}`, false],
  [
    "a 502 block then a 403",
    "HTTP/1.1 502 Bad Gateway\r\n\r\nHTTP/1.1 403 Forbidden\r\n\r\n{}",
    false,
  ],
  ["a 502 block then a 200", "HTTP/1.1 502 Bad Gateway\r\n\r\nHTTP/2 200 OK\r\n\r\n{}", false],
])("waitChecks classifies a reply of %s on its final status", async (_name, stdout, retried) => {
  const { gh, commitReads } = failingCommitGh(
    (n) => n === 1 && { status: 1, stdout, stderr: "gh: HTTP 502" },
  );
  if (retried) {
    expect(await waitOn(gh, false)).toEqual({
      timedOut: false,
      head: HEAD_A,
      checks: [PASSED_ITEM],
    });
  } else {
    await expect(waitOn(gh, false)).rejects.toThrow(/gh api/);
    expect(commitReads).toHaveLength(1);
  }
});

// Usefulness: verifies a failure that `gh pr checks` lists on a later poll survives the bound that
// a commit read reaches after an earlier server error, in both modes: the result is
// `timedOut: true` with `prFailures`, never the earlier error (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode keeps a listed failure past a bound after a server error",
  async (_mode, all) => {
    const inner = scriptedGh(
      [
        { status: 0, checks: [PASSED_ITEM] },
        { status: 1, checks: [FAILED_ITEM] },
      ],
      { all, commits: { [HEAD_A]: [PASSED_ITEM] } },
    );
    let commitReads = 0;
    const gh = (args, cwd, options) => {
      if (args[0] === "api" && args[1].includes("/commits/")) {
        commitReads += 1;
        return commitReads === 1 ? Promise.resolve(serverError(500)) : new Promise(() => {});
      }
      return inner(args, cwd, options);
    };
    const result = await waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 0.3,
      all,
      gh,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ timedOut: true, checks: [], prFailures: [FAILED_ITEM] });
  },
  20000,
);

// Usefulness: verifies a commit read that never answers, after a 5xx, ends the wait at the bound
// with an error and never as a timeout or a pass: a hung read stays terminal (issue #1025).
test("waitChecks ends with the earlier error when the next commit read hangs", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  let commitReads = 0;
  const gh = (args, cwd, options) => {
    if (args[0] === "api" && args[1].includes("/commits/")) {
      commitReads += 1;
      return commitReads === 1 ? Promise.resolve(serverError(500)) : new Promise(() => {});
    }
    return inner(args, cwd, options);
  };
  await expect(
    waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 0.3, gh, sleep: async () => {} }),
  ).rejects.toMatchObject({ message: expect.stringContaining("failed: gh: HTTP 500") });
}, 20000);

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

const FORBIDDEN = {
  status: 1,
  stdout: "",
  stderr: "gh: Resource not accessible by integration (HTTP 403)",
};
const NOT_FOUND = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };

// Usefulness: verifies a required-check source that cannot be resolved never yields a pass:
// an unreadable ruleset or protection source, a reply that cannot be parsed, and a failed
// read of the required names each end the required wait with an error before any state is
// judged (issue #961).
test.each([
  ["an unreadable ruleset source", { rules: FORBIDDEN }, /repository rulesets/],
  ["an unreadable protection source", { protection: NOT_FOUND }, /classic branch protection/],
  [
    "a ruleset reply that cannot be parsed",
    { rules: { status: 0, stdout: "not json", stderr: "" } },
    /repository rulesets/,
  ],
  [
    "a failed read of the required names",
    { names: { status: 1, stdout: "", stderr: "boom" } },
    /required check names/,
  ],
])("waitChecks refuses %s", async (_name, sources, message) => {
  await expect(
    pinned({
      reads: [{ status: 0, checks: [PASSED_ITEM] }],
      heads: [HEAD_A],
      commits: { [HEAD_A]: [PASSED_ITEM] },
      ...sources,
    }),
  ).rejects.toThrow(message);
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

// Usefulness: verifies every unconfirmed child of a poll sets `childExitUnconfirmed`, not
// only the read that failed first: the ruleset read exits on the bound while the sibling
// protection read never does (issue #961).
test("waitChecks reports an unconfirmed child of a sibling source read", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  const gh = (args, cwd, options = {}) => {
    if (args[0] === "api" && args[1].includes("/rules/branches/")) {
      // Exits once the bound stops it.
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () =>
          resolve({ status: 1, stdout: "", stderr: "stopped" }),
        );
      });
    }
    if (args[0] === "api" && args[1].includes("/protection")) {
      // Never exits, as a hung child does.
      return new Promise(() => {});
    }
    return inner(args, cwd, options);
  };
  const result = await waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 0.3, gh });
  expect(result).toMatchObject({ timedOut: true, childExitUnconfirmed: true });
}, 20000);

// Usefulness: verifies an unresolved required-check source never delays a failure that
// `gh pr checks` lists: the wait settles on the listed failure instead of an error (issue #961).
test("waitChecks settles on a listed failure although a source cannot be read", async () => {
  expect(
    await pinned({
      reads: [{ status: 1, checks: [FAILED_ITEM] }],
      heads: [HEAD_A],
      commits: { [HEAD_A]: [PASSED_ITEM] },
      protection: NOT_FOUND,
    }),
  ).toEqual({ timedOut: false, head: null, checks: [], prFailures: [FAILED_ITEM] });
});

/** A `gh` whose commit reads, and a sibling source read, never exit, behind one scripted `gh pr checks`. */
function hangingGh(reads, { all = false } = {}) {
  const inner = scriptedGh(reads, { all });
  return (args, cwd, options) =>
    args[0] === "api" && args[1].includes("/commits/")
      ? new Promise(() => {})
      : inner(args, cwd, options);
}

// Usefulness: verifies a failure that `gh pr checks` listed survives a bound that a later commit
// read reaches: the result is `timedOut: true` with the failure in `prFailures`, never an empty
// result, in both modes (issue #961).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode keeps a listed failure past the bound",
  async (_mode, all) => {
    const result = await waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 0.3,
      all,
      gh: hangingGh([{ status: 1, checks: [FAILED_ITEM] }], { all }),
    });
    expect(result).toMatchObject({
      timedOut: true,
      head: null,
      checks: [],
      prFailures: [FAILED_ITEM],
    });
  },
  20000,
);

// Usefulness: verifies an error that ends a poll while a sibling read stays unconfirmed past the
// ceiling carries `childExitUnconfirmed`, so no envelope hides a child that may still run
// (issue #961).
test("waitChecks marks an error with the unconfirmed child of a sibling read", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  const gh = (args, cwd, options = {}) => {
    if (args[0] === "api" && args[1].includes("/rules/branches/")) {
      return Promise.resolve({ status: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" });
    }
    if (args[0] === "api" && args[1].includes("/protection")) {
      return new Promise(() => {});
    }
    return inner(args, cwd, options);
  };
  await expect(waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 0.3, gh })).rejects.toMatchObject({
    message: expect.stringContaining("HTTP 500"),
    childExitUnconfirmed: true,
  });
}, 20000);

// Usefulness: verifies a settled result carries `childExitUnconfirmed` when a sibling read of an
// earlier step in the poll stayed unconfirmed past the ceiling, so no envelope that settles hides
// a `gh` child that may still run (issue #961).
test("waitChecks marks a settled result with an unconfirmed sibling child", async () => {
  const inner = scriptedGh([{ status: 1, checks: [FAILED_ITEM] }], {
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  const gh = (args, cwd, options = {}) => {
    if (args[0] === "api" && args[1].includes("/rules/branches/")) {
      return Promise.resolve({ status: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" });
    }
    if (args[0] === "api" && args[1].includes("/protection")) {
      return new Promise(() => {});
    }
    return inner(args, cwd, options);
  };
  expect(await waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 0.3, gh })).toEqual({
    timedOut: false,
    head: null,
    checks: [],
    prFailures: [FAILED_ITEM],
    childExitUnconfirmed: true,
  });
}, 20000);

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
