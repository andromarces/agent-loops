import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import { pageStdout } from "../gh-doubles.mjs";
import {
  fakeClock,
  HEAD_A,
  scriptedGh,
  check,
  PENDING_ITEM,
  PASSED_ITEM,
  FAILED_ITEM,
  once,
  pinned,
  blockOf,
  FORBIDDEN,
  NOT_FOUND,
} from "./check-wait-helpers.mjs";

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
  rules: { status: 0, stdout: pageStdout([{ type: "deletion" }]), stderr: "" },
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
        stdout: pageStdout([
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci" }] },
          },
        ]),
        stderr: "",
      },
    }),
  ).toEqual({ timedOut: true, head: HEAD_A, checks: [] });
});

/** Runs one required wait whose `gh pr checks --required` answers that no check has reported. */
function noChecksReportedWait(sources) {
  const clock = fakeClock();
  const calls = [];
  const gh = scriptedGh(
    [{ status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch\n" }],
    sources,
  );
  return {
    clock,
    calls,
    result: waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 300,
      gh: async (args, cwd) => {
        calls.push(args);
        return gh(args, cwd);
      },
      now: clock.now,
      sleep: clock.sleep,
    }),
  };
}

// Usefulness: verifies a required wait that reads `no checks reported` refuses on the first poll
// while no required-check source can state the required checks, instead of waiting out its bound
// on a repository where no check can report (issue #1091).
test("waitChecks refuses no-checks-reported at once when every required source is unreadable", async () => {
  const wait = noChecksReportedWait({
    rules: { status: 1, stdout: "", stderr: FREE_PLAN },
    protection: { status: 1, stdout: "", stderr: FREE_PLAN },
  });
  await expect(wait.result).rejects.toThrow(
    /gh pr checks 42 --required reported no checks.*repository rulesets and classic branch protection did not state/,
  );
  expect(wait.clock.elapsed()).toBe(0);
});

// Usefulness: verifies #941 holds beside a readable source: a source that states the absence of a
// required check, or names one that has not reported, keeps the wait running to the bound.
test.each([
  [
    "sources that state an absence",
    {
      ...ABSENT_SOURCES,
      protection: { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" },
    },
  ],
  [
    "a ruleset that names a required check",
    {
      rules: {
        status: 0,
        stdout: pageStdout([
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci" }] },
          },
        ]),
        stderr: "",
      },
    },
  ],
])("waitChecks keeps waiting on no-checks-reported over %s", async (_name, sources) => {
  expect(await noChecksReportedWait(sources).result).toEqual({
    timedOut: true,
    head: HEAD_A,
    checks: [],
  });
});

// Usefulness: verifies a source that cannot be read never ends the no-checks-reported wait while
// the other source names a check or states the absence, whatever the unreadable one returned, so
// #941 holds beside a malformed reply (issue #1091).
test.each([
  ["a protection source that states the absence", () => ({})],
  [
    "a protection source that names a check",
    () => ({
      protection: {
        status: 0,
        stdout: blockOf(200, JSON.stringify({ required_status_checks: { contexts: ["ci"] } })),
        stderr: "",
      },
    }),
  ],
])(
  "waitChecks keeps waiting on no-checks-reported beside a malformed ruleset reply and %s",
  async (_name, other) => {
    expect(
      await noChecksReportedWait({
        rules: { status: 0, stdout: "not json", stderr: "" },
        ...other(),
      }).result,
    ).toEqual({ timedOut: true, head: HEAD_A, checks: [] });
  },
);

/** Runs one required wait over `reads`, and records the `gh` calls it makes. */
async function recordedRequiredWait(reads, sources = {}) {
  const clock = fakeClock();
  const calls = [];
  const inner = scriptedGh(reads, sources);
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    gh: async (args, cwd, options) => {
      calls.push(args);
      return inner(args, cwd, options);
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  return { result, calls };
}

const isRequiredChecksRead = (args) =>
  args[0] === "pr" && args[1] === "checks" && args.includes("--required");

// Usefulness: verifies each poll of a required wait reads `gh pr checks --required` once, so the
// required names come from the same read as the check list and the poll costs no second `gh` call
// (issue #1125).
test.each([
  [
    "a pending poll then a pass",
    [
      { status: 8, checks: [PENDING_ITEM] },
      { status: 0, checks: [PASSED_ITEM] },
    ],
    2,
  ],
  [
    "a no-checks-reported poll then a pass",
    [
      { status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch\n" },
      { status: 0, checks: [PASSED_ITEM] },
    ],
    2,
  ],
  [
    "a no-required-checks answer",
    [{ status: 1, stdout: "", stderr: "no required checks reported on the 'main' branch\n" }],
    1,
  ],
])("waitChecks reads the required checks once per poll over %s", async (_name, reads, polls) => {
  const { calls } = await recordedRequiredWait(reads, ABSENT_SOURCES);
  expect(calls.filter(isRequiredChecksRead)).toHaveLength(polls);
});

// Usefulness: verifies the check runs and the commit statuses of a head are read together, so a poll
// does not pay the two latencies one after the other (issue #1125).
test("waitChecks reads the check runs and commit statuses of the head together", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }]);
  const clock = fakeClock();
  let inFlight = 0;
  let peak = 0;
  const gh = async (args, cwd, options) => {
    const commitRead = args[0] === "api" && String(args[1]).includes("/commits/");
    if (!commitRead) {
      return inner(args, cwd, options);
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await inner(args, cwd, options);
    } finally {
      inFlight -= 1;
    }
  };
  await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh,
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(peak).toBe(2);
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

// Usefulness: verifies a required-check source that cannot be resolved never yields a pass:
// an unreadable ruleset or protection source and a reply that cannot be parsed each end the required wait with an error before any state is
// judged (issue #961).
test.each([
  ["an unreadable ruleset source", { rules: FORBIDDEN }, /repository rulesets/],
  ["an unreadable protection source", { protection: NOT_FOUND }, /classic branch protection/],
  [
    "a ruleset reply that cannot be parsed",
    { rules: { status: 0, stdout: "not json", stderr: "" } },
    /repository rulesets/,
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

/** One wait over a required list that names `" ci "`, with `runs` the check runs of the PR head. */
function waitPaddedRequired(runs) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh: scriptedGh([{ status: 0, checks: [check(" ci ", "pass", "SUCCESS")] }], {
      commits: { [HEAD_A]: runs },
    }),
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies #1182 changes no result — a required name that the list pads stays required as
// written, so a run of the trimmed name alone does not satisfy it and the wait does not pass.
test("waitChecks does not pass a padded required name on the run of the trimmed name", async () => {
  expect((await waitPaddedRequired([PASSED_ITEM])).timedOut).toBe(true);
});

// Usefulness: verifies #1182 changes no result — the padded required name and its trimmed form are
// both required, so the wait passes once a run carries each name.
test("waitChecks passes a padded required name once a run carries each name", async () => {
  const result = await waitPaddedRequired([PASSED_ITEM, check(" ci ", "pass", "SUCCESS")]);
  expect(result.timedOut).toBe(false);
});
