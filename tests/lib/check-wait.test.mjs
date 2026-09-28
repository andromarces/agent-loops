import { expect, test } from "vitest";
import { waitChecks } from "../../src/lib/check-wait.mjs";

// A scripted `gh` for the required-check read. Each entry is `{ status, checks,
// stdout }` and the last entry repeats, so a wait that polls more times than the
// script holds still answers. A `stdout` value is used verbatim, which covers a
// read whose output is not a check list. An unmatched call is an error, so a test
// never passes on a missing fixture.
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

function check(name, bucket, state = "PENDING") {
  return { name, state, bucket };
}

const PENDING = { status: 8, checks: [check("ci", "pending", "IN_PROGRESS")] };
const PASSED = { status: 0, checks: [check("ci", "pass", "SUCCESS")] };
const FAILED = { status: 1, checks: [check("ci", "fail", "FAILURE")] };

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
    gh: scriptedGh([{ status: 0, checks: [] }, PENDING, PASSED]),
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
    gh: scriptedGh([PENDING]),
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

// Usefulness: verifies the bound holds when a `gh` read never answers. The
// read is abandoned on the bound, the wait reports the bound as reached, and the
// read is signaled to stop, so a hung `gh` cannot outlast the bound or leave its
// child running (issue #329). A real short bound on the real clock, because the
// contract is wall-clock time against a hung child.
test("waitChecks returns inside the bound when a gh read never answers", async () => {
  const signals = [];
  const started = Date.now();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 0.2,
    // Never settles on its own, and records the signal that must stop it.
    gh: async (args, cwd, { signal } = {}) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
  // Every read is bounded by the time left and is signaled to stop when the
  // bound is reached, which is what terminates the `gh` child.
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
});

// Usefulness: verifies the `gh pr checks` exit codes map as the instructions
// state, so a pass is reported only from a settled read (issue #329).
test("waitChecks maps the gh pr checks exit codes to the wait outcome", async () => {
  const run = async (read) => {
    const clock = fakeClock();
    return waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 60,
      gh: scriptedGh([read]),
      now: clock.now,
      sleep: clock.sleep,
    });
  };

  // Exit 0: every listed required check passed, so the wait is settled.
  expect(await run(PASSED)).toEqual({
    timedOut: false,
    checks: [{ name: "ci", state: "SUCCESS", bucket: "pass" }],
  });
  // Exit 8: a check is pending, so the wait runs to its bound.
  expect(await run(PENDING)).toMatchObject({ timedOut: true });
  // Exit 1 with a listed failing required check: settled, and the failure is
  // reported instead of being waited out.
  expect(await run(FAILED)).toEqual({
    timedOut: false,
    checks: [{ name: "ci", state: "FAILURE", bucket: "fail" }],
  });
});

// Usefulness: verifies an exit 1 that lists no failing required check is
// unresolved rather than a pass. Exit 1 covers a repository with no required
// check and a read error, so neither may read as a clean result (issue #329).
test("waitChecks refuses an exit 1 that lists no failing required check", async () => {
  for (const read of [
    { status: 1, checks: [], stderr: "no required checks found on the 'main' branch" },
    { status: 1, stdout: "not a check list", stderr: "gh: could not resolve to a PullRequest" },
  ]) {
    const clock = fakeClock();
    await expect(
      waitChecks({
        pr: 42,
        cwd: ".",
        timeoutSeconds: 300,
        gh: scriptedGh([read]),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/gh pr checks 42 --required/);
  }
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
      gh: async () => ({ status: 0, stdout: "no checks here", stderr: "" }),
      now: clock.now,
      sleep: clock.sleep,
    }),
  ).rejects.toThrow(/gh pr checks 42 --required/);
});
