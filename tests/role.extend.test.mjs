import { afterEach, expect, test, vi } from "vite-plus/test";
import { statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand, parseRoleArgs } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});

const PARENT = ["--parent-session", "parent-sess-1"];
const extendArgv = (...flags) => ["extend", "--cwd", "<repo>", ...flags];
const parentExtendArgv = (...flags) => extendArgv(...PARENT, ...flags);

async function startRun(maxSteps, agents) {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", String(maxSteps)]), repo),
    { agents, stdin: stdinPrompt },
  );
  return repo;
}

// Usefulness: verifies acceptance — a run that used its whole budget continues
// after `extend` on the same state file, so the stored role session id is
// resumed instead of a new session starting (issue #361).
test("extend lets an exhausted run continue with its stored role session", async () => {
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };
  const repo = await startRun(1, agents);

  const refused = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(refused.payload.error).toContain("Step budget exhausted (1/1)");

  const extended = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "3"), repo));
  expect(extended.exitCode).toBe(0);
  expect(extended.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    maxSteps: 3,
    stepsUsed: 1,
  });

  const next = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(next.exitCode).toBe(0);
  expect(worker.recorded.map((call) => call.incomingSessionId)).toEqual([null, "sess-1"]);
  const state = await readRepoState(repo);
  expect(state.stepsUsed).toBe(2);
  expect(state.roles.worker.sessionId).toBe("sess-1");
});

// Usefulness: verifies the state file shows where the budget changed — each
// change records the old and new budget, the steps used at that point, and the
// time, while `turns` keeps one entry per charged step (issue #361).
test("extend records the change in budgetChanges beside an intact turn history", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(1, agents);

  await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "2"), repo));
  await executeRoleCommand(withRepo(dispatchArgv(), repo), { agents, stdin: stdinPrompt });
  await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "5"), repo));

  const state = await readRepoState(repo);
  expect(state.maxSteps).toBe(5);
  expect(state.turns).toHaveLength(2);
  expect(state.budgetChanges).toEqual([
    { from: 1, to: 2, stepsUsed: 1, at: expect.any(String) },
    { from: 2, to: 5, stepsUsed: 2, at: expect.any(String) },
  ]);
  for (const change of state.budgetChanges) {
    expect(Number.isNaN(Date.parse(change.at))).toBe(false);
  }
});

// Usefulness: verifies a value that is not a real raise is refused and leaves
// the state file untouched: at or below `stepsUsed`, and at or below the
// current budget (issue #361).
test("extend refuses a value that is not larger than stepsUsed or the current budget", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(3, agents);
  await executeRoleCommand(withRepo(dispatchArgv(), repo), { agents, stdin: stdinPrompt });
  const before = await readRepoState(repo);
  expect(before.stepsUsed).toBe(2);

  for (const value of ["1", "2", "3"]) {
    const result = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", value), repo));
    expect(result.exitCode, value).toBe(1);
    expect(result.payload.error, value).toContain("--max-steps");
  }
  expect(
    (await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "2"), repo))).payload.error,
  ).toContain("stepsUsed (2)");
  expect(
    (await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "3"), repo))).payload.error,
  ).toContain("current maxSteps (3)");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies extend applies the init `--max-steps` validation, so a
// value outside 1 to Number.MAX_SAFE_INTEGER is refused before any state read
// (issue #361).
test("extend applies the init --max-steps validation", async () => {
  await setup();
  for (const value of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
    expect(() => parseRoleArgs(parentExtendArgv("--max-steps", value)), value).toThrow(
      "--max-steps",
    );
  }
  expect(parseRoleArgs(parentExtendArgv("--max-steps", "9007199254740991")).maxSteps).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

// Usefulness: verifies extend cannot revive a run that already ended, and needs
// a run at the work tree (issue #361).
test("extend refuses a terminal run and a path with no run state", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(1, agents);
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));

  const ended = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "9"), repo));
  expect(ended.exitCode).toBe(1);
  expect(ended.payload.error).toBe("Run is already aborted.");
  expect((await readRepoState(repo)).maxSteps).toBe(1);

  const other = await createTempRepo();
  repos.push(other);
  const none = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "9"), other));
  expect(none.exitCode).toBe(1);
  expect(none.payload.error).toContain("No run state");
});

