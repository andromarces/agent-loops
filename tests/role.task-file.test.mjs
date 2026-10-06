import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { executeRoleCommand, parseRoleArgs } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

// INIT_OVERRIDES minus its --task pair.
const INIT_WITHOUT_TASK = INIT_OVERRIDES.filter(
  (value, i) => value !== "--task" && INIT_OVERRIDES[i - 1] !== "--task",
);

// Usefulness: acceptance (#211) — role init takes the task from a file, verbatim, into the state file.
test("role init --task-file stores the file content as the task", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const path = join(repo, "..", "role-task.md");
  await writeFile(path, "Multi-line\ntask.\n");
  const result = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_WITHOUT_TASK, "--task-file", path]), repo),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: async () => "continue working",
    },
  );
  expect(result.exitCode).toBe(0);
  expect((await readRepoState(repo)).task).toBe("Multi-line\ntask.\n");
});

// Usefulness: acceptance (#211) — `--task-file -` reads the task from stdin, with the prompt from --prompt-file.
test("role init --task-file - reads the task from stdin", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const prompt = join(repo, "..", "role-prompt.md");
  await writeFile(prompt, "Do the work.");
  const result = await executeRoleCommand(
    withRepo(
      dispatchArgv([...INIT_WITHOUT_TASK, "--task-file", "-", "--prompt-file", prompt]),
      repo,
    ),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: async () => "Task from stdin.\n",
    },
  );
  expect(result.exitCode).toBe(0);
  expect((await readRepoState(repo)).task).toBe("Task from stdin.\n");
});

// Usefulness: stdin holds one input, so the task and the prompt cannot both come from it.
test("role init --task-file - without --prompt-file fails", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const result = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_WITHOUT_TASK, "--task-file", "-"]), repo),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: async () => "Task from stdin.\n",
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--prompt-file");
});

// Usefulness: acceptance (#211) — a task from two sources fails with a clear error at parse time.
test("role --task with --task-file fails", async () => {
  await setup();
  expect(() => parseRoleArgs(["dispatch", "--task", "t", "--task-file", "task.md"])).toThrow(
    "--task and --task-file cannot be combined.",
  );
});

// Usefulness: acceptance (#211) — the empty-task check applies to the file content on init.
test("role init with an empty task file fails and writes no state", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const path = join(repo, "..", "role-empty.md");
  await writeFile(path, "  \n");
  const result = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_WITHOUT_TASK, "--task-file", path]), repo),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: async () => "continue working",
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("Init requires --task");
});

// Usefulness: acceptance (#211, review) — `--task-file` is an init flag like `--task`, so
// every later operation that refuses `--task` refuses it too, and the run stays untouched.
test("--task-file after init is refused wherever --task is refused", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const deps = {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: async () => "continue working",
  };
  const init = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), deps);
  expect(init.exitCode).toBe(0);
  const taskFile = join(repo, "..", "later-task.md");
  await writeFile(taskFile, "Other task.");

  const operations = [
    ["finish", []],
    ["abort", ["--reason", "stop"]],
    ["extend", ["--parent-session", "parent-sess-1", "--max-steps", "9"]],
  ];
  for (const [operation, flags] of operations) {
    const argv = (taskFlag) => [operation, "--cwd", "<repo>", ...flags, ...taskFlag];
    const withTask = await executeRoleCommand(
      withRepo(argv(["--task", "Other task."]), repo),
      deps,
    );
    const withFile = await executeRoleCommand(
      withRepo(argv(["--task-file", taskFile]), repo),
      deps,
    );
    expect(withTask.exitCode, operation).toBe(1);
    expect(withFile.exitCode, operation).toBe(1);
    expect(withTask.payload.error, operation).toContain("--task cannot be changed after init");
    expect(withFile.payload.error, operation).toContain("--task-file cannot be changed after init");
  }
  const dispatched = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_WITHOUT_TASK, "--task-file", taskFile]), repo),
    deps,
  );
  expect(dispatched.exitCode).toBe(1);
  expect(dispatched.payload.error).toContain("Existing run is");

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("active");
  expect(state.task).toBe("Fix the flaky test.");
  expect(state.reason).toBeUndefined();
  expect(state.maxSteps).not.toBe(9);
});
