import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand, main as runRoleMain } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  REPORT,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

// Usefulness: verifies acceptance — two consecutive worker dispatches resume
// the same worker session; the adapter receives the persisted session id on
// the second call.
test("two consecutive worker dispatches resume the same worker session", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  const first = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(first.exitCode).toBe(0);
  expect(first.payload).toMatchObject({
    role: "worker",
    status: "ok",
    report: { conclusion: "done", why: "tests pass", blockers: "none" },
  });

  const second = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(second.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(2);
  expect(worker.recorded[1].incomingSessionId).toBe("sess-1");

  const state = await readRepoState(repo);
  expect(state).toMatchObject({ stepsUsed: 2, lifecycle: "active" });
  expect(state.roles.worker.sessionId).toBe("sess-1");
});

// Usefulness: verifies acceptance — after an init call with --cwd set to a
// directory other than the process cwd, the session index for --parent-session
// resolves to that run's state file through the shared helper.
test("session index resolves a run dispatched into a different --cwd", async () => {
  const runsRoot = await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });

  const indexFile = statePaths({ parentSession: "parent-sess-1" }).sessionIndexFile;
  expect(indexFile).toBe(join(runsRoot, "sessions", "parent-sess-1"));
  // The index holds the state file path; resolving it must reach the run that
  // was dispatched with --cwd pointing elsewhere.
  const stateFile = (await readFile(indexFile, "utf8")).trim();
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  expect(state).toMatchObject({ task: "Fix the flaky test.", cwd: repo });
});

// Usefulness: verifies acceptance — a worker dispatch under mode review-only
// exits non-zero and spawns no CLI.
test("review-only mode rejects a worker dispatch without spawning a CLI", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const init = withRepo(
    dispatchArgv(
      [
        "--task",
        "Review only.",
        "--parent-session",
        "parent-sess-1",
        "--mode",
        "review-only",
        "--worker",
        "fake1",
        "--reviewer",
        "fake2",
      ],
      "reviewer",
    ),
    repo,
  );
  await executeRoleCommand(init, {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  const state = await readRepoState(repo);
  expect(state.mode).toBe("review-only");

  const worker = recordingAdapter([]);
  const rejected = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents: { fake1: worker, fake2: worker },
    stdin: stdinPrompt,
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("mode review-only rejects --role worker");
  expect(worker.recorded.length).toBe(0);
  expect((await readRepoState(repo)).stepsUsed).toBe(state.stepsUsed);
});

// Usefulness: verifies acceptance — a later call that supplies --worker against
// the null worker of a review-only run is rejected as a change after init
// instead of throwing on the missing role.
test("a later --worker against a null review-only worker is rejected", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const init = withRepo(
    dispatchArgv(
      [
        "--task",
        "Review only.",
        "--parent-session",
        "parent-sess-1",
        "--mode",
        "review-only",
        "--reviewer",
        "fake2",
      ],
      "reviewer",
    ),
    repo,
  );
  await executeRoleCommand(init, {
    agents: { fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker", "fake1"], "reviewer"), repo),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--worker cannot be changed after init");
});

// Usefulness: verifies acceptance — a dispatch past the step budget or in any
// terminal lifecycle exits non-zero and spawns no CLI.
test("dispatch past the step budget or in a terminal lifecycle is rejected", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };
  const first = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "1"]), repo),
    {
      agents,
      stdin: stdinPrompt,
    },
  );
  expect(first.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(1);

  const over = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(over.exitCode).toBe(1);
  expect(over.payload.error).toContain("Step budget exhausted");
  expect(worker.recorded.length).toBe(1);
  expect((await readRepoState(repo)).stepsUsed).toBe(1);

  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  const terminal = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(terminal.exitCode).toBe(1);
  expect(terminal.payload.error).toContain("aborted");
  expect(worker.recorded.length).toBe(1);
});

// Usefulness: verifies the dispatch seam — the parsed verdict and report reach
// the payload, and the reviewer session id is recorded in state. Parser edge
// cases are unit-tested in tests/lib/report.test.mjs.
test("reviewer dispatch exposes the parsed verdict in the payload", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-9";
    return `${REPORT}\nVerdict: accept`;
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const args = withRepo(dispatchArgv([], "reviewer"), repo);
  const result = await executeRoleCommand(args, {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.verdict).toBe("accept");
  expect(result.payload.report).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
  });

  const state = await readRepoState(repo);
  expect(state.roles.reviewer.sessionId).toBe("rev-9");
  expect(state.lastResult.status).toBe("ok");
});

// Usefulness: verifies the dispatch seam when the closing block does not parse
// — the payload carries a null report and the raw response, so a caller can
// still inspect what the child returned instead of guessing.
test("reviewer dispatch exposes a null report and the raw response when the block does not parse", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-raw";
    return "looks fine, but no verdict line here";
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.verdict).toBe("unknown");
  expect(result.payload.raw).toContain("looks fine");
});

// Usefulness: verifies --transcript appends one invocation and one result
// event per dispatched turn, in the headless event shape, accumulated across
// calls.
test("dispatch appends invocation and result events to the transcript", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  const transcriptPath = join(paths.stateDir, "transcript.jsonl");

  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--transcript", transcriptPath]), repo),
    basicDeps(),
  );
  await executeRoleCommand(
    withRepo(dispatchArgv(["--transcript", transcriptPath]), repo),
    basicDeps(),
  );

  const events = (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  expect(events.map((event) => `${event.type}:${event.role}`)).toEqual([
    "invocation:worker",
    "result:worker",
    "invocation:worker",
    "result:worker",
  ]);
  for (const event of events) {
    expect(event.at).toEqual(expect.any(String));
    expect(event.stepsUsed).toEqual(expect.any(Number));
  }
});

