import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { readStateForSession } from "../../src/lib/runstate.mjs";
import { decideParentGuard } from "../../src/hook/decision.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role.mjs";
import { createTempRepo } from "../runtime-helpers.mjs";

let runsRoot;
const repos = [];

async function setup() {
  runsRoot = await mkdtemp(join(tmpdir(), "parent-guard-test-runs-"));
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
}

afterEach(async () => {
  if (runsRoot === undefined) {
    return;
  }
  delete process.env.AGENT_LOOP_RUNS_ROOT;
  for (const dir of repos) {
    await rm(dir, { recursive: true, force: true });
  }
  repos.length = 0;
  await rm(runsRoot, { recursive: true, force: true });
  runsRoot = undefined;
});

const noopAdapter = {
  async run() {
    return "";
  },
};

const INIT_OVERRIDES = [
  "--task",
  "Fix the flaky test.",
  "--parent-session",
  "parent-sess-1",
  "--worker",
  "fake1",
  "--reviewer",
  "fake2",
];

// Usefulness: verifies the acceptance matrix — the matching parent session is
// denied in every non-terminal lifecycle (active, dispatched, interrupted),
// while a different session id, a terminal lifecycle, a state without
// parentSession, and a missing index entry or missing state file all allow.
test("deny matrix: non-terminal parent denied, every other record allowed", async () => {
  for (const [name, state, sessionId, expected] of [
    ["active parent", { parentSession: "p1", lifecycle: "active" }, "p1", "deny"],
    ["dispatched parent", { parentSession: "p1", lifecycle: "dispatched" }, "p1", "deny"],
    ["interrupted parent", { parentSession: "p1", lifecycle: "interrupted" }, "p1", "deny"],
    ["different session", { parentSession: "p1", lifecycle: "active" }, "p2", "allow"],
    ["terminal lifecycle", { parentSession: "p1", lifecycle: "aborted" }, "p1", "allow"],
    ["missing parentSession", { lifecycle: "active" }, "p1", "allow"],
  ]) {
    const verdict = await decideParentGuard(sessionId, {
      lookup: async () => state,
    });
    expect(verdict.decision, name).toBe(expected);
  }

  const absent = await decideParentGuard("p1", { lookup: async () => null });
  expect(absent.decision).toBe("allow");
});

// Usefulness: verifies acceptance — the deny decision names the orchestrator
// mode so the parent learns the rule from the denial reason.
test("deny decision names the orchestrator mode", async () => {
  const verdict = await decideParentGuard("p1", {
    lookup: async () => ({ parentSession: "p1", lifecycle: "active" }),
  });
  expect(verdict.reason).toMatch(/orchestrator/);
});

// Usefulness: verifies acceptance — a #55 init call for a different `--cwd`
// registers the state under the parent session, so the guard denies the parent
// even though the lookup never consults the hook cwd; a second session in the
// same cwd finds no index entry and is allowed. Exercises the real
// `readStateForSession` on both sides, not a stub.
test("index lookup finds the init state file written for a different --cwd", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const init = await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo, ...INIT_OVERRIDES]),
    { agents: { fake1: noopAdapter, fake2: noopAdapter }, stdin: async () => "work" },
  );
  expect(init.exitCode).toBe(0);

  // The state registered for parent-sess-1 points at the repo state file, whose
  // cwd is the dispatch --cwd, unrelated to any hook cwd.
  const state = await readStateForSession("parent-sess-1");
  expect(state.parentSession).toBe("parent-sess-1");
  expect(state.cwd).toBe(repo);

  expect((await decideParentGuard("parent-sess-1")).decision).toBe("deny");
  // A session with no index entry takes the fail-open path through the real
  // lookup, which returns null on absence.
  expect((await decideParentGuard("unrelated-session")).decision).toBe("allow");
});

function runHookScript(inputJson) {
  return new Promise((resolveProcess) => {
    const script = fileURLToPath(new URL("../../src/hook/parent-guard.mjs", import.meta.url));
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      resolveProcess({ code, stdout });
    });
    child.stdin.end(inputJson);
  });
}

// Usefulness: verifies the hook contract end to end — deny prints exactly one
// PreToolUse JSON decision on stdout, an unguarded session prints nothing and
// exits 0, and unparseable input fails open.
test("hook script denies with PreToolUse JSON and stays silent otherwise", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo, ...INIT_OVERRIDES]),
    { agents: { fake1: noopAdapter, fake2: noopAdapter }, stdin: async () => "work" },
  );

  const denied = await runHookScript(
    JSON.stringify({ session_id: "parent-sess-1", tool_name: "Edit" }),
  );
  expect(denied.code).toBe(0);
  const decision = JSON.parse(denied.stdout);
  expect(decision.hookSpecificOutput).toMatchObject({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  });
  expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(/orchestrator/);

  const allowed = await runHookScript(JSON.stringify({ session_id: "other", tool_name: "Write" }));
  expect(allowed.code).toBe(0);
  expect(allowed.stdout).toBe("");

  const unparseable = await runHookScript("not json");
  expect(unparseable.code).toBe(0);
  expect(unparseable.stdout).toBe("");

  // A malformed session id throws inside the real lookup (runstate rejects
  // path separators); the hook must still exit 0 with no output, not leak the
  // error into the session.
  const malformed = await runHookScript(
    JSON.stringify({ session_id: "../../etc/passwd", tool_name: "Edit" }),
  );
  expect(malformed.code).toBe(0);
  expect(malformed.stdout).toBe("");

  const nullSession = await runHookScript(JSON.stringify({ session_id: null, tool_name: "Write" }));
  expect(nullSession.code).toBe(0);
  expect(nullSession.stdout).toBe("");
});
