import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { readStateForSession, statePaths } from "../../src/lib/runstate.mjs";
import { GUARD_DENY_REASON, decideParentGuard } from "../../src/hook/decision.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role.mjs";
import parentGuardPlugin, { EDIT_ACTIONS } from "../../.opencode/plugins/parent-guard.ts";
import { createTempRepo } from "../runtime-helpers.mjs";

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

const INIT_AGENTS = { fake1: noopAdapter, fake2: noopAdapter };
const FINISH_SUMMARY = JSON.stringify({
  changed: "x",
  verified: "y",
  deferred: "z",
  notDone: "n",
  open: "o",
});

/**
 * Loads the OpenCode plugin against a fake context and captures the hooks and
 * the command it registers, mirroring the shapes OpenCode passes at runtime.
 */
async function loadPlugin() {
  const hooks = {};
  const commands = [];
  const prompts = [];
  await parentGuardPlugin.setup({
    command: {
      transform: async (register) => {
        register({ add: (command) => commands.push(command) });
      },
    },
    session: {
      prompt: async (input) => {
        prompts.push(input);
      },
    },
    permission: {
      hook: async (name, handler) => {
        hooks[name] = handler;
      },
    },
  });
  return { hooks, commands, prompts };
}

/** Registers a run under "parent-sess-1" against a fresh temp repo. */
async function initRunForParent() {
  const repo = await createTempRepo();
  repos.push(repo);
  await initRunAt(repo);
  return repo;
}

/** Runs the init dispatch for "parent-sess-1" against an existing repo. */
async function initRunAt(repo) {
  const init = await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo, ...INIT_OVERRIDES]),
    { agents: INIT_AGENTS, stdin: async () => "work" },
  );
  expect(init.exitCode).toBe(0);
}

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

function runCopilotHookScript(inputJson) {
  return new Promise((resolveProcess) => {
    const script = fileURLToPath(
      new URL("../../src/hook/copilot-parent-guard.mjs", import.meta.url),
    );
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
// Usefulness: verifies the Claude and Codex hook contracts end to end — deny prints
// one PreToolUse JSON decision on stdout, an unguarded session prints nothing,
// and unparseable input fails open.

test("hook script denies with PreToolUse JSON and stays silent otherwise", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo, ...INIT_OVERRIDES]),
    { agents: { fake1: noopAdapter, fake2: noopAdapter }, stdin: async () => "work" },
  );

  for (const toolName of ["Edit", "apply_patch"]) {
    const denied = await runHookScript(
      JSON.stringify({ session_id: "parent-sess-1", tool_name: toolName }),
    );
    expect(denied.code, toolName).toBe(0);
    const decision = JSON.parse(denied.stdout);
    expect(decision.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: GUARD_DENY_REASON,
    });
  }

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

// Usefulness: verifies the Copilot command-hook contract — the PascalCase
// PreToolUse payload uses session_id and the deny output is the flat
// permissionDecision object that Copilot CLI consumes.
test("Copilot hook denies the matching session with its PreToolUse JSON shape", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo, ...INIT_OVERRIDES]),
    { agents: { fake1: noopAdapter, fake2: noopAdapter }, stdin: async () => "work" },
  );

  const denied = await runCopilotHookScript(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "parent-sess-1",
      tool_name: "Write",
      tool_input: { path: "README.md" },
    }),
  );
  expect(denied.code).toBe(0);
  expect(JSON.parse(denied.stdout)).toEqual({
    permissionDecision: "deny",
    permissionDecisionReason: expect.stringMatching(/orchestrator/),
  });

  const allowed = await runCopilotHookScript(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "unrelated-session",
      tool_name: "Write",
    }),
  );
  expect(allowed.code).toBe(0);
  expect(allowed.stdout).toBe("");

  const malformed = await runCopilotHookScript("not json");
  expect(malformed.code).toBe(0);
  expect(malformed.stdout).toBe("");

  const finish = await executeRoleCommand(parseRoleArgs(["finish", "--cwd", repo]), {
    agents: INIT_AGENTS,
    stdin: async () => FINISH_SUMMARY,
  });
  expect(finish.exitCode).toBe(0);
  const afterFinish = await runCopilotHookScript(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "parent-sess-1",
      tool_name: "Edit",
    }),
  );
  expect(afterFinish.code).toBe(0);
  expect(afterFinish.stdout).toBe("");

  await initRunAt(repo);
  const abort = await executeRoleCommand(
    parseRoleArgs(["abort", "--cwd", repo, "--reason", "test"]),
    { agents: INIT_AGENTS },
  );
  expect(abort.exitCode).toBe(0);
  const afterAbort = await runCopilotHookScript(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "parent-sess-1",
      tool_name: "Edit",
    }),
  );
  expect(afterAbort.code).toBe(0);
  expect(afterAbort.stdout).toBe("");
});

