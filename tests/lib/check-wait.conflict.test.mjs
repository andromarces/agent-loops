import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import {
  fakeClock,
  HEAD_A,
  HEAD_B,
  isMergeStateRead,
  PASSED_ITEM,
  PENDING_ITEM,
  scriptedGh,
} from "./check-wait-helpers.mjs";

/** Runs one wait in `all` mode over the scripted reads and merge states, on a fake clock. */
function conflictWait({
  reads = [{ status: 0, checks: [PASSED_ITEM] }],
  mergeStates,
  all = false,
}) {
  const clock = fakeClock();
  const result = waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    all,
    gh: scriptedGh(reads, { all, mergeStates }),
    now: clock.now,
    sleep: clock.sleep,
  });
  return { clock, result };
}

// Usefulness: verifies a conflicted PR ends the wait before its bound in both wait modes, with the
// conflict field, `timedOut: false`, and an empty `checks`, so the parent learns the conflict instead
// of waiting out the bound on checks that GitHub never starts (issue #1536).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode returns a conflict before the bound", async (_mode, all) => {
  const { clock, result } = conflictWait({
    all,
    reads: [{ status: 8, checks: [PENDING_ITEM] }],
    mergeStates: [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
  });
  expect(await result).toEqual({
    timedOut: false,
    conflicting: true,
    head: HEAD_A,
    checks: [],
  });
  expect(clock.elapsed()).toBe(0);
});

// Usefulness: verifies a merge state GitHub still computes, or a null one, keeps the wait and never
// reads as a conflict, so a fresh push is not mistaken for a merge conflict (issue #1536).
test.each([
  ["UNKNOWN", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }],
  ["a null merge state", { mergeable: null, mergeStateStatus: null }],
])("waitChecks keeps waiting over %s", async (_name, mergeState) => {
  const { result } = conflictWait({ mergeStates: [mergeState] });
  expect(await result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a failed or unparseable merge-state read keeps the wait and never ends it as a
// conflict or a pass, so an unresolved read cannot decide the outcome (issue #1536).
test.each([
  ["a failed merge-state read", { status: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" }],
  ["an unparseable merge-state read", { status: 0, stdout: "not json", stderr: "" }],
])("waitChecks keeps waiting over %s", async (_name, mergeState) => {
  const { result } = conflictWait({ mergeStates: [mergeState] });
  expect(await result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a merge-state read that reaches the bound ends the wait at the bound and never
// as a conflict or a pass, so a hung read cannot claim a conflict it did not observe (issue #1536).
test("waitChecks reports the bound when the merge-state read never answers", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }]);
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 0.3,
    childExitCeilingMs: 100,
    gh: (args, cwd, options) =>
      isMergeStateRead(args) ? new Promise(() => {}) : inner(args, cwd, options),
  });
  expect(result.timedOut).toBe(true);
  expect(result.conflicting).toBeUndefined();
  expect(result.checks).toEqual([]);
}, 20000);

// Usefulness: verifies a conflict that a later poll reads names the head of that poll and reports no
// check of the earlier head, so a moved PR head never yields a conflict or pass for another commit
// (issue #1536).
test("waitChecks names the head of the poll that reads the conflict", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    gh: scriptedGh([{ status: 8, checks: [PENDING_ITEM] }], {
      heads: [HEAD_A, HEAD_B],
      mergeStates: [
        { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
        { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      ],
    }),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: false, conflicting: true, head: HEAD_B, checks: [] });
});
