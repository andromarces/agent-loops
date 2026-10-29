import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  applyResult,
  declaredPrFromTranscript,
  freshGate,
  gateFromTranscript,
  matchingGate,
  resetGate,
} from "../../src/lib/gate.mjs";
import { reviewedState, snapshot } from "../../src/lib/snapshot.mjs";
import { createTempRepo, removePath } from "../runtime-helpers.mjs";

const CWD = resolve("work-tree");

const HEAD = "a".repeat(40);
const DIGEST = "b".repeat(64);
const ACCEPT = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";
const REVIEWED = { head: HEAD, digest: DIGEST, clean: true, exact: true };

function resultEvent(role, response, reviewed = REVIEWED, status = "ok") {
  const body = status === "ok" ? { status, response } : { status, error: "boom" };
  return { type: "result", role, result: { ...body, ...(reviewed ? { reviewed } : {}) } };
}

const invocation = (role, status = "ok") => ({ type: "invocation", role, status });

// A turn as a run writes it: the invocation, then the result.
const turn = (role, response, reviewed, status = "ok") => [
  invocation(role),
  resultEvent(role, response, reviewed, status),
];

// The gate record a run writes: the state the runtime transitions reach for the events.
function recordFor(events, start = freshGate()) {
  let state = start;
  for (const event of events) {
    if (event.type === "result") state = applyResult(state, event.role, event.result);
  }
  return { type: "gate", ...state };
}

// A transcript as a finished run writes it: the events, then the gate record.
const withGate = (events, extra = {}) => ({
  events: [...events, recordFor(events, extra.options?.continueFrom ? resetGate() : freshGate())],
  ...extra,
});

// Usefulness: the gate is rebuilt by replaying the events (#393), so a stored flag cannot bypass
// --require-accept; an accept needs the Checks line, and a reject derives no accept.
test("gateFromTranscript replays the events to the recorded gate state", () => {
  const events = [...turn("worker", "done", null), ...turn("reviewer", ACCEPT)];
  expect(gateFromTranscript(withGate(events))).toEqual({
    workerRan: true,
    reviewerRan: true,
    reviewerTurnDispatched: true,
    acceptedSinceWorker: true,
    lastReviewed: REVIEWED,
  });
  expect(gateFromTranscript(withGate(turn("reviewer", "Verdict: reject")))).toMatchObject({
    workerRan: false,
    acceptedSinceWorker: false,
  });
  expect(
    gateFromTranscript(withGate(turn("reviewer", ACCEPT), { options: { continueFrom: "x" } }))
      .workerRan,
  ).toBe(true);
  expect(gateFromTranscript(withGate([invocation("orchestrator"), ...events]))).not.toBeNull();
});

// Usefulness: a `continued` event restarts the replay at the reset state (#362), so a same-file
// transcript replays only the segment the last run wrote.
test("gateFromTranscript restarts the replay at a continued event", () => {
  const events = [...turn("reviewer", ACCEPT), { type: "continued" }, ...turn("worker", "w", null)];
  const earlier = {
    events: [
      ...events,
      { type: "gate", ...applyResult({ ...freshGate(), workerRan: true }, "worker", {}) },
    ],
  };
  expect(gateFromTranscript(earlier)).toMatchObject({
    workerRan: true,
    acceptedSinceWorker: false,
  });
});

// Usefulness: every way the events can disagree with the recorded gate state gives the reset
// (#393 review): a missing, misplaced, or different record, a turn with no result, and edits
// that delete, reorder, or re-role an event.
test("gateFromTranscript returns null unless the replay equals the record", () => {
  const accepted = [...turn("worker", "w", null), ...turn("reviewer", ACCEPT)];
  expect(gateFromTranscript(undefined)).toBeNull();
  expect(gateFromTranscript({ events: [] })).toBeNull();
  expect(gateFromTranscript({ events: accepted })).toBeNull();
  expect(
    gateFromTranscript({ events: [...withGate(accepted).events, invocation("worker")] }),
  ).toBeNull();
  const open = [...accepted, invocation("worker")];
  expect(gateFromTranscript({ events: [...open, recordFor(open)] })).toBeNull();
  const deleted = withGate(accepted);
  deleted.events.splice(1, 1);
  expect(gateFromTranscript(deleted)).toBeNull();
  const rerole = withGate(accepted);
  rerole.events[1] = { ...rerole.events[1], role: "wrk" };
  expect(gateFromTranscript(rerole)).toBeNull();
  const two = [...turn("reviewer", ACCEPT), ...turn("reviewer", "Verdict: reject")];
  const reordered = withGate(two);
  [reordered.events[1], reordered.events[3]] = [reordered.events[3], reordered.events[1]];
  expect(gateFromTranscript(reordered)).toBeNull();
  const forgedFlag = withGate(turn("reviewer", "Verdict: reject"));
  forgedFlag.events.at(-1).acceptedSinceWorker = true;
  expect(gateFromTranscript(forgedFlag)).toBeNull();
  expect(gateFromTranscript(withGate([...turn("reviewer", "x", null, "error")]))).toMatchObject({
    lastReviewed: null,
  });
});

