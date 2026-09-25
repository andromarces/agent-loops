import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand, main as runRoleMain, parseRoleArgs } from "../src/role.mjs";
import { createTempRepo, deadPid } from "./runtime-helpers.mjs";

// Each test gets its own runs root (env override) and its own temp repo, so
// state files never collide between tests.
let runsRoot;
const repos = [];

async function setup() {
  runsRoot = await mkdtemp(join(tmpdir(), "role-test-runs-"));
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
}

afterEach(async () => {
  delete process.env.AGENT_LOOP_RUNS_ROOT;
  for (const dir of repos) {
    await rm(dir, { recursive: true, force: true });
  }
  repos.length = 0;
  await rm(runsRoot, { recursive: true, force: true });
  runsRoot = undefined;
});

const REPORT = "Conclusion: done\nWhy: tests pass\nBlockers: none";
const WORKER_REPLY = `${REPORT}\nContinuing next turn.`;

function recordingAdapter(replies) {
  let n = 0;
  return {
    recorded: [],
    async run(state, prompt, options) {
      this.recorded.push({ incomingSessionId: state.sessionId, prompt, options });
      if (!state.sessionId) {
        state.sessionId = `sess-${++n}`;
      }
      const reply = replies.length > 0 ? replies.shift() : WORKER_REPLY;
      return typeof reply === "function" ? reply(state, prompt, options) : reply;
    },
  };
}

// Init-only flags for the first (initializing) dispatch call, including the
// role agent configuration that later calls must read from the state file.
const INIT_OVERRIDES = [
  "--task",
  "Fix the flaky test.",
  "--mode",
  "work-first",
  "--parent-session",
  "parent-sess-1",
  "--worker",
  "fake1",
  "--reviewer",
  "fake2",
];

function dispatchArgv(overrides = [], role = "worker") {
  return ["dispatch", "--role", role, "--cwd", "<repo>", ...overrides];
}

function withRepo(args, repo) {
  return parseRoleArgs(args.map((value) => (value === "<repo>" ? repo : value)));
}

const stdinPrompt = async () => "continue working";

// Usefulness: verifies an empty shell expansion cannot start an unguarded run.
test("empty parent session is rejected before dispatch", async () => {
  await setup();
  expect(() => parseRoleArgs(["dispatch", "--role", "worker", "--parent-session", ""])).toThrow(
    "Missing value for --parent-session.",
  );
});

// Usefulness: verifies acceptance (#149) — an init without --parent-session is
// refused before any state file is written, so no interactive run starts
// unguarded by default.
test("init without --parent-session is rejected before any state is written", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--task", "Task.", "--worker", "fake1", "--reviewer", "fake2"]), repo),
    { ...basicDeps() },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--parent-session");
  expect(await readState(paths.stateFile)).toBeNull();
});

// Usefulness: verifies acceptance (#149) — a literal placeholder is refused
// before any state file is written, so it never registers a parent index that
// can never match.
test("init with a literal placeholder parent session is rejected", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  const result = await executeRoleCommand(
    withRepo(
      dispatchArgv([
        "--task",
        "Task.",
        "--parent-session",
        "${CLAUDE_SESSION_ID}",
        "--worker",
        "fake1",
        "--reviewer",
        "fake2",
      ]),
      repo,
    ),
    { ...basicDeps() },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("Invalid session id");
  expect(await readState(paths.stateFile)).toBeNull();
});

// Usefulness: verifies a name inherited from Object.prototype cannot pass as a
// role flag (regression: a plain-object lookup treated `constructor` as a
// defined flag instead of rejecting it).
test("object prototype names are rejected as unknown arguments", async () => {
  await setup();
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    expect(() => parseRoleArgs([name, "x"])).toThrow(`Unknown argument: ${name}`);
  }
});

/** Deps for calls whose child turn is not under assertion. */
const basicDeps = () => ({
  agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
  stdin: stdinPrompt,
});

async function readRepoState(repo) {
  return JSON.parse(await readFile(statePaths({ cwd: repo }).stateFile, "utf8"));
}

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

