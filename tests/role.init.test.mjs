import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readState, statePaths } from "../src/lib/runstate.mjs";
import { executeRoleCommand, parseRoleArgs } from "../src/role.mjs";
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
  WORKER_REPLY,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

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