// Usefulness: an unexpected value in any event gives the reset and never a throw (#393 review).
test("gateFromTranscript returns null, and does not throw, on malformed events", () => {
  for (const response of [null, undefined, 7, {}]) {
    expect(
      gateFromTranscript({ events: [...turn("reviewer", response), { type: "gate" }] }),
    ).toBeNull();
  }
  expect(gateFromTranscript({ events: [null, 3, "x", { type: "gate" }] })).toBeNull();
  expect(gateFromTranscript({ events: "events" })).toBeNull();
  expect(
    gateFromTranscript({
      events: [{ type: "result", role: "reviewer", result: null }, { type: "gate" }],
    }),
  ).toBeNull();
  const badHead = turn("reviewer", ACCEPT, { ...REVIEWED, head: { not: "x" } });
  expect(gateFromTranscript({ events: [...badHead, { type: "gate" }] })).toBeNull();
  expect(
    gateFromTranscript(withGate([{ type: "invocation", role: "boss", status: "ok" }])),
  ).toBeNull();
  expect(gateFromTranscript(withGate([{ type: 5 }]))).toBeNull();
});

// Usefulness: every malformed record falls back to the reset without throwing, which keeps
// --continue-from working on a hand-edited transcript (#393 review).
test("matchingGate returns null for an absent or malformed gate", async () => {
  const gate = (over = {}, reviewed = {}) => ({
    workerRan: true,
    reviewerRan: true,
    reviewerTurnDispatched: true,
    acceptedSinceWorker: true,
    ...over,
    lastReviewed: { ...REVIEWED, ...reviewed },
  });
  expect(await matchingGate(undefined, CWD)).toBeNull();
  expect(await matchingGate({}, CWD)).toBeNull();
  for (const bad of [
    gate({ acceptedSinceWorker: "true" }),
    gate({ reviewerRan: 1 }),
    gate({}, { clean: "yes" }),
    gate({}, { exact: "true" }),
    gate({}, { exact: false }),
    gate({}, { head: "not-a-head" }),
    gate({}, { head: { not: "a head" } }),
    gate({}, { digest: "abc" }),
    gate({}, { digest: undefined }),
  ]) {
    expect(await matchingGate(bad, CWD)).toBeNull();
  }
});

// Usefulness: verifies a cancel during the gate snapshot rejects as a cancel and does not read as
// "no gate", so a canceled continuation exits 130 instead of resetting the gate (#729).
test("matchingGate rejects as canceled when the cancel is already set", async () => {
  const repo = await createTempRepo();
  try {
    const reviewed = reviewedState(await snapshot(repo));
    const gate = {
      workerRan: true,
      reviewerRan: true,
      reviewerTurnDispatched: true,
      acceptedSinceWorker: true,
      lastReviewed: reviewed,
    };
    expect(await matchingGate(gate, repo)).not.toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(matchingGate(gate, repo, { signal: controller.signal })).rejects.toMatchObject({
      isCanceled: true,
    });
  } finally {
    await removePath(repo);
  }
});

const declared = (pr) => ({ type: "pr-declared", pr, stepsUsed: 1 });

const NO_FLAGS = { pr: null, requireCi: null };

// Usefulness: verifies a continued run recovers the PR that the runtime declared late in the
// earlier run, so the declared-PR finish rule survives --continue-from (issue #919).
test("declaredPrFromTranscript returns the PR of the pr-declared events", () => {
  const earlier = {
    options: NO_FLAGS,
    events: [declared(42), { type: "action" }, declared(42), { type: "gate" }],
  };
  expect(declaredPrFromTranscript(earlier)).toBe(42);
});

// Usefulness: verifies a transcript that records no declaration gives null, so a run that never
// declared a PR stays undeclared. A run whose flags name the declared PR keeps it.
test.each([
  ["no pr-declared event", { options: NO_FLAGS, events: [{ type: "gate" }] }],
  ["no events", { options: NO_FLAGS }],
  ["no options", { events: [{ type: "gate" }] }],
  ["no transcript", null],
])("declaredPrFromTranscript returns null for %s", (_label, earlier) => {
  expect(declaredPrFromTranscript(earlier)).toBeNull();
});

test.each([
  ["--pr", { pr: 42, requireCi: 42 }],
  ["--require-ci", { pr: null, requireCi: 42 }],
])("declaredPrFromTranscript keeps the PR of a run that had %s for it", (_label, options) => {
  expect(declaredPrFromTranscript({ options, events: [declared(42)] })).toBe(42);
});

// Usefulness: verifies a malformed or contradictory declaration record is refused, never read as
// no declaration, because a null here would drop the declared-PR finish rule while the completion
// replay still accepts the transcript (issue #919).
test.each([
  ["a string PR", { options: NO_FLAGS, events: [declared("42")] }],
  ["a zero PR", { options: NO_FLAGS, events: [declared(0)] }],
  ["a fractional PR", { options: NO_FLAGS, events: [declared(1.5)] }],
  ["a missing PR", { options: NO_FLAGS, events: [{ type: "pr-declared" }] }],
  ["two different PRs", { options: NO_FLAGS, events: [declared(41), declared(42)] }],
  [
    "a run that had --pr for another PR",
    { options: { pr: 7, requireCi: 7 }, events: [declared(42)] },
  ],
  [
    "a run that had --require-ci for another PR",
    { options: { pr: null, requireCi: 7 }, events: [declared(42)] },
  ],
])("declaredPrFromTranscript refuses %s", (_label, earlier) => {
  expect(() => declaredPrFromTranscript(earlier)).toThrow(/pr-declared|declared/);
});

// Usefulness: verifies a `pr-undeclared` record never reads as a declaration (#1111), so a
// continuation restores no PR gate for a PR that the earlier run left undeclared.
test("declaredPrFromTranscript ignores the pr-undeclared events", () => {
  const earlier = {
    options: NO_FLAGS,
    events: [{ type: "pr-undeclared", pr: 42, stepsUsed: 1 }, { type: "gate" }],
  };
  expect(declaredPrFromTranscript(earlier)).toBeNull();
});
