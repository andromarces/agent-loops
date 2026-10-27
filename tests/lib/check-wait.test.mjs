import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import { fakeClock, HEAD_A, HEAD_B, pageStdout, scriptedGh } from "../runtime-helpers.mjs";

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

/**
 * One required wait whose first poll reads `no checks reported` and whose second lists a pass, with
 * `failing` ("rules" or "protection") answering its first read with HTTP `code`.
 */
function noChecksThenPassWait(failing, code) {
  const inner = scriptedGh([
    { status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch\n" },
    { status: 0, checks: [PASSED_ITEM] },
  ]);
  const clock = fakeClock();
  const fails = (args) =>
    args[0] === "api" &&
    args[1].includes(failing === "rules" ? "/rules/branches/" : "/branches/main/protection");
  let failedOnce = false;
  const gh = async (args, cwd, options) => {
    if (fails(args) && (code === 0 || !failedOnce)) {
      failedOnce = true;
      return serverError(code === 0 ? 503 : code);
    }
    return inner(args, cwd, options);
  };
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh,
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies a retryable server error on either configuration source of the
// no-checks-reported read is retried on the next poll, as the wait retries a commit read, so the
// wait settles inside its bound instead of exiting on the first poll (issue #1091).
test.each([
  ["rules", 503],
  ["rules", 500],
  ["protection", 503],
  ["protection", 502],
])("waitChecks retries a %s source read that fails with HTTP %i", async (failing, code) => {
  expect(await noChecksThenPassWait(failing, code)).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [PASSED_ITEM],
  });
});

// Usefulness: verifies a retryable server error on every poll to the bound is an error that names
// the failure, never a timeout envelope and never a pass (issue #1091).
test.each(["rules", "protection"])(
  "waitChecks reports an error when the %s source read fails with HTTP 503 until the bound",
  async (failing) => {
    await expect(noChecksThenPassWait(failing, 0)).rejects.toThrow(/HTTP 503/);
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

const PR_READS = {
  head: (args) => args[0] === "pr" && args[1] === "view",
  checks: (args) => args[0] === "pr" && args[1] === "checks" && args.at(-1) === "name,state,bucket",
};

/**
 * One required wait whose passing `gh pr` read named by `which` ("head" or "checks")
 * answers with `failure` on its first call, or on every call when `always` is set. `stdout` and
 * `reads` replace the empty output and the scripted check list reads. `result` is the wait, and
 * `attempts()` counts the failing reads it made.
 */
function prReadFailsWait(
  which,
  failure,
  { always = false, stdout = "", reads = [{ status: 0, checks: [PASSED_ITEM] }] } = {},
) {
  const inner = scriptedGh(reads);
  const clock = fakeClock();
  let failures = 0;
  const gh = async (args, cwd, options) => {
    if (PR_READS[which](args) && (always || failures === 0)) {
      failures += 1;
      return { status: 1, stdout, stderr: failure, timedOut: false };
    }
    return inner(args, cwd, options);
  };
  return {
    result: waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 60,
      gh,
      now: clock.now,
      sleep: clock.sleep,
    }),
    attempts: () => failures,
  };
}

const GRAPHQL_504 = "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)\n";
const GRAPHQL_502 = "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)\n";

// Usefulness: verifies a server error of any `gh` pr read of a poll is retried on the next poll, so
// the wait ends in the check result instead of an error that gives the parent no check evidence
// (issue #1121).
test.each([
  ["the head read (HTTP 504)", "head", GRAPHQL_504],
  ["the check list read (HTTP 502)", "checks", GRAPHQL_502],
  ["the check list read (HTTP 504)", "checks", GRAPHQL_504],
])("waitChecks retries %s that fails with a server error", async (_name, which, failure) => {
  expect(await prReadFailsWait(which, failure).result).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [PASSED_ITEM],
  });
});

// Usefulness: verifies a server error that lasts to the bound is an error that names the server
// error, after the wait read again on each poll, never a timeout envelope and never a pass
// (issues #1025, #1121).
test.each([
  ["head", /gh pr view 42 could not be read: HTTP 504: 504 Gateway Timeout/, undefined],
  ["checks", /gh pr checks 42 --required could not be read: HTTP 504: 504 Gateway/, undefined],
])(
  "waitChecks reports an error when the %s read fails with a server error until the bound",
  async (which, message, reads) => {
    const wait = prReadFailsWait(which, GRAPHQL_504, { always: true, ...(reads ? { reads } : {}) });
    await expect(wait.result).rejects.toThrow(message);
    expect(wait.attempts()).toBeGreaterThan(1);
  },
);

// Usefulness: verifies the acceptance item that a 4xx reply of each `gh pr` read still ends the wait
// at once, after the one read (issue #1121).
test.each(["head", "checks"])("waitChecks ends at once on a 404 of the %s read", async (which) => {
  const wait = prReadFailsWait(which, "HTTP 404: Not Found (https://api.github.com/graphql)\n");
  await expect(wait.result).rejects.toThrow(/could not be read/);
  expect(wait.attempts()).toBe(1);
});

