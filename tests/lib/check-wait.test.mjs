import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";

// A scripted `gh` for the required-check read. Each entry is `{ status, checks,
// stdout, stderr }` and the last entry repeats, so a wait that polls more times
// than the script holds still answers. A `stdout` value is used verbatim, which
// covers a read whose output is not a check list. An unmatched call is an error,
// so a test never passes on a missing fixture.
function scriptedGh(reads) {
  let n = 0;
  return async (args, cwd) => {
    if (!args.join(" ").includes("pr checks")) {
      return { status: 1, stdout: "", stderr: `unmatched gh call: ${args.join(" ")} (${cwd})` };
    }
    const read = reads[Math.min(n++, reads.length - 1)];
    return {
      status: read.status,
      stdout: read.stdout ?? JSON.stringify(read.checks ?? []),
      stderr: read.stderr ?? "",
      timedOut: read.timedOut ?? false,
    };
  };
}

// A fake clock: `sleep` advances it by the requested milliseconds, so the wait
// runs to completion without wall-clock time and the elapsed bound is checkable.
function fakeClock() {
  const clock = { now: 0, slept: 0 };
  return {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.slept += ms;
      clock.now += ms;
    },
    elapsed: () => clock.now,
  };
}

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
  expect(result).toEqual({ timedOut: false, checks: [PASSED_ITEM] });
  expect(clock.elapsed()).toBeLessThan(300_000);
});

// Usefulness: verifies exit 0: every listed required check passed, so the wait is
// settled and reports no timeout (issue #329).
test("waitChecks settles on exit 0 with every required check passed", async () => {
  expect(
    await once({ status: 0, checks: [PASSED_ITEM, check("lint", "pass", "SUCCESS")] }),
  ).toEqual({
    timedOut: false,
    checks: [PASSED_ITEM, check("lint", "pass", "SUCCESS")],
  });
});

// Usefulness: verifies exit 8: a required check is pending, so the wait runs to
// its bound and reports the pending check as the last state it read (issue #329).
test("waitChecks keeps waiting on exit 8 and reports the bound", async () => {
  expect(await once({ status: 8, checks: [PENDING_ITEM] })).toEqual({
    timedOut: true,
    checks: [PENDING_ITEM],
  });
});

// Usefulness: verifies exit 1 with a failing required check listed: the wait is
// settled and reports the failure instead of waiting it out to the bound
// (issue #329).
test("waitChecks settles on exit 1 when a failing required check is listed", async () => {
  expect(await once({ status: 1, checks: [FAILED_ITEM] })).toEqual({
    timedOut: false,
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
  expect(result).toEqual({ timedOut: true, checks: [PENDING_ITEM] });
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
  expect(result).toEqual({ timedOut: true, checks: [] });
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
  expect(result).toEqual({ timedOut: true, checks: [], childExitUnconfirmed: true });
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