// Usefulness: verifies acceptance — a crash injected between CLI start and the
// state write leaves `dispatched` plus a dead-pid lock; the next call removes
// the stale lock, sets `interrupted`, exits non-zero, and spawns no CLI; a
// following plain dispatch is rejected; abort is accepted.
test("crash aftermath: interrupted lifecycle, stale lock removal, abort path", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  const state = await readState(paths.stateFile);
  state.lifecycle = "dispatched";
  await writeState(paths.stateFile, state);
  await writeFile(
    paths.lockFile,
    JSON.stringify({ pid: await deadPid(), startedAt: "2026-01-01T00:00:00Z" }),
    "utf8",
  );

  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };
  const next = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(next.exitCode).toBe(1);
  expect(next.payload.status).toBe("error");
  expect(next.payload.error).toContain("interrupted");
  expect(worker.recorded.length).toBe(0);
  expect((await readState(paths.stateFile)).lifecycle).toBe("interrupted");
  await expect(readFile(paths.lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const plain = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(plain.exitCode).toBe(1);
  expect(plain.payload.error).toContain("interrupted");
  expect(worker.recorded.length).toBe(0);

  const abortArgs = withRepo(
    ["abort", "--cwd", "<repo>", "--reason", "previous turn uncertain"],
    repo,
  );
  const aborted = await executeRoleCommand(abortArgs);
  expect(aborted.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("aborted");
});

// Usefulness: verifies acceptance — two concurrent calls: exactly one runs a
// child; the other exits non-zero and the step count rises by one.
test("concurrent dispatches: exactly one child runs, the loser exits non-zero", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const first = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(first.exitCode).toBe(0);

  const slowWorker = {
    recorded: [],
    async run(state, prompt, options) {
      this.recorded.push({ state, prompt, options });
      state.sessionId = "sess-slow";
      await new Promise((resolve) => setTimeout(resolve, 100));
      return WORKER_REPLY;
    },
  };
  const agents = { fake1: slowWorker, fake2: recordingAdapter([]) };
  const args = withRepo(dispatchArgv(), repo);

  const [a, b] = await Promise.all([
    executeRoleCommand(args, { agents, stdin: stdinPrompt }),
    executeRoleCommand(args, { agents, stdin: stdinPrompt }),
  ]);

  expect([a.exitCode, b.exitCode].sort()).toEqual([0, 1]);
  const loser = a.exitCode === 1 ? a : b;
  expect(loser.payload.error).toContain("locked by a live process");
  expect(slowWorker.recorded.length).toBe(1);
  expect((await readRepoState(repo)).stepsUsed).toBe(2);
});

