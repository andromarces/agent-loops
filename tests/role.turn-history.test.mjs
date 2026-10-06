import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role.mjs";
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

// Usefulness: verifies the size bound on the resume path — a stored `maxSteps`
// outside the safe integer range is refused before the step-budget guard reads
// it. A state file written by an earlier version, or hand-edited, carries the
// value straight to `stepsUsed >= maxSteps`, where an unsafe integer makes the
// step counter stop advancing and the bound hold for no value (issue #312).
test("dispatch and finish refuse a state file with a maxSteps outside the safe integer range", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const stateFile = statePaths({ cwd: repo }).stateFile;

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const state = await readState(stateFile);
  state.maxSteps = 1000000000000000000000;
  await writeState(stateFile, state);

  const worker = recordingAdapter([]);
  const refused = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("maxSteps");
  expect(worker.recorded.length).toBe(0);
  expect((await readState(stateFile)).stepsUsed).toBe(1);

  const finished = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: stdinPrompt,
  });
  expect(finished.exitCode).toBe(1);
  expect(finished.payload.error).toContain("maxSteps");
  // The run is left as it was, so the refusal is a load-time check and not a
  // lifecycle change.
  expect((await readState(stateFile)).lifecycle).toBe("active");
});

// Usefulness: verifies the run can still end and be replaced — `abort` charges
// no step and reads no budget, so it is not refused by the stored-`maxSteps`
// check. Without this, an unsafe stored value would block every route to a
// terminal lifecycle: abort would refuse, and a new init refuses over a
// non-terminal run, so the run and its parent-edit guard would stay stuck
// (issue #312). Once aborted, a new init starts normally, because init reads
// only the stored lifecycle and archives the old file without re-checking the
// old `maxSteps`, so no field has to be hand-corrected.
test("abort ends a run with an unsafe stored maxSteps and a new init then starts normally", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  const stateFile = paths.stateFile;

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const state = await readState(stateFile);
  state.maxSteps = 1000000000000000000000;
  await writeState(stateFile, state);

  const aborted = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "unsafe stored budget"], repo),
  );
  expect(aborted.exitCode).toBe(0);
  expect(aborted.payload).toMatchObject({ status: "ok", lifecycle: "aborted" });

  const after = await readState(stateFile);
  expect(after.lifecycle).toBe("aborted");
  expect(after.reason).toBe("unsafe stored budget");
  // Abort charges no step, so the history and the step count are untouched.
  expect(after.stepsUsed).toBe(1);
  expect(after.turns).toHaveLength(1);

  const restarted = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(restarted.exitCode).toBe(0);

  // The new run starts from the flag value, and the aborted run is archived
  // with its unsafe value rather than blocking the init.
  const fresh = await readState(stateFile);
  expect(fresh.lifecycle).toBe("active");
  expect(fresh.maxSteps).toBe(20);
  // `state.lock` sits in the same directory, so match the archive name shape.
  const archived = (await readdir(dirname(stateFile))).filter((name) =>
    /^state\..+\.json$/.test(name),
  );
  expect(archived).toHaveLength(1);
  expect((await readState(join(dirname(stateFile), archived[0]))).maxSteps).toBe(
    1000000000000000000000,
  );
});

/**
 * Puts the state file in the state a crash leaves: the step is charged, the
 * lifecycle is `dispatched`, and no result was recorded for that turn, so
 * `turns` holds only the turns before it.
 */
async function crashDuringDispatch(repo) {
  const state = await readState(statePaths({ cwd: repo }).stateFile);
  state.lifecycle = "dispatched";
  state.turns = state.turns.slice(0, -1);
  await writeState(statePaths({ cwd: repo }).stateFile, state);
}

// Usefulness: verifies the interrupted recovery path — a charged turn whose
// outcome is uncertain is still in the history. The call that marks the run
// `interrupted` runs no child and charges no step, so it must record the turn
// the previous call left in `dispatched`, marked interrupted, with no verdict
// and no head it never observed (issue #312).
test("the charged uncertain turn is recorded when the run recovers into interrupted", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  await crashDuringDispatch(repo);

  const recovery = await executeRoleCommand(
    withRepo(dispatchArgv(["--resume-interrupted"]), repo),
    basicDeps(),
  );
  expect(recovery.exitCode).toBe(1);
  expect(recovery.payload.error).toContain("interrupted");

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("interrupted");
  expect(state.turns).toHaveLength(1);
  expect(state.turns[0]).toMatchObject({
    role: "worker",
    status: "interrupted",
    verdict: null,
    head: null,
  });
  expect(state.turns[0].at).toEqual(expect.any(String));
});

// Usefulness: verifies no duplicate entry and no budget overrun — the resumed
// turn is charged and recorded once on its own, so the history holds the
// uncertain turn and the resumed turn as two distinct entries, one per charged
// step (issue #312).
test("a resumed turn records one entry after the interrupted entry", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "2"]), repo), {
    ...basicDeps(),
  });
  await crashDuringDispatch(repo);

  await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), basicDeps());
  const resumed = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    ...basicDeps(),
  });
  expect(resumed.exitCode).toBe(0);

  const state = await readRepoState(repo);
  expect(state.turns.map((turn) => turn.status)).toEqual(["interrupted", "ok"]);
  // The recovery call charges no step, so its entry accounts for the step the
  // crashed call already charged. Entries stay at one per charged step, so the
  // bound of `maxSteps` still holds.
  expect(state.stepsUsed).toBe(2);
  expect(state.turns).toHaveLength(state.stepsUsed);
  expect(state.turns).toHaveLength(state.maxSteps);
});
