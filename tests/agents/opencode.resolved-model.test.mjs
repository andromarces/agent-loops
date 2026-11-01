import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { verifyResolvedModels } from "../../src/lib/continuation.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { logDebug, logInfo } from "../../src/lib/log.mjs";
import { readState, statePaths } from "../../src/lib/runstate.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role.mjs";
import { runLoop } from "../../src/runtime.mjs";
import { scripted } from "../agent-doubles.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { errorEvent, textEvent, trackDispatchPaths } from "./opencode-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(),
}));

// The dispatch path logs through several entry points, so the mock names them all
// rather than leaving the role and snapshot modules with undefined imports.
vi.mock("../../src/lib/log.mjs", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logInfoFull: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  setVerbose: vi.fn(),
  setLogsToStderr: vi.fn(),
}));

/** Runs root and temp repo for the dispatch test, removed after it. */

const dispatchPaths = trackDispatchPaths();

const assistantMessage = (id, model) => ({ id, type: "assistant", model, content: [] });

const exportJson = (...messages) => ({
  stdout: JSON.stringify({ info: { id: "sess-oc" }, messages }),
  stderr: "",
});

/** Runs one turn whose stream names the assistant messages `ids`, then the export reply `exported`. */

async function runResolvedTurn(state, ids, exported, options = { cwd: "/dir" }) {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: (ids.length ? ids.map((id) => textEvent("reply", id)) : [textEvent("reply")]).join(
      "\n",
    ),
    stderr: "",
  });
  if (exported instanceof Error) {
    vi.mocked(exec).mockRejectedValueOnce(exported);
  } else {
    vi.mocked(exec).mockResolvedValueOnce(exported);
  }
  return runOpenCode(state, "oc prompt", options);
}

const MODEL_A = { id: "model-a", providerID: "prov" };

const MODEL_B = { id: "model-b", providerID: "prov" };

// Usefulness: verifies the resolved model of a turn comes from the session export, for only the
// assistant messages that the turn streamed, so an earlier turn of the session never counts (#567).
test("opencode records provider/model of the streamed assistant messages as resolvedModel", async () => {
  const state = { kind: "opencode", sessionId: null, model: null };
  await runResolvedTurn(
    state,
    ["msg-2", "msg-3"],
    exportJson(
      assistantMessage("msg-1", MODEL_B),
      assistantMessage("msg-2", MODEL_A),
      assistantMessage("msg-3", MODEL_A),
    ),
  );

  expect(state.resolvedModel).toBe("prov/model-a");
  expect(vi.mocked(exec)).toHaveBeenLastCalledWith("opencode", ["session", "export", "sess-oc"], {
    cwd: "/dir",
    timeout: undefined,
    signal: undefined,
    role: undefined,
  });
});

