import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { readContinuation, restoreSessions } from "../../src/lib/continuation.mjs";
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
    worker: { kind: "claude", model: "opus", effort: null, sessionId: null },
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
  expect(() => restoreSessions(unset, transcript(), CWD)).toThrow("not (default)");
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

const OPENCODE_CWD = CWD;

function opencodeTranscript(worker) {
  const earlier = transcript();
  earlier.roles.worker = { kind: "opencode", sessionId: "w-1", ...worker };
  return earlier;
}

function opencodeRoles(worker) {
  return roles({ worker: { kind: "opencode", sessionId: null, ...worker } });
}

// Usefulness: an OpenCode effort is passed as <model>#<effort>, so the same model
// with another effort is another effective model and the session cannot resume.
test("restoreSessions rejects a changed OpenCode effort on the same model", () => {
  const earlier = opencodeTranscript({ model: "p/m", effort: "high" });
  expect(() =>
    restoreSessions(opencodeRoles({ model: "p/m", effort: null }), earlier, OPENCODE_CWD),
  ).toThrow('worker model was "p/m#high" in the earlier run, not "p/m"');
  expect(() =>
    restoreSessions(opencodeRoles({ model: "p/m", effort: "low" }), earlier, OPENCODE_CWD),
  ).toThrow('"p/m#high" in the earlier run, not "p/m#low"');
});

// Usefulness: an OpenCode role with no model runs OpenCode's own default, which the
// transcript does not record and which varies by machine, so the check refuses it
// rather than assume it matches. An explicit model resumes.
test("restoreSessions refuses an OpenCode role whose effective model is a default", () => {
  const earlier = opencodeTranscript({ model: null, effort: null });
  expect(() =>
    restoreSessions(opencodeRoles({ model: null, effort: null }), earlier, OPENCODE_CWD),
  ).toThrow("worker uses opencode with no --worker-model");
  const explicit = opencodeTranscript({ model: "p/m", effort: "high" });
  const next = opencodeRoles({ model: "p/m", effort: "high" });
  restoreSessions(next, explicit, OPENCODE_CWD);
  expect(next.worker.sessionId).toBe("w-1");
});

// Usefulness: the orchestrator is checked like every other role.
test("restoreSessions checks the orchestrator's OpenCode effective model", () => {
  const earlier = transcript();
  earlier.roles.orchestrator = { kind: "opencode", model: "p/m", effort: "high", sessionId: "o-1" };
  const next = roles({ orchestrator: { kind: "opencode", model: "p/m", effort: null } });
  expect(() => restoreSessions(next, earlier, OPENCODE_CWD)).toThrow(
    'orchestrator model was "p/m#high" in the earlier run, not "p/m"',
  );
});

// Usefulness: effort is a separate flag for the other adapters, so it stays uncompared there.
test("restoreSessions ignores effort for a non-OpenCode role", () => {
  const next = roles({ worker: { kind: "claude", model: "opus", effort: "low", sessionId: null } });
  expect(() => restoreSessions(next, transcript(), CWD)).not.toThrow();
});

// Usefulness: a transcript whose events are not a list is rejected, because the
// same-path continuation appends to them.
test("readContinuation rejects events that are not a list", async () => {
  await expect(readJson({ ...transcript(), events: "x" })).rejects.toThrow("events");
});
