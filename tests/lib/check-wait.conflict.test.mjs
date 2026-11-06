import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import {
  fakeClock,
  HEAD_A,
  HEAD_B,
  isHeadRead,
  PASSED_ITEM,
  PENDING_ITEM,
  scriptedGh,
} from "./check-wait-helpers.mjs";

/** Runs one wait over the scripted reads and merge states, on a fake clock. */
function conflictWait({
  reads = [{ status: 0, checks: [PASSED_ITEM] }],
  heads = [HEAD_A],
  mergeStates,
  all = false,
  head = null,
}) {
  const clock = fakeClock();
  const result = waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    all,
    head,
    gh: scriptedGh(reads, { all, heads, mergeStates }),
    now: clock.now,
    sleep: clock.sleep,
  });
  return { clock, result };
}

// Usefulness: verifies a conflict ends the wait before its bound, in both wait modes.
// The envelope carries the conflict field, `timedOut: false`, and an empty `checks` (issue #1536).
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

// Usefulness: verifies a conflict on the `--head` commit settles the wait, in both modes.
// The parent then acts on a conflict of the head it waits for (issue #1536).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode returns a conflict on the --head commit", async (_mode, all) => {
  const { result } = conflictWait({
    all,
    head: HEAD_A,
    mergeStates: [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
  });
  expect(await result).toEqual({
    timedOut: false,
    conflicting: true,
    head: HEAD_A,
    checks: [],
  });
});

// Usefulness: verifies a conflict on another commit than `--head` keeps the wait, in both modes.
// The bound returns `timedOut: true`, no head, and no checks, never a conflict for that other head.
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode keeps waiting over a conflict on another head", async (_mode, all) => {
  const { result } = conflictWait({
    all,
    head: HEAD_B,
    heads: [HEAD_A],
    mergeStates: [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
  });
  expect(await result).toEqual({ timedOut: true, head: null, checks: [] });
});

// Usefulness: verifies a push between polls never pairs a conflict with the earlier head.
// One reply carries the head and the merge state, in both wait modes (issue #1536).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode names the head that the conflict reply carries", async (_mode, all) => {
  const { result } = conflictWait({
    all,
    reads: [{ status: 8, checks: [PENDING_ITEM] }],
    heads: [HEAD_A, HEAD_B],
    mergeStates: [
      { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
    ],
  });
  expect(await result).toEqual({
    timedOut: false,
    conflicting: true,
    head: HEAD_B,
    checks: [],
  });
});

// Usefulness: verifies one `gh pr view` reply carries the head and the merge state, in both modes.
// No read can pair a conflict with a head from another reply (issue #1536).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode reads the head and merge state once", async (_mode, all) => {
  const inner = scriptedGh([{ status: 8, checks: [PENDING_ITEM] }], {
    all,
    mergeStates: [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
  });
  const reads = [];
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 300,
    all,
    gh: (args, cwd, options) => {
      if (isHeadRead(args)) {
        reads.push(args);
      }
      return inner(args, cwd, options);
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result).toEqual({ timedOut: false, conflicting: true, head: HEAD_A, checks: [] });
  expect(reads).toHaveLength(1);
});

// Usefulness: verifies `UNKNOWN`, null, and unreadable merge fields keep the wait.
// A fresh push or a value the wait cannot read is never mistaken for a conflict (issue #1536).
test.each([
  ["UNKNOWN", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }],
  ["a null merge state", { mergeable: null, mergeStateStatus: null }],
  ["missing merge fields", {}],
  ["unreadable merge fields", { mergeable: 123, mergeStateStatus: false }],
])("waitChecks keeps waiting over %s", async (_name, mergeState) => {
  const { result } = conflictWait({ mergeStates: [mergeState] });
  expect(await result).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a head-and-merge reply that never answers ends the wait at the bound.
// It is never a conflict or a pass, so a hung read cannot claim a conflict (issue #1536).
test("waitChecks reports the bound when the head-and-merge read never answers", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }]);
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 0.3,
    childExitCeilingMs: 100,
    gh: (args, cwd, options) =>
      isHeadRead(args) ? new Promise(() => {}) : inner(args, cwd, options),
  });
  expect(result.timedOut).toBe(true);
  expect(result.conflicting).toBeUndefined();
  expect(result.checks).toEqual([]);
}, 20000);