// Usefulness: verifies a turn that ran several models, or whose message is missing from the export,
// is unresolved, so the continuation never compares against ambiguous evidence.
test.each([
  [
    "several models",
    exportJson(assistantMessage("msg-1", MODEL_A), assistantMessage("msg-2", MODEL_B)),
  ],
  ["a streamed message missing from the export", exportJson(assistantMessage("msg-1", MODEL_A))],
  [
    "a malformed model",
    exportJson(assistantMessage("msg-1", MODEL_A), assistantMessage("msg-2", { id: 7 })),
  ],
  ["an export that is not JSON", { stdout: "not json", stderr: "" }],
  ["an export that failed", new Error("export failed")],
])("opencode records resolvedModel null for %s", async (_name, exported) => {
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  await runResolvedTurn(state, ["msg-1", "msg-2"], exported);

  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies a turn that streams no message id records null instead of guessing from the
// export of the whole session.
test("opencode records resolvedModel null when the stream names no message", async () => {
  const state = { kind: "opencode", sessionId: null, model: null };
  await runResolvedTurn(state, [], exportJson(assistantMessage("msg-1", MODEL_A)));

  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies a failed turn that ran replaces the earlier model with null, because the
// failed stream carries no model and the export is not read after a failure.
test("opencode records resolvedModel null for a failed turn", async () => {
  vi.mocked(exec).mockReset();
  const failure = Object.assign(new Error("boom"), { name: "ExecError", exitCode: 1, stdout: "" });
  vi.mocked(exec).mockRejectedValueOnce(failure);
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };

  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow();

  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies a failed start leaves the earlier record, because no model ran.
test("opencode keeps resolvedModel when the child never started", async () => {
  vi.mocked(exec).mockReset();
  const failure = Object.assign(new Error("spawn"), { name: "ExecError", stdout: "" });
  vi.mocked(exec).mockRejectedValueOnce(failure);
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };

  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow();

  expect(state.resolvedModel).toBe("prov/model-a");
});

// Usefulness: verifies output from another session than the retained one is unresolved and never
// read as the kept session's model.
test("opencode records resolvedModel null when the output reports another session", async () => {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("reply", "msg-1"), stderr: "" });
  vi.mocked(exec).mockResolvedValueOnce(exportJson(assistantMessage("msg-1", MODEL_A)));
  const state = { kind: "opencode", sessionId: "other-sess", model: null, resolvedModel: "x/y" };

  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow();

  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies --continue-from now probes an opencode role, so a changed default model is refused.
test("opencode role with a recorded model is probed and a changed model is refused", async () => {
  const roles = {
    orchestrator: { kind: "codex", resolvedModel: undefined },
    worker: { kind: "opencode", model: null, effort: null, resolvedModel: "prov/model-a" },
    reviewer: { kind: "codex", resolvedModel: undefined },
  };
  const probe = vi.fn(async (state) => {
    state.resolvedModel = "prov/model-b";
  });

  await expect(verifyResolvedModels(roles, { probe })).rejects.toThrow(/prov\/model-b/);
  expect(probe).toHaveBeenCalledTimes(1);
});

/** Runs one turn on `stream` lines, with the export queued, and returns the state and the error. */

async function runStreamTurn(lines, state, options = { cwd: "/dir" }) {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockResolvedValueOnce({ stdout: lines.join("\n"), stderr: "" });
  vi.mocked(exec).mockResolvedValueOnce(exportJson(assistantMessage("msg-1", MODEL_A)));
  const error = await runOpenCode(state, "oc prompt", options).then(
    () => undefined,
    (err) => err,
  );
  return { error, exportCalls: vi.mocked(exec).mock.calls.length - 1 };
}

// Usefulness: verifies a turn that fails after exit 0 (an error event, or no response text) records
// null and never reads the export, so a failed turn keeps no model (#567 blocker 2).
test.each([
  [
    "an error event",
    [
      textEvent("partial", "msg-1"),
      errorEvent({ type: "ProviderError", message: "provider failed" }),
    ],
  ],
  [
    "no response text",
    [
      JSON.stringify({
        type: "step_start",
        sessionID: "sess-oc",
        part: { type: "step-start", messageID: "msg-1" },
      }),
    ],
  ],
])("opencode records null and skips the export for a turn with %s", async (_name, lines) => {
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  const { error, exportCalls } = await runStreamTurn(lines, state);

  expect(error).toBeInstanceOf(Error);
  expect(exportCalls).toBe(0);
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies a stream that does not confirm one session on every event never reaches the
// export on a guessed id, and the model stays null (#567 blocker 3).
test.each([
  [
    "an event with another session id",
    [textEvent("a", "msg-1"), textEvent("b", "msg-1").replace("sess-oc", "sess-other")],
  ],
  [
    "an event with no session id",
    [
      textEvent("a", "msg-1"),
      JSON.stringify({ type: "text", part: { text: "b", messageID: "msg-1" } }),
    ],
  ],
  [
    "a part with another session id",
    [
      textEvent("a", "msg-1"),
      JSON.stringify({
        type: "text",
        sessionID: "sess-oc",
        part: { text: "b", messageID: "msg-1", sessionID: "sess-other" },
      }),
    ],
  ],
])("opencode skips the export and records null for %s", async (_name, lines) => {
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  const { exportCalls } = await runStreamTurn(lines, state);

  expect(exportCalls).toBe(0);
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies the export runs under the cancel signal and the time the invocation has
// left, as the turn does (#567 blocker 1).
test("opencode bounds the export by the remaining timeout and passes the cancel signal", async () => {
  const now = vi.spyOn(Date, "now");
  now.mockReturnValueOnce(1_000_000).mockReturnValue(1_004_000);
  const controller = new AbortController();
  const state = { kind: "opencode", sessionId: null, model: null };
  try {
    await runResolvedTurn(state, ["msg-1"], exportJson(assistantMessage("msg-1", MODEL_A)), {
      cwd: "/dir",
      timeout: 10,
      signal: controller.signal,
      role: "worker",
    });
  } finally {
    now.mockRestore();
  }

  expect(state.resolvedModel).toBe("prov/model-a");
  expect(vi.mocked(exec).mock.calls.at(-1)[2]).toEqual({
    cwd: "/dir",
    timeout: 6,
    signal: controller.signal,
    role: "worker",
  });
});

// Usefulness: verifies a spent timeout skips the export and leaves the turn result alone.
test("opencode skips the export when the invocation timeout is spent", async () => {
  const now = vi.spyOn(Date, "now");
  now.mockReturnValueOnce(1_000_000).mockReturnValue(1_011_000);
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  let response;
  try {
    response = await runResolvedTurn(
      state,
      ["msg-1"],
      exportJson(assistantMessage("msg-1", MODEL_A)),
      {
        cwd: "/dir",
        timeout: 10,
      },
    );
  } finally {
    now.mockRestore();
  }

  expect(response).toBe("reply");
  expect(vi.mocked(exec)).toHaveBeenCalledTimes(1);
  expect(state.resolvedModel).toBeNull();
});

const EXPORT_SECRET_TEXT = "private transcript text of the session";

// Usefulness: verifies a canceled or failed export leaks none of its content into an error or a log
// and never discards the completed turn response (#567 blocker 1).
test.each([
  ["a timed out export", { timedOut: true }],
  ["a failed export", { exitCode: 1 }],
])("opencode keeps the response and leaks no export content for %s", async (_name, flags) => {
  const failure = Object.assign(new Error(`opencode failed\n\n${EXPORT_SECRET_TEXT}`), {
    name: "ExecError",
    stdout: EXPORT_SECRET_TEXT,
    stderr: EXPORT_SECRET_TEXT,
    ...flags,
  });
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  const response = await runResolvedTurn(state, ["msg-1"], failure);

  expect(response).toBe("reply");
  expect(state.resolvedModel).toBeNull();
  const logged = [logDebug, logInfo].flatMap((fn) => vi.mocked(fn).mock.calls.flat());
  expect(JSON.stringify([state, logged])).not.toContain(EXPORT_SECRET_TEXT);
});

// Usefulness: verifies an export that cannot prove which assistant message belongs to the turn
// records null: a message with no valid id, or two messages with the same id (#567 blocker 2).
test.each([
  [
    "an assistant message with no id",
    exportJson(assistantMessage("msg-1", MODEL_A), { type: "assistant", model: MODEL_B }),
  ],
  [
    "an assistant message with a non-string id",
    exportJson(assistantMessage("msg-1", MODEL_A), assistantMessage(7, MODEL_B)),
  ],
  [
    "an empty message id",
    exportJson(assistantMessage("msg-1", MODEL_A), assistantMessage("", MODEL_B)),
  ],
  [
    "a repeated message id",
    exportJson(assistantMessage("msg-1", MODEL_A), assistantMessage("msg-1", MODEL_B)),
  ],
  ["a message that is not an object", exportJson(assistantMessage("msg-1", MODEL_A), null)],
])("opencode records resolvedModel null for %s", async (_name, exported) => {
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  await runResolvedTurn(state, ["msg-1"], exported);

  expect(state.resolvedModel).toBeNull();
});

// Usefulness: verifies a model value that holds a secret environment value is never recorded, so the
// transcript and the refusal message cannot echo it (#567 blocker 4).
test("opencode records null for an exported model that holds a secret environment value", async () => {
  vi.stubEnv("OPENCODE_TEST_API_KEY", "sk-live-0123456789abcdef");
  try {
    const state = { kind: "opencode", sessionId: null, model: null };
    await runResolvedTurn(
      state,
      ["msg-1"],
      exportJson(assistantMessage("msg-1", { id: "sk-live-0123456789abcdef", providerID: "prov" })),
    );

    expect(JSON.stringify(state)).not.toContain("sk-live-0123456789abcdef");
    expect(state.resolvedModel).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});

const EXPORT_LEAK = "private transcript text of the session";

/** An export failure shaped like the `exec` error of a canceled call, with session content in its text. */

const canceledExport = () =>
  Object.assign(new Error(`opencode was canceled.\n\n${EXPORT_LEAK}`), {
    name: "ExecError",
    isCanceled: true,
    stdout: EXPORT_LEAK,
    stderr: EXPORT_LEAK,
  });

/**
 * Queues the two opencode calls of one turn: the stream, then the export. `landing` says where the
 * cancel lands: "export" cancels while the export runs, "before" cancels right after the turn child
 * exits, so the export finds the signal already aborted.
 */

function queueCancel(controller, landing) {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockImplementationOnce(async () => {
    if (landing === "before") controller.abort();
    return { stdout: textEvent("reply", "msg-1"), stderr: "" };
  });
  vi.mocked(exec).mockImplementationOnce(async () => {
    controller.abort();
    throw canceledExport();
  });
}

// Usefulness: verifies a cancel that lands during or before the export ends `role dispatch` as an
// interrupted turn with exit 130 and an error status, the same as a cancel of the turn child, and
// that no export content reaches the envelope, the state file, or a log (#567).
test.each([["export"], ["before"]])(
  "role dispatch ends interrupted with exit 130 when a cancel lands at the %s",
  async (landing) => {
    const runsRoot = await mkdtemp(join(tmpdir(), "opencode-test-runs-"));
    dispatchPaths.push(runsRoot);
    const repo = await createTempRepo();
    dispatchPaths.push(repo);
    process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
    const agents = { opencode: { run: runOpenCode } };
    const stdin = async () => "continue working";
    vi.mocked(exec).mockResolvedValue({ stdout: "", stderr: "" });
    await executeRoleCommand(
      parseRoleArgs([
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        "--task",
        "Cancel the export.",
        "--parent-session",
        "sess-parent-1",
        "--worker",
        "opencode",
        "--reviewer",
        "opencode",
      ]),
      { agents, stdin },
    );

    const controller = new AbortController();
    queueCancel(controller, landing);
    const result = await executeRoleCommand(
      parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo]),
      { agents, stdin, signal: controller.signal },
    );

    const state = await readState(statePaths({ cwd: repo }).stateFile);
    expect(result.exitCode).toBe(130);
    expect(result.payload.status).toBe("error");
    expect(state.lifecycle).toBe("interrupted");
    expect(state.roles.worker.sessionId).toBe("sess-oc");
    expect(state.roles.worker.resolvedModel ?? null).toBeNull();
    const logged = [logDebug, logInfo].flatMap((fn) => vi.mocked(fn).mock.calls.flat());
    expect(JSON.stringify([result, state, logged])).not.toContain(EXPORT_LEAK);
  },
);

// Usefulness: verifies the same cancel in the headless loop rejects with the cancel error, which the
// CLI maps to exit 130, instead of returning exit 0, and starts no further child turn.
test.each([["export"], ["before"]])(
  "the headless loop ends canceled and starts no further turn when a cancel lands at the %s",
  async (landing) => {
    const repo = await createTempRepo();
    dispatchPaths.push(repo);
    const controller = new AbortController();
    queueCancel(controller, landing);
    const orchestrator = scripted([
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);

    const error = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      signal: controller.signal,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "opencode", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchestrator, opencode: { run: runOpenCode }, rev: scripted([]) },
    }).then(
      () => undefined,
      (err) => err,
    );

    expect(error?.isCanceled).toBe(true);
    expect(`${error?.message}\n${error?.stack}`).not.toContain(EXPORT_LEAK);
    expect(orchestrator.recorded).toHaveLength(1);
    expect(vi.mocked(exec)).toHaveBeenCalledTimes(landing === "export" ? 2 : 1);
  },
);

// Usefulness: verifies a stream event with no valid message id leaves the turn unresolved and never
// reaches the export, so the export alone cannot decide which messages belong to the turn (#567).
test.each([
  ["a text event with no message id", [textEvent("a", "msg-1"), textEvent("b")]],
  ["a text event with a non-string message id", [textEvent("a", "msg-1"), textEvent("b", 7)]],
  ["a text event with an empty message id", [textEvent("a", "msg-1"), textEvent("b", "")]],
  [
    "a step event with no message id",
    [
      textEvent("a", "msg-1"),
      JSON.stringify({ type: "step_start", sessionID: "sess-oc", part: { type: "step-start" } }),
    ],
  ],
])("opencode skips the export and records null for %s", async (_name, lines) => {
  const state = { kind: "opencode", sessionId: null, model: null, resolvedModel: "prov/model-a" };
  const { exportCalls } = await runStreamTurn(lines, state);

  expect(exportCalls).toBe(0);
  expect(state.resolvedModel).toBeNull();
});

const POST_EXIT_STREAMS = [
  ["an invalid stream message id", [textEvent("a", "msg-1"), textEvent("b")]],
  ["no session id", [JSON.stringify({ type: "text", part: { text: "a", messageID: "msg-1" } })]],
  [
    "an error event",
    [textEvent("a", "msg-1"), errorEvent({ type: "ProviderError", message: "provider failed" })],
  ],
  [
    "no response text",
    [
      JSON.stringify({
        type: "step_start",
        sessionID: "sess-oc",
        part: { type: "step-start", messageID: "msg-1" },
      }),
    ],
  ],
];

/** Queues one turn whose cancel lands right after the child exits, with `lines` as its stream. */

function queueLateCancel(controller, lines) {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockImplementationOnce(async () => {
    controller.abort();
    return { stdout: lines.join("\n"), stderr: "" };
  });
}

// Usefulness: verifies a cancel that lands after the child exits ends `role dispatch` interrupted
// with exit 130 on every adapter return path, not only the export path, so a validation return never
// reads as active/ok (#567).
test.each(POST_EXIT_STREAMS)(
  "role dispatch ends interrupted with exit 130 for a late cancel and %s",
  async (_name, lines) => {
    const runsRoot = await mkdtemp(join(tmpdir(), "opencode-test-runs-"));
    dispatchPaths.push(runsRoot);
    const repo = await createTempRepo();
    dispatchPaths.push(repo);
    process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
    const agents = { opencode: { run: runOpenCode } };
    const stdin = async () => "continue working";
    vi.mocked(exec).mockResolvedValue({ stdout: "", stderr: "" });
    await executeRoleCommand(
      parseRoleArgs([
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        "--task",
        "Cancel late.",
        "--parent-session",
        "sess-parent-1",
        "--worker",
        "opencode",
        "--reviewer",
        "opencode",
      ]),
      { agents, stdin },
    );

    const controller = new AbortController();
    queueLateCancel(controller, lines);
    const result = await executeRoleCommand(
      parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo]),
      { agents, stdin, signal: controller.signal },
    );

    const state = await readState(statePaths({ cwd: repo }).stateFile);
    expect(result.exitCode).toBe(130);
    expect(result.payload.status).toBe("error");
    expect(state.lifecycle).toBe("interrupted");
    expect(vi.mocked(exec)).toHaveBeenCalledTimes(1);
  },
);

// Usefulness: verifies the same late cancel rejects the headless loop with the cancel error on every
// return path and asks the orchestrator for no further action.
test.each(POST_EXIT_STREAMS)(
  "the headless loop ends canceled for a late cancel and %s",
  async (_name, lines) => {
    const repo = await createTempRepo();
    dispatchPaths.push(repo);
    const controller = new AbortController();
    queueLateCancel(controller, lines);
    const orchestrator = scripted([
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);

    const error = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      signal: controller.signal,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "opencode", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchestrator, opencode: { run: runOpenCode }, rev: scripted([]) },
    }).then(
      () => undefined,
      (err) => err,
    );

    expect(error?.isCanceled).toBe(true);
    expect(orchestrator.recorded).toHaveLength(1);
    expect(vi.mocked(exec)).toHaveBeenCalledTimes(1);
  },
);
