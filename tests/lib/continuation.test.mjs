import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import {
  carryEarlierEvents,
  gateFromTranscript,
  applyResult,
  freshGate,
  resetGate,
  matchingGate,
  readContinuation,
  restoreSessions,
  verifyResolvedModels,
} from "../../src/lib/continuation.mjs";
import { removePath } from "../runtime-helpers.mjs";

// Value that the mocked `readFile` throws while `active`; otherwise it reads the real file.
const readControl = vi.hoisted(() => ({ active: false, value: undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn(async (...args) => {
      if (readControl.active) {
        throw readControl.value;
      }
      return actual.readFile(...args);
    }),
  };
});

const CWD = resolve("work-tree");

function transcript(overrides = {}) {
  return {
    task: "t",
    cwd: CWD,
    roles: {
      orchestrator: { kind: "codex", model: null, effort: null, sessionId: "o-1" },
      worker: { kind: "claude", model: "opus", effort: "high", sessionId: "w-1" },
      reviewer: { kind: "agy", model: null, effort: null, sessionId: null },
    },
    ...overrides,
  };
}

function roles(overrides = {}) {
  return {
    orchestrator: { kind: "codex", model: null, effort: null, sessionId: null },
    worker: { kind: "claude", model: "opus", effort: "high", sessionId: null },
    reviewer: { kind: "agy", model: null, effort: null, sessionId: null },
    ...overrides,
  };
}

async function readJson(value) {
  const dir = await mkdtemp(join(tmpdir(), "continuation-test-"));
  try {
    const path = join(dir, "run.json");
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    return await readContinuation(path);
  } finally {
    await removePath(dir);
  }
}

// Usefulness: the earlier session ids reach the new roles; a role that never ran
// keeps a null id and starts a new session.
test("restoreSessions copies the earlier session ids", () => {
  const next = roles();
  restoreSessions(next, transcript(), CWD);
  expect(next.orchestrator.sessionId).toBe("o-1");
  expect(next.worker.sessionId).toBe("w-1");
  expect(next.reviewer.sessionId).toBeNull();
});

// Usefulness: a session id is valid only for the CLI that made it, so a changed
// role kind is refused, and the refusal names the role and both kinds.
test("restoreSessions rejects a changed role kind", () => {
  const next = roles({ worker: { kind: "codex", model: "opus", sessionId: null } });
  expect(() => restoreSessions(next, transcript(), CWD)).toThrow(
    "worker was claude in the earlier run, not codex",
  );
});

// Usefulness: agy and antigravity name the same CLI, so the alias is not a change.
test("restoreSessions treats the antigravity alias as agy", () => {
  const next = roles({ reviewer: { kind: "agy", model: null, sessionId: null } });
  const earlier = transcript();
  earlier.roles.reviewer.kind = "antigravity";
  expect(() => restoreSessions(next, earlier, CWD)).not.toThrow();
});

// Usefulness: a changed model is refused, and an unset model equals an unset model.
test("restoreSessions rejects a changed model", () => {
  const next = roles({ worker: { kind: "claude", model: "sonnet", sessionId: null } });
  expect(() => restoreSessions(next, transcript(), CWD)).toThrow(
    'worker model was "opus" in the earlier run, not "sonnet"',
  );
  const unset = roles({ worker: { kind: "claude", model: null, sessionId: null } });
  expect(() => restoreSessions(unset, transcript(), CWD)).toThrow("not (omitted)");
});

// Usefulness: a provider keeps a session per project directory, so another
// work tree is refused.
test("restoreSessions rejects a different work tree", () => {
  expect(() => restoreSessions(roles(), transcript(), resolve("other"))).toThrow(
    "earlier run used --cwd",
  );
});

// Usefulness: a refused continuation leaves no role half-restored.
test("restoreSessions changes no role when it rejects", () => {
  const next = roles({ reviewer: { kind: "codex", model: null, sessionId: null } });
  expect(() => restoreSessions(next, transcript(), CWD)).toThrow();
  expect(next.orchestrator.sessionId).toBeNull();
  expect(next.worker.sessionId).toBeNull();
});