// Usefulness: verifies the acceptance item that an unparseable reply still ends the wait at once
// even when the failed read also names HTTP 504, so only a clean server error is retried
// (issue #1121).
test.each(["head", "checks"])(
  "waitChecks ends at once when the %s read fails with HTTP 504 and an unparseable reply",
  async (which) => {
    const wait = prReadFailsWait(which, GRAPHQL_504, { stdout: "<html>Gateway Timeout</html>" });
    await expect(wait.result).rejects.toThrow();
    expect(wait.attempts()).toBe(1);
  },
);

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

// A poll reads the check runs and the commit statuses together, so a wait that does not retry a failed
// read makes exactly these two commit reads.
const COMMIT_READS_PER_POLL = 2;

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

const RUN_AT = (minute) => `2026-01-01T00:0${minute}:00Z`;
const runEntry = (id, name, conclusion, minute) => ({
  id,
  name,
  status: "completed",
  conclusion,
  started_at: RUN_AT(minute),
  completed_at: RUN_AT(minute),
});

/**
 * A `gh` whose check-run endpoint answers page `n` with `pages[n - 1]`, a JSON value or a raw
 * stdout string, and fails a page that no entry names. Every other read passes through.
 * `requests` lists the page numbers asked for.
 */
function pagedCheckRunsGh(pages, { all = false } = {}) {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], { all });
  const requests = [];
  const gh = async (args, cwd, options) => {
    const page = /\/check-runs\?per_page=100&page=(\d+)$/.exec(args[1] ?? "");
    if (args[0] !== "api" || !page) {
      return inner(args, cwd, options);
    }
    requests.push(Number(page[1]));
    const entry = pages[Number(page[1]) - 1];
    if (entry === undefined) {
      return replyOf(404, "gh: Not Found (HTTP 404)");
    }
    return {
      status: 0,
      stdout: typeof entry === "string" ? entry : blockOf(200, JSON.stringify(entry)),
      stderr: "",
    };
  };
  return { gh, requests };
}

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

// Usefulness: verifies only a failed read whose first-line status is exactly 500, 502, 503, or
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
  expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
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
    expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
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

// Usefulness: verifies the status comes from the structure of stdout, not from a scan for status-like
// text: a real 403 whose plain-text body holds a forged `HTTP/2 502` block, with or without text
// before it, stays terminal in both modes, because a 4xx exchange with no JSON body cannot be
// followed by another status block (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode never retries a 403 whose body forges a status block",
  async (_mode, all) => {
    const forged = "HTTP/2 502 Bad Gateway\r\nX-Forged: yes\r\n\r\n";
    const bodies = [forged, `{}\n${forged}`, `denied\n${forged}`, `${forged}${forged}`];
    for (const body of bodies) {
      const { gh, commitReads } = failingCommitGh(
        (n) => n === 1 && replyOf(403, "gh: HTTP 403", body),
        {
          all,
        },
      );
      await expect(waitOn(gh, all)).rejects.toThrow(/gh api/);
      expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
    }
  },
);

// Usefulness: verifies only a body that is empty or exactly one JSON value is accepted: a 502 with
// an empty body or a JSON body is retried, and a 502 with an HTML or plain-text body is terminal,
// the accepted fail-closed cost (issue #1025).
test.each([
  ["an empty body", "", true],
  ["a JSON object body", '{"message":"Bad Gateway"}', true],
  ["a JSON string body", '"Bad Gateway"', true],
  ["an HTML body", "<html><body>502 Bad Gateway</body></html>", false],
  ["a plain-text body", "Bad Gateway", false],
  ["a JSON body followed by text", '{"message":"x"}\ntrailing', false],
])("waitChecks classifies a 502 with %s", async (_name, body, retried) => {
  const { gh, commitReads } = failingCommitGh((n) => n === 1 && replyOf(502, "gh: HTTP 502", body));
  if (retried) {
    expect(await waitOn(gh, false)).toEqual({
      timedOut: false,
      head: HEAD_A,
      checks: [PASSED_ITEM],
    });
  } else {
    await expect(waitOn(gh, false)).rejects.toThrow(/gh api/);
    expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
  }
});