// Usefulness: verifies --prompt-file feeds the child prompt instead of stdin.
test("dispatch reads the prompt from --prompt-file", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const promptFile = join(repo, "prompt.txt");
  await writeFile(promptFile, "work from the file", "utf8");

  const worker = recordingAdapter([]);
  const args = withRepo(
    dispatchArgv([
      "--task",
      "Task.",
      "--parent-session",
      "parent-sess-1",
      "--worker",
      "fake1",
      "--reviewer",
      "fake2",
      "--prompt-file",
      promptFile,
    ]),
    repo,
  );
  await executeRoleCommand(args, { agents: { fake1: worker, fake2: recordingAdapter([]) } });
  expect(worker.recorded[0].prompt).toContain("work from the file");
});

// Usefulness: verifies later calls read configuration from the state file —
// an identical repeated flag passes through, a changed one is rejected with
// the change message.
test("later dispatch rejects changed init flags and accepts identical ones", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "5"]), repo),
    basicDeps(),
  );

  const identical = await executeRoleCommand(
    withRepo(dispatchArgv(["--max-steps", "5"]), repo),
    basicDeps(),
  );
  expect(identical.exitCode).toBe(0);

  const changed = await executeRoleCommand(
    withRepo(dispatchArgv(["--max-steps", "9"]), repo),
    basicDeps(),
  );
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--max-steps cannot be changed after init");

  const changedTimeout = await executeRoleCommand(
    withRepo(dispatchArgv(["--timeout", "5"]), repo),
    basicDeps(),
  );
  expect(changedTimeout.exitCode).toBe(1);
  expect(changedTimeout.payload.error).toContain("--timeout cannot be changed after init");
});

// Usefulness: verifies an empty stdin prompt exits non-zero, charges no step,
// and spawns no CLI (regression: the empty check only covered --prompt-file).
test("empty stdin prompt is rejected without charging a step", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const before = await readRepoState(repo);

  const worker = recordingAdapter([]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: async () => "   ",
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toContain("Prompt on stdin is empty");
  expect(worker.recorded.length).toBe(0);
  const after = await readRepoState(repo);
  expect(after.stepsUsed).toBe(before.stepsUsed);
  expect(after.lifecycle).toBe("active");
});

// Usefulness: verifies acceptance — the first call after a crash marks
// `interrupted`, exits non-zero, and spawns no child, even with an explicit
// `--resume-interrupted`; a maintainer can resume on a later call.
test("resume-interrupted from dispatched marks interrupted first and runs no child", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const state = await readState(paths.stateFile);
  state.lifecycle = "dispatched";
  await writeState(paths.stateFile, state);

  const worker = recordingAdapter([]);
  const direct = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(direct.exitCode).toBe(1);
  expect(direct.payload.status).toBe("error");
  expect(direct.payload.error).toContain("interrupted");
  expect(worker.recorded.length).toBe(0);
  expect((await readState(paths.stateFile)).lifecycle).toBe("interrupted");

  const resumed = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(resumed.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(1);
  const resumedState = await readState(paths.stateFile);
  expect(resumedState.lifecycle).toBe("active");
  expect(resumedState.resumeDecision).toBeTruthy();
});

// Usefulness: verifies only the role kind is normalized in the change
// comparison — model and effort are opaque pass-through strings, so repeating
// an identical `--worker-model antigravity` passes and a changed one is
// rejected (regression: normalizeAgent mangled the model string).
test("identical model and effort flags pass comparison verbatim", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(
    withRepo(
      dispatchArgv([
        ...INIT_OVERRIDES,
        "--worker-model",
        "antigravity",
        "--worker-effort",
        "high",
        "--reviewer-model",
        "gemini-2.5-pro",
      ]),
      repo,
    ),
    basicDeps(),
  );
  const state = await readRepoState(repo);
  expect(state.roles.worker.model).toBe("antigravity");

  const identical = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker-model", "antigravity", "--worker-effort", "high"]), repo),
    basicDeps(),
  );
  expect(identical.exitCode).toBe(0);

  const changed = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker-model", "antigravity", "--worker-effort", "low"]), repo),
    basicDeps(),
  );
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--worker-effort cannot be changed after init");
});

// Usefulness: verifies the `antigravity` kind alias passes the change
// comparison through normalization while model strings stay verbatim.
test("antigravity kind alias passes comparison, model strings do not normalize", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(
    withRepo(
      dispatchArgv([...INIT_OVERRIDES, "--worker", "antigravity", "--worker-model", "antigravity"]),
      repo,
    ),
    { agents: { agy: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  const state = await readRepoState(repo);
  expect(state.roles.worker.kind).toBe("agy");
  expect(state.roles.worker.model).toBe("antigravity");

  const identical = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker", "antigravity", "--worker-model", "antigravity"]), repo),
    { agents: { agy: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  expect(identical.exitCode).toBe(0);

  const changedModel = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker", "antigravity", "--worker-model", "gemini"]), repo),
    { agents: { agy: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  expect(changedModel.exitCode).toBe(1);
  expect(changedModel.payload.error).toContain("--worker-model cannot be changed after init");
});

// Usefulness: verifies acceptance — stdout holds exactly one JSON object on
// every path, including errors (verified through the main entry point).
test("main prints exactly one JSON object on stdout on success and error paths", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      {
        agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      },
    );
    expect(logSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ status: "ok", role: "worker" });

    logSpy.mockClear();
    await runRoleMain(["dispatch", "--cwd", repo], { agents: {} });
    expect(logSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
      status: "error",
      error: expect.stringContaining("dispatch requires --role"),
    });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});