// Usefulness: a bad transcript fails with a message that names the problem.
test("readContinuation rejects an unreadable or malformed transcript", async () => {
  await expect(readContinuation(join(tmpdir(), "no-such-agent-loop-run.json"))).rejects.toThrow(
    "--continue-from",
  );
  await expect(readJson("not json")).rejects.toThrow("not valid JSON");
  await expect(readJson({ cwd: CWD })).rejects.toThrow("has no roles");
  const bad = transcript();
  bad.roles.worker.sessionId = 7;
  await expect(readJson(bad)).rejects.toThrow("worker");
});

// Usefulness: a valid transcript is returned as written.
test("readContinuation returns the transcript", async () => {
  const value = transcript();
  expect(await readJson(value)).toEqual(value);
});

// One rule for every adapter: model and effort compare exactly, and an omitted
// value matches only an omitted value.
const ADAPTERS = ["claude", "codex", "agy", "opencode", "copilot"];

function pair(kind, before, now) {
  const earlier = transcript();
  earlier.roles.worker = { kind, sessionId: "w-1", ...before };
  return [roles({ worker: { kind, sessionId: null, ...now } }), earlier];
}

for (const kind of ADAPTERS) {
  // Usefulness: a changed effort refuses on every adapter, so the rule does not
  // depend on how an adapter passes effort (OpenCode joins it to the model).
  test(`restoreSessions rejects a changed effort for ${kind}`, () => {
    const [next, earlier] = pair(
      kind,
      { model: "m", effort: "high" },
      { model: "m", effort: "low" },
    );
    expect(() => restoreSessions(next, earlier, CWD)).toThrow(
      'worker effort was "high" in the earlier run, not "low"',
    );
    const [omitted, earlierSet] = pair(kind, { model: "m", effort: "high" }, { model: "m" });
    expect(() => restoreSessions(omitted, earlierSet, CWD)).toThrow("not (omitted)");
  });

  // Usefulness: an omitted model matches only an omitted model on every adapter.
  test(`restoreSessions treats an omitted model alike for ${kind}`, () => {
    const [same, earlierSame] = pair(kind, { model: null, effort: null }, { model: null });
    restoreSessions(same, earlierSame, CWD);
    expect(same.worker.sessionId).toBe("w-1");
    const [added, earlierNone] = pair(kind, { model: null }, { model: "m" });
    expect(() => restoreSessions(added, earlierNone, CWD)).toThrow(
      'worker model was (omitted) in the earlier run, not "m"',
    );
    const [dropped, earlierSet] = pair(kind, { model: "m" }, { model: null });
    expect(() => restoreSessions(dropped, earlierSet, CWD)).toThrow("not (omitted)");
  });
}

// Usefulness: the orchestrator is checked like every other role.
test("restoreSessions checks the orchestrator model and effort", () => {
  const earlier = transcript();
  earlier.roles.orchestrator = { kind: "opencode", model: "p/m", effort: "high", sessionId: "o-1" };
  const next = roles({ orchestrator: { kind: "opencode", model: "p/m", effort: null } });
  expect(() => restoreSessions(next, earlier, CWD)).toThrow(
    'orchestrator effort was "high" in the earlier run, not (omitted)',
  );
});

// Usefulness: a transcript whose events are not a list is rejected, because the
// same-path continuation appends to them.
test("readContinuation rejects events that are not a list", async () => {
  await expect(readJson({ ...transcript(), events: "x" })).rejects.toThrow("events");
});

// Usefulness: an argument spread over the earlier events throws RangeError once
// the list passes the V8 argument limit, which is about 125,000 at the default
// stack and grows with a larger stack, so 2,000,000 events fail the old spread on
// any stack size in practice (#362 review). In memory, no disk I/O.
test("carryEarlierEvents copies more events than any argument spread can pass", () => {
  const count = 2_000_000;
  const event = { type: "e" };
  const earlier = {
    events: Array.from({ length: count }, () => event),
    exitCode: 2,
    error: "Step limit reached with work remaining.",
    options: { maxSteps: 1 },
  };
  const events = [{ type: "first" }];

  carryEarlierEvents(events, earlier);

  expect(events.length).toBe(count + 2);
  expect(events[0].type).toBe("first");
  expect(events[count]).toBe(event);
  expect(events[count + 1]).toMatchObject({
    type: "continued",
    earlier: { exitCode: 2, error: "Step limit reached with work remaining.", maxSteps: 1 },
  });
});