// Usefulness: verifies the OpenCode guard's acceptance over the full action set
// it denies — every edit action from the registered parent is denied while the
// run is non-terminal, the same actions from a different session are never
// blocked, and `shell` stays allowed.
test("opencode guard denies the registered parent's edit action set and allows every other call", async () => {
  await setup();
  await initRunForParent();
  const { hooks } = await loadPlugin();

  for (const action of EDIT_ACTIONS) {
    const denied = { action, sessionID: "parent-sess-1", effect: "allow", resources: [] };
    await hooks.evaluate(denied);
    expect(denied.effect, action).toBe("deny");
    expect(denied.message).toMatch(/orchestrator/);

    const other = { action, sessionID: "unrelated-session", effect: "allow", resources: [] };
    await hooks.evaluate(other);
    expect(other.effect, action).toBe("allow");
  }

  const shell = { action: "shell", sessionID: "parent-sess-1", effect: "allow", resources: [] };
  await hooks.evaluate(shell);
  expect(shell.effect).toBe("allow");
});

// Usefulness: verifies the release half of the acceptance — the same parent
// session edits without a block once the run is finished or aborted, because
// both lifecycles are terminal.
test("opencode guard releases the parent after finish and after abort", async () => {
  await setup();
  const repo = await initRunForParent();
  const { hooks } = await loadPlugin();

  const finish = await executeRoleCommand(parseRoleArgs(["finish", "--cwd", repo]), {
    agents: INIT_AGENTS,
    stdin: async () => FINISH_SUMMARY,
  });
  expect(finish.exitCode).toBe(0);
  const afterFinish = {
    action: "edit",
    sessionID: "parent-sess-1",
    effect: "allow",
    resources: [],
  };
  await hooks.evaluate(afterFinish);
  expect(afterFinish.effect).toBe("allow");

  // A second run registers the same session again; abort is the other terminal
  // lifecycle and must release the guard as well.
  await initRunAt(repo);
  const abort = await executeRoleCommand(
    parseRoleArgs(["abort", "--cwd", repo, "--reason", "test"]),
    { agents: INIT_AGENTS },
  );
  expect(abort.exitCode).toBe(0);
  const afterAbort = { action: "edit", sessionID: "parent-sess-1", effect: "allow", resources: [] };
  await hooks.evaluate(afterAbort);
  expect(afterAbort.effect).toBe("allow");
});

// Usefulness: verifies the fail-open half of the acceptance — a session with no
// record and a corrupt record both leave the normal permission flow intact.
test("opencode guard fails open on an absent or corrupt record", async () => {
  await setup();
  const { hooks } = await loadPlugin();

  const absent = { action: "edit", sessionID: "never-registered", effect: "allow", resources: [] };
  await hooks.evaluate(absent);
  expect(absent.effect).toBe("allow");

  const repo = await initRunForParent();
  await writeFile(statePaths({ cwd: repo }).stateFile, "{ not json", "utf8");
  const corrupt = { action: "edit", sessionID: "parent-sess-1", effect: "allow", resources: [] };
  await hooks.evaluate(corrupt);
  expect(corrupt.effect).toBe("allow");
});

// Usefulness: pins the guard's registration to the documented `evaluate` hook
// name. `permission.hook()` accepts any name silently, so a typo in the name
// would remove the guard while every behavioral test still passed.
test("opencode guard registers the documented evaluate permission hook", async () => {
  const { hooks } = await loadPlugin();
  expect(Object.keys(hooks)).toEqual(["evaluate"]);
});

// Usefulness: verifies the OpenCode session-id channel — the plugin command
// reads CommandInvocation.sessionID and carries it into the orchestrator prompt
// so the init dispatch call can register the run under that session.
test("opencode plugin command injects the parent session id into the prompt", async () => {
  const { commands, prompts } = await loadPlugin();
  const command = commands.find((candidate) => candidate.name === "agent-loop");
  expect(command).toBeTruthy();

  await command.execute({
    sessionID: "ses_opencode_parent",
    prompt: { text: "Implement the change." },
    delivery: "steer",
  });

  expect(prompts).toHaveLength(1);
  expect(prompts[0].sessionID).toBe("ses_opencode_parent");
  expect(prompts[0].text).toContain("docs/orchestrator-instructions.md");
  expect(prompts[0].text).toContain("ses_opencode_parent");
  expect(prompts[0].text).toContain("--parent-session");
  expect(prompts[0].text).toContain("Implement the change.");
});
