import { afterEach, expect, test } from "vitest";
import { executeRoleCommand } from "../src/role.mjs";
import {
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

// Usefulness: verifies acceptance — the state file keeps one entry per
// dispatched turn across the overwrite of `lastResult`, carrying role, status,
// verdict, reviewed head, and time, so a finished run shows every turn without
// the parent conversation log (issue #312).
test("state keeps one turn per dispatch across later dispatches", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-1";
    return `${REPORT}\nVerdict: reject`;
  };
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  await executeRoleCommand(withRepo(dispatchArgv(), repo), { agents, stdin: stdinPrompt });

  const state = await readRepoState(repo);
  expect(state.stepsUsed).toBe(3);
  expect(state.turns).toHaveLength(3);
  expect(state.turns.map((turn) => turn.role)).toEqual(["worker", "reviewer", "worker"]);
  expect(state.turns.map((turn) => turn.status)).toEqual(["ok", "ok", "ok"]);
  expect(state.turns.map((turn) => turn.verdict)).toEqual([null, "reject", null]);
  expect(state.turns[1].head).toMatch(/^[0-9a-f]{40}$/);
  expect(state.turns[0].head).toBeNull();
  for (const turn of state.turns) {
    expect(turn.at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(turn.at))).toBe(false);
  }
});

// Usefulness: verifies the size bound — `turns` holds at most one entry per
// charged step, so the run's own `maxSteps` budget caps the history and a
// refused over-budget dispatch adds nothing (issue #312).
test("turn history holds no more entries than the step budget allows", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
  await executeRoleCommand(withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "2"]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  await executeRoleCommand(withRepo(dispatchArgv(), repo), { agents, stdin: stdinPrompt });
  const over = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(over.exitCode).toBe(1);

  const state = await readRepoState(repo);
  expect(state.maxSteps).toBe(2);
  expect(state.turns).toHaveLength(2);
});

// Usefulness: verifies the history excludes report text — a turn entry holds no
// response or report body, so the state file cannot grow with the text a child
// returns (issue #312).
test("turn entries exclude the report and response text", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-text";
    return `${REPORT}\nVerdict: accept`;
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  const state = await readRepoState(repo);
  expect(Object.keys(state.turns[0]).sort()).toEqual(["at", "head", "role", "status", "verdict"]);
  expect(JSON.stringify(state.turns)).not.toContain("tests pass");
});

// Usefulness: verifies a turn that ends in a handled child failure still
// records role, status, and time, with no verdict and no reviewed head, so a
// failed turn stays countable in the history (issue #312).
test("a turn whose child fails records an error turn", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async () => {
    throw new Error("child exited 1");
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(1);

  const state = await readRepoState(repo);
  expect(state.turns).toHaveLength(1);
  expect(state.turns[0]).toMatchObject({
    role: "worker",
    status: "error",
    verdict: null,
    head: null,
  });
  expect(state.turns[0].at).toEqual(expect.any(String));
});