// Usefulness: verifies the status is the first line of stdout only: a 200 or a 502 first line
// followed by other blocks, or a 403 followed by a forged 502 block, never lets a later block decide,
// so only a first line of 500, 502, 503, or 504 with an empty or JSON remainder is retried
// (issue #1025).
test.each([
  ["a 403 then a forged 502 block", `${blockOf(403, "{}\n")}${blockOf(502, "")}`],
  ["a 200 then a 502 block", `${blockOf(200, "")}${blockOf(502, "")}`],
  ["a 502 then a forged 200 block", `${blockOf(502, "")}${blockOf(200, "{}")}`],
  ["a 100 then a 503 block", `HTTP/1.1 100 Continue\r\n\r\n${blockOf(503, "{}")}`],
])("waitChecks takes the status of %s from the first line", async (_name, stdout) => {
  const { gh, commitReads } = failingCommitGh(
    (n) => n === 1 && { status: 1, stdout, stderr: "gh: HTTP 502" },
  );
  await expect(waitOn(gh, false)).rejects.toThrow(/gh api/);
  expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
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
        // The first poll reads the check runs and the statuses together: the first read fails, the
        // second passes. Every later read hangs.
        if (commitReads === 1) {
          return Promise.resolve(serverError(500));
        }
        if (commitReads > COMMIT_READS_PER_POLL) {
          return new Promise(() => {});
        }
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
      // The first poll reads the check runs and the statuses together: the first read fails, the
      // second passes. Every later read hangs.
      if (commitReads === 1) {
        return Promise.resolve(serverError(500));
      }
      if (commitReads > COMMIT_READS_PER_POLL) {
        return new Promise(() => {});
      }
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

// The `--all` wait's no-check-source early return (issue #1054). After the PR head itself showed no
// check run and no commit status, the probe pins the base SHA, then reads the files of the PR, the
// workflow files at that SHA, and the check runs and commit statuses of the base head. A failed,
// unparseable, unvalidated, incomplete, or moved read keeps the normal wait, so the helper fails one
// endpoint on demand.
const BASE_HEAD = "c".repeat(40);
const OTHER_BASE_HEAD = "d".repeat(40);
const NO_CHECKS_YET = {
  status: 1,
  stdout: "",
  checks: [],
  stderr: "no checks reported on the 'main' branch",
};
const readOk = (body) => ({ status: 0, stdout: pageStdout(body), stderr: "", timedOut: false });
const PROBE_NOT_FOUND = {
  status: 1,
  stdout: 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
  stderr: "gh: Not Found (HTTP 404)",
  timedOut: false,
};
const INERT_WORKFLOW =
  "name: nightly\non:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'\n";
const BASE_RUN = {
  id: 1,
  name: "app-ci",
  status: "completed",
  conclusion: "success",
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:01:00Z",
};
const BASE_STATUS = {
  id: 1,
  context: "ci/external",
  state: "success",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const PENDING_STATUS = { ...BASE_STATUS, id: 9, state: "pending" };
const MERGED_HEAD = "e".repeat(40);
const TIED_HEAD = "f".repeat(40);
const MERGED_PR = {
  number: 7,
  merged_at: "2026-01-01T00:00:00Z",
  base: { ref: "main" },
  head: { sha: MERGED_HEAD },
};

/** A workflow file reply as the contents API sends it: base64 with a line break every 60 characters. */
function fileReply(text, over = {}) {
  const bytes = Buffer.from(text);
  return {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
    ...over,
  };
}

const http = (status, body, headers = "") =>
  `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n${headers}\r\n${typeof body === "string" ? body : JSON.stringify(body)}`;

/** A scripted `gh` for a PR with no check yet, plus the probe reads, each overridable or failing by endpoint prefix. */
function probeGh({
  prFiles = [{ filename: "README.md" }],
  workflows = { "nightly.yml": INERT_WORKFLOW },
  baseRuns = [],
  baseStatuses = [],
  mergedPrs = [],
  mergedRuns = [],
  mergedStatuses = [],
  tiedRuns = [],
  failing = null,
  reply = null,
  files = null,
  listing = null,
  baseShas = [BASE_HEAD],
  headItems = [],
  headStatuses = [],
  heads = [HEAD_A],
  all = true,
} = {}) {
  const inner = scriptedGh([NO_CHECKS_YET], {
    all,
    heads,
    commits: { [HEAD_A]: headItems },
    statuses: headStatuses,
  });
  const repo = "repos/owner/repo";
  let baseReads = 0;
  return async (args, cwd) => {
    const endpoint = args[0] === "api" ? args[1] : "";
    if (failing !== null && endpoint.startsWith(`${repo}/${failing}`)) {
      return { status: 1, stdout: "", stderr: "gh: Internal failure (HTTP 500)", timedOut: false };
    }
    if (reply !== null && endpoint.startsWith(`${repo}/${reply.endpoint}`)) {
      return reply.result;
    }
    const filesPage = /^repos\/owner\/repo\/pulls\/42\/files\?per_page=(\d+)&page=(\d+)$/.exec(
      endpoint,
    );
    if (filesPage) {
      const [size, page] = [Number(filesPage[1]), Number(filesPage[2])];
      return readOk(prFiles.slice((page - 1) * size, page * size));
    }
    if (endpoint === `${repo}/commits/main`) {
      return readOk({ sha: baseShas[Math.min(baseReads++, baseShas.length - 1)] });
    }
    if (endpoint === `${repo}/contents/.github/workflows?ref=${BASE_HEAD}`) {
      if (listing !== null) {
        return listing;
      }
      return workflows === null
        ? PROBE_NOT_FOUND
        : readOk(
            Object.keys(workflows).map((name) => ({
              name,
              path: `.github/workflows/${name}`,
              type: "file",
            })),
          );
    }
    const file =
      /^repos\/owner\/repo\/contents\/\.github\/workflows\/([^?]+)\?ref=([0-9a-f]+)$/.exec(
        endpoint,
      );
    if (file && file[2] === BASE_HEAD) {
      return readOk(files ?? fileReply(workflows[file[1]]));
    }
    if (endpoint.startsWith(`${repo}/commits/${BASE_HEAD}/check-runs`)) {
      return readOk({ total_count: baseRuns.length, check_runs: baseRuns });
    }
    if (endpoint.startsWith(`${repo}/commits/${BASE_HEAD}/status`)) {
      return readOk({ total_count: baseStatuses.length, statuses: baseStatuses });
    }
    if (endpoint.startsWith(`${repo}/commits/${BASE_HEAD}/pulls`)) {
      return readOk(mergedPrs);
    }
    if (endpoint.startsWith(`${repo}/commits/${MERGED_HEAD}/check-runs`)) {
      return readOk({ total_count: mergedRuns.length, check_runs: mergedRuns });
    }
    if (endpoint.startsWith(`${repo}/commits/${TIED_HEAD}/check-runs`)) {
      return readOk({ total_count: tiedRuns.length, check_runs: tiedRuns });
    }
    if (endpoint.startsWith(`${repo}/commits/${TIED_HEAD}/status`)) {
      return readOk({ total_count: 0, statuses: [] });
    }
    if (endpoint.startsWith(`${repo}/commits/${MERGED_HEAD}/status`)) {
      return readOk({ total_count: mergedStatuses.length, statuses: mergedStatuses });
    }
    return inner(args, cwd);
  };
}

function probedWait(options = {}, extra = {}) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    all: true,
    gh: probeGh(options),
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  }).then((result) => ({ result, elapsed: clock.elapsed() }));
}