// Usefulness: verifies extend keeps a recovery lifecycle as it is, so raising the
// budget neither resumes nor clears an interrupted run (issue #361).
test("extend leaves an interrupted lifecycle unchanged", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(1, agents);
  const state = await readRepoState(repo);
  state.lifecycle = "interrupted";
  await writeState(statePaths({ cwd: repo }).stateFile, state);

  const result = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "4"), repo));
  expect(result.payload).toMatchObject({ status: "ok", lifecycle: "interrupted", maxSteps: 4 });
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
});

// Usefulness: verifies extend takes only `--max-steps` and `--cwd`: a missing
// value, a dispatch or abort flag, and a changed init field are each refused
// (issue #361).
test("extend refuses a missing value and flags that belong to other operations", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(1, agents);

  const cases = [
    [[], "extend requires --max-steps"],
    [["--max-steps", "4", "--role", "worker"], "--role is only valid for dispatch"],
    [["--max-steps", "4", "--reason", "x"], "--reason is only valid for abort"],
    [["--max-steps", "4", "--require-accept"], "only valid for finish"],
    [["--max-steps", "4", "--task", "Other task."], "--task cannot be changed after init"],
    [["--max-steps", "4", "--worker", "fake2"], "--worker cannot be changed after init"],
  ];
  for (const [flags, message] of cases) {
    const result = await executeRoleCommand(withRepo(parentExtendArgv(...flags), repo));
    expect(result.exitCode, message).toBe(1);
    expect(result.payload.error, message).toContain(message);
  }
  const state = await readRepoState(repo);
  expect(state.maxSteps).toBe(1);
  expect(state.budgetChanges).toBeUndefined();
});

// Usefulness: verifies what the parent-session check enforces — a call must
// pass the run's stored parent session id. A call with another id or none is
// refused with no state change and no leak of the stored id; a call with the
// stored id is accepted. The check compares the id only, so it does not
// identify the caller: a caller that read the id from the state file passes
// (issue #361).
test("extend accepts the stored parent session id and refuses another id or none", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(1, agents);

  const childCalls = [
    [["--parent-session", "child-sess-9", "--max-steps", "9"], "does not match"],
    [["--max-steps", "9"], "extend requires --parent-session"],
  ];
  for (const [flags, message] of childCalls) {
    const result = await executeRoleCommand(withRepo(extendArgv(...flags), repo));
    expect(result.exitCode, message).toBe(1);
    expect(result.payload.error, message).toContain(message);
    expect(JSON.stringify(result.payload), message).not.toContain("parent-sess-1");
  }
  const refused = await readRepoState(repo);
  expect(refused.maxSteps).toBe(1);
  expect(refused.budgetChanges).toBeUndefined();

  const parent = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "9"), repo));
  expect(parent.exitCode).toBe(0);
  expect((await readRepoState(repo)).maxSteps).toBe(9);
});

// Usefulness: verifies acceptance — a caller that carries the spawn-time child
// marker is refused by extend, finish, and abort with the run left as it was,
// while the same calls without the marker still work (issue #392). The id
// check alone cannot separate them, because the child passes the stored id.
test("extend, finish, and abort refuse a child caller that holds the stored id", async () => {
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  const repo = await startRun(5, agents);

  vi.stubEnv("AGENT_LOOP_SPAWNED_ROLE", "worker");
  const childCalls = [
    parentExtendArgv("--max-steps", "9"),
    ["finish", "--cwd", "<repo>"],
    ["abort", "--cwd", "<repo>", "--reason", "child stop"],
  ];
  for (const argv of childCalls) {
    const result = await executeRoleCommand(withRepo(argv, repo), { stdin: stdinPrompt });
    expect(result.exitCode, argv[0]).toBe(1);
    expect(result.payload.error, argv[0]).toContain("child role");
  }
  const refused = await readRepoState(repo);
  expect(refused.lifecycle).toBe("active");
  expect(refused.maxSteps).toBe(5);

  vi.stubEnv("AGENT_LOOP_SPAWNED_ROLE", "");
  const parent = await executeRoleCommand(withRepo(parentExtendArgv("--max-steps", "9"), repo));
  expect(parent.exitCode).toBe(0);
  const aborted = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "parent stop"], repo),
  );
  expect(aborted.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("aborted");
});
