import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import {
  fakeClock,
  HEAD_A,
  scriptedGh,
  PENDING_ITEM,
  PASSED_ITEM,
  FAILED_ITEM,
} from "./check-wait-helpers.mjs";

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