// Usefulness: verifies the `--all` wait returns at once with `noCheckSource`, no timeout, and an
// empty `checks` when the PR head shows no check, the PR changes no workflow file, the base workflows
// hold no trigger that runs for the PR head, and the base head has no check run or commit status
// (issue #1054). A parent then skips the full bound without reading any workflow itself.
test("the --all wait returns noCheckSource at once when no source can report a check", async () => {
  const { result, elapsed } = await probedWait();
  expect(result).toEqual({ timedOut: false, noCheckSource: true, head: HEAD_A, checks: [] });
  expect(elapsed).toBe(0);
});

// Usefulness: verifies a base branch with no workflow directory counts as no workflow, so a
// repository with no CI at all skips the wait (issue #1054).
test("the --all wait returns noCheckSource when the base branch has no workflow directory", async () => {
  const { result } = await probedWait({ workflows: null });
  expect(result).toEqual({ timedOut: false, noCheckSource: true, head: HEAD_A, checks: [] });
});

// Usefulness: verifies the wait skips on a PR of 2,999 files, one under the cap of the files
// endpoint, so the cap rule below is not a blanket refusal of a large PR (issue #1054).
test("the --all wait returns noCheckSource for a PR just under the file cap", async () => {
  const prFiles = Array.from({ length: 2999 }, (_, i) => ({ filename: `src/f${i}.js` }));
  const { result } = await probedWait({ prFiles });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies an empty workflow file, which decodes to zero bytes with a matching size, is
// valid evidence of no trigger (issue #1054), so the validation does not reject a real empty file.
test("the --all wait accepts an empty workflow file with a matching size", async () => {
  const { result } = await probedWait({ files: fileReply("") });
  expect(result.noCheckSource).toBe(true);
});

const TRIGGERS = [
  "pull_request",
  "pull_request_target",
  "push",
  "merge_group",
  "workflow_run",
  "check_suite",
];

// Usefulness: verifies each condition and each failed read that keeps the normal wait: the wait
// runs to the bound with `timedOut: true`, an empty `checks`, and no `noCheckSource` (issue #1054).
// One row per condition, so a dropped condition fails its own row.
test.each([
  ["a PR file under .github/workflows", { prFiles: [{ filename: ".github/workflows/ci.yml" }] }],
  [
    "a PR file renamed out of .github/workflows",
    { prFiles: [{ filename: "ci.yml", previous_filename: ".github/workflows/ci.yml" }] },
  ],
  ...TRIGGERS.map((trigger) => [
    `a base workflow with a ${trigger} trigger`,
    { workflows: { "ci.yml": `on:\n  ${trigger}:\n    branches: [main]\n` } },
  ]),
  ["a base workflow with an inline trigger list", { workflows: { "ci.yml": "on: [push]\n" } }],
  ["a check run on the base head", { baseRuns: [BASE_RUN] }],
  ["a commit status on the base head", { baseStatuses: [BASE_STATUS] }],
  ["a failed PR files read", { failing: "pulls/42/files" }],
  ["a failed workflow listing read", { failing: "contents/.github/workflows?" }],
  ["a failed workflow file read", { failing: "contents/.github/workflows/nightly.yml" }],
  ["a failed base head read", { failing: "commits/main" }],
  ["a failed base head check-runs read", { failing: `commits/${BASE_HEAD}/check-runs` }],
  ["a failed base head status read", { failing: `commits/${BASE_HEAD}/status` }],
])("the --all wait keeps the normal wait for %s", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result).toMatchObject({ timedOut: true, checks: [] });
});

const FILTERED = (events) => `name: ci\non:\n${events}\njobs:\n  t:\n    runs-on: ubuntu-latest\n`;
const PR_PATHS = (...patterns) =>
  FILTERED(`  pull_request:\n    paths:\n${patterns.map((p) => `      - ${p}`).join("\n")}`);

