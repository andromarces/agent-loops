import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import {
  carryEarlierEvents,
  readContinuation,
  restoreSessions,
} from "../../src/lib/continuation.mjs";
import { removePath } from "../runtime-helpers.mjs";

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