// Usefulness: verifies acceptance — a reviewer turn that mutates the work tree
// exits non-zero, keeps the charged step, records the error, and halts; a
// following dispatch is rejected; an init call archives the halted file and
// starts a new run.
test("reviewer mutation halts the run; init archives the halted file", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  const before = await readRepoState(repo);

  const mutatingReviewer = recordingAdapter([]);
  mutatingReviewer.run = async (state) => {
    state.sessionId = "rev-sess";
    await writeFile(join(repo, "mutated.txt"), "mutated\n");
    return REPORT;
  };
  const reviewArgs = withRepo(dispatchArgv([], "reviewer"), repo);
  const result = await executeRoleCommand(reviewArgs, {
    agents: { fake1: recordingAdapter([]), fake2: mutatingReviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toContain("Mutation detected");
  const halted = await readRepoState(repo);
  expect(halted.lifecycle).toBe("halted");
  expect(halted.stepsUsed).toBe(before.stepsUsed + 1);

  const next = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    ...basicDeps(),
  });
  expect(next.exitCode).toBe(1);
  expect(next.payload.error).toContain("halted");

  const restarted = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(restarted.exitCode).toBe(0);
  const files = await readdir(paths.stateDir);
  const archivedNames = files.filter((name) => /^state\..+\.json$/.test(name));
  expect(archivedNames.length).toBe(1);
  const archived = JSON.parse(await readFile(join(paths.stateDir, archivedNames[0]), "utf8"));
  expect(archived.stepsUsed).toBe(before.stepsUsed + 1);
  expect(archived.lifecycle).toBe("halted");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies acceptance — an init call over an active state file is
// rejected; after abort, the same init call succeeds and the old file is
// archived.
test("init over active rejected; abort then init archives and starts a new run", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  const rejected = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("Existing run is active");
  expect((await readRepoState(repo)).stepsUsed).toBe(1);

  const abortArgs = withRepo(["abort", "--cwd", "<repo>", "--reason", "done for now"], repo);
  expect((await executeRoleCommand(abortArgs)).exitCode).toBe(0);

  const restarted = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(restarted.exitCode).toBe(0);
  const files = await readdir(paths.stateDir);
  expect(files.filter((name) => /^state\..+\.json$/.test(name)).length).toBe(1);
});

// Usefulness: verifies acceptance — after an init call with --cwd set to a
// directory other than the process cwd, the session index for --parent-session
// resolves to that run's state file through the shared helper.
test("session index resolves a run dispatched into a different --cwd", async () => {
  await setup();
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

// Usefulness: verifies a review-only init that rejects --role worker writes no
// state file, so the corrected reviewer init succeeds without an abort (#123).
test("a rejected worker init leaves no run for the corrected init", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  const rejected = await executeRoleCommand(
    withRepo(
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
        "worker",
      ),
      repo,
    ),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    },
  );
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("mode review-only rejects --role worker");
  expect(await readState(paths.stateFile)).toBeNull();

  const corrected = withRepo(
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
  const result = await executeRoleCommand(corrected, {
    agents: { fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies an init whose prompt read fails writes no state file, so
// the corrected init succeeds without an abort (#123).
test("an init with an empty prompt leaves no run for the corrected init", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  const rejected = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
    stdin: async () => "   ",
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("Prompt on stdin is empty");
  expect(await readState(paths.stateFile)).toBeNull();

  const corrected = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(corrected.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies a rejected init over a terminal state archives nothing
// and leaves the terminal state in place (#123).
test("a rejected init over a terminal state archives nothing", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), { ...basicDeps() });
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "done"], repo));
  expect((await readRepoState(repo)).lifecycle).toBe("aborted");

  const rejected = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
    stdin: async () => "   ",
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("Prompt on stdin is empty");

  const files = await readdir(paths.stateDir);
  expect(files.filter((name) => /^state\..+\.json$/.test(name)).length).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("aborted");
});

// Usefulness: verifies acceptance — a review-only init succeeds without
// --worker and stores a null worker role, because the mode never dispatches it.
test("review-only init succeeds without --worker and stores a null worker", async () => {
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
  const result = await executeRoleCommand(init, {
    agents: { fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  const state = await readRepoState(repo);
  expect(state.mode).toBe("review-only");
  expect(state.roles.worker).toBeNull();
  expect(state.roles.reviewer.kind).toBe("fake2");
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

// Usefulness: verifies acceptance — a worker model or effort without --worker
// is rejected at init instead of being silently dropped, because review-only
// never dispatches the worker and the value would have no home.
test("review-only init rejects a worker model or effort without --worker", async () => {
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
        "--worker-model",
        "gpt-x",
      ],
      "reviewer",
    ),
    repo,
  );
  const result = await executeRoleCommand(init, {
    agents: { fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--worker-model requires --worker");
});

// Usefulness: verifies acceptance — an OpenCode effort without a model is rejected at init through
// executeRoleCommand; parsing performs no OpenCode validation, so the check runs during init.
test("review-only init rejects an OpenCode effort without a model", async () => {
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
        "opencode",
        "--reviewer-effort",
        "high",
      ],
      "reviewer",
    ),
    repo,
  );
  const result = await executeRoleCommand(init, {
    agents: { opencode: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--reviewer-effort requires --reviewer-model");
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

// Usefulness: verifies acceptance — finish from active in review-only mode
// succeeds with verdict: reject recorded in the summary.
test("finish from active in review-only mode succeeds with the verdict recorded", async () => {
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

  const summary = {
    changed: "none",
    verified: "review ran",
    deferred: "none",
    notDone: "verdict: reject, two blockers open",
    open: "blockers 1 and 2",
  };
  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(summary),
  });
  expect(result.exitCode).toBe(0);

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("finished");
  expect(state.summary.notDone).toContain("verdict: reject");
});

// Usefulness: verifies acceptance — finish with an invalid summary exits
// non-zero and leaves lifecycle active.
test("finish with an invalid summary exits non-zero and keeps lifecycle active", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });

  const finishArgs = withRepo(["finish", "--cwd", "<repo>"], repo);
  const badJson = await executeRoleCommand(finishArgs, { stdin: async () => "not json" });
  expect(badJson.exitCode).toBe(1);
  expect(badJson.payload.error).toContain("finish summary must be a JSON object");

  const missingKey = await executeRoleCommand(finishArgs, {
    stdin: async () => JSON.stringify({ changed: "a", verified: "b" }),
  });
  expect(missingKey.exitCode).toBe(1);
  expect(missingKey.payload.error).toContain("non-empty string for deferred");

  expect((await readRepoState(repo)).lifecycle).toBe("active");
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

// Usefulness: verifies the init `--timeout` persists in the state file and
// reaches the adapter on every dispatch (regression: the flag was silently
// dropped, so turns ran unbounded). `--timeout 0` stores null, the documented
// way to remove the bound.
test("init --timeout persists in state and reaches the adapter", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const seen = [];
  const timeoutWorker = {
    recorded: [],
    async run(state, prompt, options) {
      seen.push(options.timeout);
      state.sessionId = "sess-t";
      return WORKER_REPLY;
    },
  };
  const args = withRepo(dispatchArgv([...INIT_OVERRIDES, "--timeout", "7"]), repo);
  const result = await executeRoleCommand(args, {
    agents: { fake1: timeoutWorker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(seen).toEqual([7]);
  expect((await readRepoState(repo)).timeout).toBe(7);

  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "probe"], repo));
  const disabled = withRepo(
    dispatchArgv([
      "--task",
      "Task.",
      "--parent-session",
      "parent-sess-1",
      "--worker",
      "fake1",
      "--reviewer",
      "fake2",
      "--timeout",
      "0",
    ]),
    repo,
  );
  const resultZero = await executeRoleCommand(disabled, {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(resultZero.exitCode).toBe(0);
  expect((await readRepoState(repo)).timeout).toBeNull();
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

// Usefulness: verifies finish and abort read configuration from the state file
// too — a changed init flag exits non-zero and leaves the state unchanged.
test("finish and abort reject changed init flags", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());

  const badFinish = await executeRoleCommand(
    withRepo(["finish", "--cwd", "<repo>", "--max-steps", "99"], repo),
    {
      stdin: async () =>
        JSON.stringify({ changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" }),
    },
  );
  expect(badFinish.exitCode).toBe(1);
  expect(badFinish.payload.error).toContain("--max-steps cannot be changed after init");

  const badAbort = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "r", "--mode", "review-only"], repo),
  );
  expect(badAbort.exitCode).toBe(1);
  expect(badAbort.payload.error).toContain("--mode cannot be changed after init");

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("active");
  expect(state.maxSteps).toBe(20);
  expect(state.mode).toBe("work-first");
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