// Usefulness: verifies a base workflow that only names path-filtered PR events, with no PR file
// matching any pattern, counts as unable to report, so the wait ends at once (issue #1065). One row
// per accepted shape, so a dropped shape fails its own row.
test.each([
  ["the workflow filter of the issue", PR_PATHS(".github/workflows/**", ".github/actionlint.yaml")],
  ["a quoted pattern and a trailing comment", PR_PATHS("'src/**'  # code", '"lib/*.js"')],
  [
    "pull_request_target with paths",
    FILTERED("  pull_request_target:\n    paths:\n      - 'src/**'"),
  ],
  [
    "both PR events with paths and a branch filter",
    FILTERED(
      "  pull_request:\n    branches: [main]\n    paths:\n      - src/**\n" +
        "  pull_request_target:\n    paths:\n      - src/**",
    ),
  ],
  ["a flow list of paths", FILTERED("  pull_request:\n    paths: [src/**, 'docs/*.md']")],
  ["a quoted on key", PR_PATHS("src/**").replace("on:", '"on":')],
  [
    "a flow map and a block scalar holding trigger text in the jobs",
    `${PR_PATHS("src/**")}  s:\n    env: { A: b }\n    steps:\n      - run: |\n          on:\n            push:\n`,
  ],
  [
    "a list at the indent of its key",
    FILTERED("  pull_request:\n    paths:\n    - src/**\n    - docs/*.md"),
  ],
])(
  "the --all wait returns noCheckSource for a path-filtered workflow with %s",
  async (_n, text) => {
    const { result, elapsed } = await probedWait({ workflows: { "ci.yml": text } });
    expect(result).toEqual({ timedOut: false, noCheckSource: true, head: HEAD_A, checks: [] });
    expect(elapsed).toBe(0);
  },
);

const MANY_FILES = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` }));

// Usefulness: verifies each case that keeps the wait for a path-filtered workflow (issue #1065): a
// PR file that matches a pattern, a rename whose old name matches, a `paths-ignore` filter, a
// pattern the matcher cannot settle, another event, a PR event with no `paths`, and a text that
// does not read as plain block YAML. One row per case, so a dropped rule fails its own row.
test.each([
  ["a PR file that matches a pattern", PR_PATHS("README.md"), {}],
  ["a PR file that matches a ** pattern", PR_PATHS("**.md"), {}],
  ["a PR file that matches a **/ pattern at the root", PR_PATHS("**/*.md"), {}],
  [
    "a PR file under a literal directory pattern",
    PR_PATHS("docs"),
    { prFiles: [{ filename: "docs/a.md" }] },
  ],
  [
    "a PR file renamed out of a matching path",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "README.md", previous_filename: "src/a.js" }] },
  ],
  ["a ! negation pattern", PR_PATHS("'src/**'", "'!src/x.js'"), {}],
  ["a character class pattern", PR_PATHS("'src/[ab].js'"), {}],
  ["a ? pattern", PR_PATHS("'src/a?.js'"), {}],
  ["a pattern that is a YAML alias", PR_PATHS("*.js"), {}],
  [
    "a push event beside the filtered PR event",
    FILTERED("  push:\n  pull_request:\n    paths:\n      - src/**"),
    {},
  ],
  [
    "a workflow_dispatch event beside the filtered PR event",
    FILTERED("  workflow_dispatch:\n  pull_request:\n    paths:\n      - src/**"),
    {},
  ],
  ["paths-ignore", FILTERED("  pull_request:\n    paths-ignore:\n      - README.md"), {}],
  [
    "paths and paths-ignore",
    FILTERED("  pull_request:\n    paths:\n      - src/**\n    paths-ignore:\n      - a"),
    {},
  ],
  ["a PR event with no paths", FILTERED("  pull_request:\n    branches: [main]"), {}],
  [
    "one PR event with paths and one without",
    FILTERED(
      "  pull_request:\n    paths:\n      - src/**\n  pull_request_target:\n    branches: [main]",
    ),
    {},
  ],
  ["an empty paths list", FILTERED("  pull_request:\n    paths:"), {}],
  ["a scalar on", "on: pull_request\n", {}],
  ["a later unclosed flow list", `${PR_PATHS("src/**")}jobs: [\n`, {}],
  [
    "an unterminated flow list in the event",
    "on:\n  pull_request:\n    branches: [main\n    paths:\n      - src/**\n",
    {},
  ],
  ["a second YAML document", `${PR_PATHS("src/**")}---\nname: second\n`, {}],
  ["a later unclosed quote", `${PR_PATHS("src/**")}name2: 'x\n`, {}],
  ["a YAML alias elsewhere", `x: &a [1]\n${PR_PATHS("src/**")}y: *a\n`, {}],
  ["a YAML tag", `${PR_PATHS("src/**")}z: !!python/object x\n`, {}],
  ["a !!str tag on a pattern", FILTERED("  pull_request:\n    paths: [!!str src/**]"), {}],
  ["a !!map tag on an event", FILTERED("  pull_request: !!map\n    paths: [src/**]"), {}],
  ["a !!seq tag on the paths list", FILTERED("  pull_request:\n    paths: !!seq [src/**]"), {}],
  ["a tag on the on map", `name: ci\non: !!map\n  pull_request:\n    paths: [src/**]\n`, {}],
  ["a tag far from the on block", `${PR_PATHS("src/**")}extra:\n  t: !!map\n    a: b\n`, {}],
  ["an unused anchor", FILTERED("  pull_request: &filter\n    paths: [src/**]"), {}],
  ["an anchor on a pattern", FILTERED("  pull_request:\n    paths: [&p src/**]"), {}],
  ["a non-string pattern", FILTERED("  pull_request:\n    paths:\n      - 12"), {}],
  [
    "a PR file name that ** matches across a newline",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "src/a\nb.js" }] },
  ],
  [
    "a PR file name with U+2028 that ** matches",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "src/a b.js" }] },
  ],
  [
    "a PR file name with a newline that no pattern matches",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "docs/a\nb.md" }] },
  ],
  [
    "a PR file name with a control character",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "docs/a\u0007.md" }] },
  ],
  [
    "a PR file name with a lone surrogate",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "docs/a\ud800.md" }] },
  ],
  [
    "a previous_filename that is not a string",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "README.md", previous_filename: 7 }] },
  ],
  ["a trigger name and no on block", "name: ci\njobs: {}\n# pull_request\n", {}],
  ["a tab indent", "on:\n\tpull_request:\n\t\tpaths:\n\t\t\t- src/**\n", {}],
  ["a duplicate on key", `${PR_PATHS("src/**")}on:\n  push:\n`, {}],
  ["a PR file list of 3,000", PR_PATHS("src/**"), { prFiles: MANY_FILES }],
  [
    "a PR file that changes a workflow",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: ".github/workflows/x.yml" }] },
  ],
])(
  "the --all wait keeps the normal wait for a path-filtered workflow with %s",
  async (_n, text, options) => {
    const { result } = await probedWait({ workflows: { "ci.yml": text }, ...options });
    expect(result.noCheckSource).toBeUndefined();
    expect(result).toMatchObject({ timedOut: true, checks: [] });
  },
);