// Usefulness: a transcript with no events still gets the boundary event.
test("carryEarlierEvents adds only the boundary for a transcript with no events", () => {
  const events = [];
  carryEarlierEvents(events, {});
  expect(events).toHaveLength(1);
  expect(events[0].earlier).toEqual({ exitCode: null, error: null, maxSteps: null });
});

// Usefulness: acceptance (#490) — a read failure that is `null`, `undefined`, or has a throwing
// `message` getter still ends in the documented read error instead of a second error.
test.each([
  ["null", null],
  ["undefined", undefined],
  [
    "a throwing message getter",
    {
      get message() {
        throw new Error("getter");
      },
    },
  ],
])("readContinuation reports a read failure that throws %s", async (_name, thrown) => {
  readControl.active = true;
  readControl.value = thrown;
  try {
    await expect(readContinuation("run.json")).rejects.toThrow(
      "--continue-from cannot read run.json:",
    );
  } finally {
    readControl.active = false;
  }
});

// Usefulness: acceptance (#490) — an ordinary read failure keeps its message in the error text.
test("readContinuation keeps the message of an ordinary read failure", async () => {
  await expect(readContinuation("no-such-490-file.json")).rejects.toThrow(
    /cannot read no-such-490-file\.json: .*ENOENT/,
  );
});

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

// Usefulness: a role that never ran in the continued run still keeps the model recorded by the
// earlier run, so a later continuation stays checked.
test("restoreSessions carries the recorded resolvedModel to the new roles", () => {
  const earlier = transcript();
  earlier.roles.worker.resolvedModel = "claude-opus-5-5";
  const next = roles();
  restoreSessions(next, earlier, CWD);
  expect(next.worker.resolvedModel).toBe("claude-opus-5-5");
  expect(next.reviewer.resolvedModel).toBeUndefined();
});

function probeAgents(resolvedByKind) {
  const run = vi.fn(async (state) => {
    if (resolvedByKind[state.kind] !== undefined) state.resolvedModel = resolvedByKind[state.kind];
    return "OK";
  });
  const agents = Object.fromEntries(
    ["codex", "claude", "agy", "opencode", "copilot"].map((kind) => [kind, { run }]),
  );
  return { agents, run };
}

const probeOptions = (agents) => ({ cwd: CWD, timeout: 5, signal: undefined, agents });

// Usefulness: a CLI default that changed between the runs is refused before any turn, and the
// refusal names the role and both models.
test("verifyResolvedModels rejects a role whose resolved model changed", async () => {
  const next = roles();
  next.worker.resolvedModel = "claude-opus-5-5";
  const { agents, run } = probeAgents({ claude: "claude-opus-5-6" });
  await expect(verifyResolvedModels(next, probeOptions(agents))).rejects.toThrow(
    'worker resolved to "claude-opus-5-5" in the earlier run, not "claude-opus-5-6"',
  );
  // The probe starts a new read-only session, never the continued one.
  expect(run.mock.calls[0][0].sessionId).toBeNull();
  expect(run.mock.calls[0][2]).toMatchObject({ readOnly: true, role: "worker", cwd: CWD });
});

// Usefulness: an unchanged resolved model continues, and a role with no record costs no probe.
test("verifyResolvedModels accepts an unchanged model and skips a role with no record", async () => {
  const next = roles();
  next.worker.resolvedModel = "claude-opus-5-5";
  const { agents, run } = probeAgents({ claude: "claude-opus-5-5" });
  await verifyResolvedModels(next, probeOptions(agents));
  expect(run).toHaveBeenCalledTimes(1);
});

// Usefulness: a CLI that reports no model on the probe cannot be compared, so the run continues
// instead of refusing on a value that cannot be read.
test("verifyResolvedModels continues when the probe reports no model", async () => {
  const next = roles();
  next.worker.resolvedModel = "claude-opus-5-5";
  const { agents } = probeAgents({});
  await expect(verifyResolvedModels(next, probeOptions(agents))).resolves.toBeUndefined();
});

// Usefulness: a probe that fails refuses the continuation, because the model is unverified.
test("verifyResolvedModels refuses when the probe fails", async () => {
  const next = roles();
  next.worker.resolvedModel = "claude-opus-5-5";
  const agents = { claude: { run: vi.fn().mockRejectedValue(new Error("boom")) } };
  await expect(verifyResolvedModels(next, probeOptions(agents))).rejects.toThrow(
    "worker model probe failed: boom",
  );
});
