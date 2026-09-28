import { expect, test } from "vitest";
import { waitChecks } from "../../src/lib/check-wait.mjs";

// A scripted `gh` for the required-check read: each call returns the next entry
// and the last entry repeats, so a wait that polls more times than the script
// holds still answers. A `null` entry is a read failure with no JSON on stdout.
// An unmatched call is an error, so a test never passes on a missing fixture.
function scriptedGh(reads) {
  let n = 0;
  return async (args, cwd) => {
    if (!args.join(" ").includes("pr checks")) {
      return { status: 1, stdout: "", stderr: `unmatched gh call: ${args.join(" ")} (${cwd})` };
    }
    const read = reads[Math.min(n++, reads.length - 1)];
    if (read === null) {
      return { status: 1, stdout: "", stderr: "gh: not found" };
    }
    return { status: 8, stdout: JSON.stringify(read), stderr: "" };
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

function check(name, bucket, state = "PENDING") {
  return { name, state, bucket };
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
    gh: scriptedGh([[], [check("ci", "pending", "IN_PROGRESS")], [check("ci", "pass", "SUCCESS")]]),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({
    timedOut: false,
    checks: [{ name: "ci", state: "SUCCESS", bucket: "pass" }],
  });
  expect(clock.elapsed()).toBeLessThan(300_000);
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
    gh: scriptedGh([[check("ci", "pending", "IN_PROGRESS")]]),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({
    timedOut: true,
    checks: [{ name: "ci", state: "IN_PROGRESS", bucket: "pending" }],
  });
  // The wait never runs past the bound it was given.
  expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
  expect(clock.elapsed()).toBeLessThan(60_000 + 60_000);
});

// Usefulness: verifies a required check that ends in failure ends the wait as a
// settled read with `timedOut` false, so a parent sees the failure instead of a
// wait that runs to the bound (issue #329).
test("waitChecks returns a failing required check without a timeout", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    gh: scriptedGh([[check("ci", "fail", "FAILURE")]]),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({
    timedOut: false,
    checks: [{ name: "ci", state: "FAILURE", bucket: "fail" }],
  });
  expect(clock.elapsed()).toBe(0);
});

// Usefulness: verifies a read whose output is not a check list refuses with a
// reason instead of reporting an empty settled wait, so an unresolved read never
// reads as a clean result (issue #329).
test("waitChecks refuses a required-check read it cannot parse", async () => {
  const clock = fakeClock();
  await expect(
    waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 300,
      gh: async () => ({ status: 1, stdout: "no checks here", stderr: "gh: not found" }),
      now: clock.now,
      sleep: clock.sleep,
    }),
  ).rejects.toThrow(/gh pr checks 42 --required/);
});