// Usefulness: verifies one workflow that can still run keeps the wait beside a filtered one
// (issue #1065), so the rule judges every file, not the first.
test("the --all wait keeps the normal wait when one workflow can still run", async () => {
  const { result } = await probedWait({
    workflows: { "a.yml": PR_PATHS("src/**"), "b.yml": "on:\n  push:\n" },
  });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies the states of the PR head keep the wait (issue #1054, ADR 0048): a queued
// check run, or a pending commit status, on the PR head SHA means a source reports for the head,
// even when `gh pr checks` listed nothing. The probe never returns before the by-SHA read of the head.
test.each([
  ["a queued check run", { headItems: [{ name: "ci", state: "QUEUED", bucket: "pending" }] }],
  ["a pending commit status", { headStatuses: [PENDING_STATUS] }],
])("the --all wait keeps the normal wait for %s on the PR head", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
  expect(result.checks.length).toBeGreaterThan(0);
});

// Usefulness: verifies a workflow text that the scan cannot read as plain trigger names keeps the
// wait (issue #1054). A YAML escape decodes to an event name, so "pull_request" is
// `pull_request`, and a text with a control character hides names too.
test.each([
  ["a YAML unicode escape", '"on": ["pull_\\u0072equest"]\n'],
  ["a YAML hex escape", '"on": ["pu\\x73h"]\n'],
  ["a backslash line continuation", '"on": ["pull_\\\nrequest"]\n'],
  ["a NUL character, as in UTF-16 text", "o\u0000n\u0000: push\n"],
  ["a control character", "on: [\u0007push]\n"],
])("the --all wait keeps the normal wait for a workflow with %s", async (_name, text) => {
  const { result } = await probedWait({ workflows: { "ci.yml": text } });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies bytes that are not UTF-8 keep the wait (issue #1054), because a lossy decode
// can turn a trigger name into replacement characters.
test("the --all wait keeps the normal wait for a workflow that is not UTF-8", async () => {
  const bytes = Buffer.concat([
    Buffer.from("on: [pu"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("sh]\n"),
  ]);
  const files = fileReply("", { size: bytes.length, content: bytes.toString("base64") });
  const { result } = await probedWait({ files });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a content reply that is not valid evidence keeps the wait (issue #1054): a
// base64 string that does not decode, a wrong length, a character outside the alphabet, a size that
// disagrees with the bytes, a type that is not a file, and an encoding other than base64.
test.each([
  ["malformed base64", fileReply("on: push\n", { content: "!!!!" })],
  ["base64 of the wrong length", fileReply("on: push\n", { content: "b24" })],
  ["a base64 character outside the alphabet", fileReply("on: push\n", { content: "b24g*XNo\n" })],
  [
    "invalid base64 characters that decode away and leave a matching size",
    fileReply("on: x\n", { content: `${Buffer.from("on: x\n").toString("base64")}!!!!` }),
  ],
  ["a size that disagrees with the bytes", fileReply(INERT_WORKFLOW, { size: 3 })],
  ["a missing size", fileReply(INERT_WORKFLOW, { size: undefined })],
  ["a type that is not file", fileReply(INERT_WORKFLOW, { type: "symlink" })],
  ["an encoding other than base64", fileReply(INERT_WORKFLOW, { encoding: "none" })],
  ["no content", { type: "file", encoding: "base64", size: 0 }],
])("the --all wait keeps the normal wait for a workflow file reply with %s", async (_n, files) => {
  const { result } = await probedWait({ files });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a list that the API caps, or a reply that the wait cannot validate, keeps the
// wait (issue #1054). 3,000 PR files and 1,000 directory entries are the caps, a `Link` header on the
// directory listing says more exists, and a reply with no 2xx status block, with a body that is not
// one JSON value, or with another shape is not evidence.
test.each([
  ["3,000 PR files", { prFiles: Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` })) }],
  [
    "1,000 directory entries",
    {
      workflows: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [`w${i}.yml`, INERT_WORKFLOW]),
      ),
    },
  ],
  [
    "a Link header on the directory listing",
    {
      listing: {
        status: 0,
        stdout: http(200, [], 'Link: <https://api.github.com/x?page=2>; rel="next"\r\n'),
        stderr: "",
      },
    },
  ],
  [
    "a directory listing with no status block",
    { listing: { status: 0, stdout: "[]", stderr: "" } },
  ],
  [
    "a directory listing that is not one JSON value",
    { listing: { status: 0, stdout: http(200, "[] []"), stderr: "" } },
  ],
  [
    "a directory listing that is an object",
    { listing: { status: 0, stdout: http(200, { message: "x" }), stderr: "" } },
  ],
  [
    "a 404 with another text than the exact Not Found reply",
    { listing: { ...PROBE_NOT_FOUND, stderr: "gh: Not Found for another path (HTTP 404)" } },
  ],
  ["a 404 with a malformed body", { listing: { ...PROBE_NOT_FOUND, stdout: http(404, "oops") } }],
  [
    "a 404 with a Link target on a foreign host",
    {
      listing: {
        ...PROBE_NOT_FOUND,
        stdout: http(
          404,
          { message: "Not Found" },
          'Link: <https://other.example/x?page=2>; rel="next"\r\n',
        ),
      },
    },
  ],
  [
    "a JSON 502",
    {
      listing: {
        status: 1,
        stdout: http(502, { message: "Bad Gateway" }),
        stderr: "gh: Bad Gateway (HTTP 502)",
      },
    },
  ],
  [
    "a base head reply that is not a full SHA",
    { reply: { endpoint: "commits/main", result: readOk({ sha: "main" }) } },
  ],
  [
    "a base head reply with no status block",
    {
      reply: {
        endpoint: "commits/main",
        result: { status: 0, stdout: JSON.stringify({ sha: BASE_HEAD }), stderr: "" },
      },
    },
  ],
])("the --all wait keeps the normal wait for %s", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies the probe reads every file at one base commit (issue #1054). The reads of
// the first test above answer only at the pinned SHA, so a read through the branch name finds no
// reply and keeps the wait. A base branch that moves between the first and the second resolve may
// have mixed the evidence of two commits, so the wait stays.
test("the --all wait keeps the normal wait when the base branch moves during the probe", async () => {
  const { result } = await probedWait({ baseShas: [BASE_HEAD, OTHER_BASE_HEAD] });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a provider that reported only on a merged PR head keeps the `--all` wait
// (issue #1062), where the base head alone shows no check. The merged PR is the one that the base
// head commit belongs to, so the read reuses the paged read and the commit-state reads of the probe.
test.each([
  ["a check run", { mergedRuns: [BASE_RUN] }],
  ["a commit status", { mergedStatuses: [BASE_STATUS] }],
])("the --all wait keeps the normal wait for %s on a merged PR head", async (_name, options) => {
  const { result } = await probedWait({ mergedPrs: [MERGED_PR], ...options });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies the merged PR read adds no false positive (issue #1062): a merged PR head
// with no check, and a PR on that commit that is not merged or targets another branch, still skip.
test.each([
  ["a merged PR head with no check", [MERGED_PR]],
  ["no merged PR for the base head", []],
  ["a PR that is not merged", [{ ...MERGED_PR, merged_at: null }]],
  ["a PR of another base branch", [{ ...MERGED_PR, base: { ref: "dev" } }]],
  [
    "a PR of another base branch with a path-like name",
    [{ ...MERGED_PR, base: { ref: "release/v1.2-rc_1" } }],
  ],
])("the --all wait returns noCheckSource for %s", async (_name, mergedPrs) => {
  const { result } = await probedWait({ mergedPrs, mergedRuns: [], mergedStatuses: [] });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies a PR that is not merged is never evidence (issue #1062): its head can hold
// checks without a provider reporting on merged work, so the probe reads only merged PR heads.
test("the --all wait ignores the checks of a PR that is not merged", async () => {
  const { result } = await probedWait({
    mergedPrs: [{ ...MERGED_PR, merged_at: null }],
    mergedRuns: [BASE_RUN],
  });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies a failed, incomplete, or unparseable read of the merged PR head keeps the
// wait (issue #1062), one row per read and per reply shape.
test.each([
  [
    "a failed merged PR list read",
    { failing: `commits/${BASE_HEAD}/pulls`, mergedPrs: [MERGED_PR] },
  ],
  ["a failed merged head check-runs read", { failing: `commits/${MERGED_HEAD}/check-runs` }],
  ["a failed merged head status read", { failing: `commits/${MERGED_HEAD}/status` }],
  [
    "a merged PR list that is an object",
    { reply: { endpoint: `commits/${BASE_HEAD}/pulls`, result: readOk({ message: "x" }) } },
  ],
  ["a merged PR entry that is not an object", { mergedPrs: ["x"] }],
  ["a merged PR with no head SHA", { mergedPrs: [{ ...MERGED_PR, head: {} }] }],
  [
    "a merged PR with a head that is not a full SHA",
    { mergedPrs: [{ ...MERGED_PR, head: { sha: "abc" } }] },
  ],
  ["a merged PR with a malformed merge time", { mergedPrs: [{ ...MERGED_PR, merged_at: 5 }] }],
  ["a merge time that is no timestamp", { mergedPrs: [{ ...MERGED_PR, merged_at: "soon" }] }],
  [
    "a merge time that is no calendar date",
    { mergedPrs: [{ ...MERGED_PR, merged_at: "2026-02-31T00:00:00Z" }] },
  ],
  ["a PR with no base object", { mergedPrs: [{ ...MERGED_PR, base: undefined }] }],
  ["a PR with no base ref", { mergedPrs: [{ ...MERGED_PR, base: {} }] }],
  ["a PR with an empty base ref", { mergedPrs: [{ ...MERGED_PR, base: { ref: "" } }] }],
  ["a blank base ref", { mergedPrs: [{ ...MERGED_PR, base: { ref: " " } }] }],
  ["a base ref with a leading space", { mergedPrs: [{ ...MERGED_PR, base: { ref: " main" } }] }],
  [
    "a base ref with a trailing newline",
    { mergedPrs: [{ ...MERGED_PR, base: { ref: "main\n" } }] },
  ],
  ["a base ref of two dots", { mergedPrs: [{ ...MERGED_PR, base: { ref: ".." } }] }],
  [
    "a base ref with a double dot inside",
    { mergedPrs: [{ ...MERGED_PR, base: { ref: "ma..in" } }] },
  ],
  ["a base ref with a lock suffix", { mergedPrs: [{ ...MERGED_PR, base: { ref: "main.lock" } }] }],
  ["a base ref with a trailing slash", { mergedPrs: [{ ...MERGED_PR, base: { ref: "main/" } }] }],
  ["a base ref with a leading dash", { mergedPrs: [{ ...MERGED_PR, base: { ref: "-main" } }] }],
  ["a base ref with a reflog marker", { mergedPrs: [{ ...MERGED_PR, base: { ref: "ma@{in" } }] }],
  ["a base ref with a glob character", { mergedPrs: [{ ...MERGED_PR, base: { ref: "ma*in" } }] }],
  ["a base ref that is HEAD", { mergedPrs: [{ ...MERGED_PR, base: { ref: "HEAD" } }] }],
  [
    "a PR with a base ref that is an array",
    { mergedPrs: [{ ...MERGED_PR, base: { ref: ["main"] } }] },
  ],
  ["a head SHA that is an array", { mergedPrs: [{ ...MERGED_PR, head: { sha: [MERGED_HEAD] } }] }],
  [
    "an uppercase head SHA",
    { mergedPrs: [{ ...MERGED_PR, head: { sha: MERGED_HEAD.toUpperCase() } }] },
  ],
  [
    "a head SHA of 41 characters",
    { mergedPrs: [{ ...MERGED_PR, head: { sha: `${MERGED_HEAD}e` } }] },
  ],
  [
    "a malformed entry beside a valid merged PR",
    { mergedPrs: [MERGED_PR, { ...MERGED_PR, number: 8, head: { sha: ["x"] } }] },
  ],
])("the --all wait keeps the normal wait for %s", async (_name, options) => {
  const { result } = await probedWait({ mergedPrs: [MERGED_PR], ...options });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies PRs that share the latest merge time never resolve by list order (issue
// #1062): every tied head is read, so a check on either one keeps the wait, in either list order.
const TIED_PR = { ...MERGED_PR, number: 8, head: { sha: TIED_HEAD } };
test.each([
  ["the first tied head", { mergedPrs: [MERGED_PR, TIED_PR], mergedRuns: [BASE_RUN] }],
  ["the second tied head", { mergedPrs: [MERGED_PR, TIED_PR], tiedRuns: [BASE_RUN] }],
  ["the first tied head, listed last", { mergedPrs: [TIED_PR, MERGED_PR], mergedRuns: [BASE_RUN] }],
  ["the second tied head, listed last", { mergedPrs: [TIED_PR, MERGED_PR], tiedRuns: [BASE_RUN] }],
])("the --all wait keeps the normal wait for a check on %s", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies tied merge times add no false positive, and an older merged PR is not read
// (issue #1062): checks on a PR that merged earlier do not keep the wait.
test("the --all wait returns noCheckSource for tied merged PRs with no check", async () => {
  const { result } = await probedWait({ mergedPrs: [MERGED_PR, TIED_PR] });
  expect(result.noCheckSource).toBe(true);
});

test("the --all wait ignores the checks of a PR that merged before the latest", async () => {
  const older = { ...TIED_PR, merged_at: "2025-12-31T00:00:00Z" };
  const { result } = await probedWait({ mergedPrs: [MERGED_PR, older], tiedRuns: [BASE_RUN] });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies the probe keeps the wait when the PR head moves while it reads (issue
// #1054), because the file list then describes another head than the commit-state read did.
test("the --all wait keeps the normal wait when the PR head moves during the probe", async () => {
  const { result } = await probedWait({ heads: [HEAD_A, HEAD_B] });
  expect(result.noCheckSource).toBeUndefined();
});

// Usefulness: verifies a named expected check keeps the wait, because the parent named a check
// that must register, and an early return would end the wait before it (issue #1054).
test("the --all wait keeps the normal wait when a check name is expected", async () => {
  const { result } = await probedWait({}, { expect: ["deploy"] });
  expect(result.noCheckSource).toBeUndefined();
  expect(result).toMatchObject({ timedOut: true, awaiting: ["deploy"] });
});

// Usefulness: verifies the required wait never returns `noCheckSource`, because the probe belongs
// to the `--all` wait alone (issue #1054).
test("the required wait never returns noCheckSource", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh: probeGh({ all: false }),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result.noCheckSource).toBeUndefined();
});
