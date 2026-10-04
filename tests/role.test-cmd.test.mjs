import { afterEach, expect, test } from "vitest";
import { executeRoleCommand } from "../src/role.mjs";
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

// Interactive behavior of `--test-cmd` (issue #420, ADR 0017).
const node = (body) => `node -e "${body}"`;

async function start(extra = []) {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const reviewer = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const init = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, ...extra], "worker"), repo),
    { agents, stdin: stdinPrompt },
  );
  return { repo, reviewer, agents, init };
}

const reviewerTurn = (repo, agents, overrides = []) =>
  executeRoleCommand(withRepo(dispatchArgv(overrides, "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
  });

// Usefulness: verifies the init call records the command and its bound in the
// state file, so a later dispatch, which is a new process, still has them
// (issue #420).
test("init records the test command and its bound", async () => {
  const { repo, init } = await start(["--test-cmd", "pnpm test", "--test-cmd-timeout", "90"]);
  expect(init.exitCode).toBe(0);
  expect(await readRepoState(repo)).toMatchObject({ testCmd: "pnpm test", testCmdTimeout: 90 });
});

// Usefulness: verifies a run with no `--test-cmd` writes neither field, so the
// state file keeps the shape a consumer already reads (issue #420).
test("a run without --test-cmd records no test command fields", async () => {
  const { repo } = await start();
  const state = await readRepoState(repo);
  expect(state).not.toHaveProperty("testCmd");
  expect(state).not.toHaveProperty("testCmdTimeout");
});

// Usefulness: verifies a reviewer dispatch runs the stored command, supplies the
// result in the prompt, and reports it in the envelope and the state file, so the
// parent can compare it with the reviewer Checks line (issue #420).
test("a reviewer dispatch supplies the test result in the prompt, envelope, and state", async () => {
  const { repo, reviewer, agents } = await start(["--test-cmd", node("console.log('5 passed')")]);
  const turn = await reviewerTurn(repo, agents);
  expect(turn.exitCode).toBe(0);
  expect(reviewer.recorded[0].prompt).toContain("5 passed");
  expect(reviewer.recorded[0].prompt).toContain("Result: exit 0.");
  expect(turn.payload.testRun).toMatchObject({ status: "pass", exitCode: 0, advisory: true });
  expect((await readRepoState(repo)).lastResult.testRun).toMatchObject({ status: "pass" });
});

// Usefulness: verifies a worker dispatch runs no command and carries no result,
// because the command belongs to reviewer turns only (issue #420).
test("a worker dispatch runs no test command", async () => {
  const { repo, agents } = await start(["--test-cmd", node("console.log('ran')")]);
  const state = await readRepoState(repo);
  expect(state.lastResult).not.toHaveProperty("testRun");
  const second = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(second.payload).not.toHaveProperty("testRun");
});

// Usefulness: verifies a timed-out command reports as timed out in the envelope
// and the turn still completes, so a slow suite does not end the run (issue #420).
test("a timed-out command is reported in the envelope and the turn completes", async () => {
  const { repo, agents } = await start([
    "--test-cmd",
    node("setTimeout(() => {}, 60000)"),
    "--test-cmd-timeout",
    "1",
  ]);
  const turn = await reviewerTurn(repo, agents);
  expect(turn.exitCode).toBe(0);
  expect(turn.payload.testRun).toMatchObject({ status: "timed-out", timedOut: true });
}, 20_000);

// Usefulness: verifies a later call cannot change the command, so only the init
// flag sets it (issue #420, ADR 0017).
test("a later call rejects a changed or added test command", async () => {
  const { repo, agents } = await start(["--test-cmd", "pnpm test"]);
  const changed = await reviewerTurn(repo, agents, ["--test-cmd", "rm -rf /"]);
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--test-cmd cannot be changed after init");
  const same = await reviewerTurn(repo, agents, ["--test-cmd", "pnpm test"]);
  expect(same.payload.error ?? "").not.toContain("cannot be changed");

  const plain = await start();
  const added = await reviewerTurn(plain.repo, plain.agents, ["--test-cmd", "pnpm test"]);
  expect(added.payload.error).toContain("--test-cmd cannot be changed after init");
});

// Usefulness: verifies init refuses a bound with no command and a blank command,
// so a run never starts with a half-set pair (issue #420).
test("init refuses a bound without a command and a blank command", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const deps = { agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) } };
  for (const [extra, message] of [
    [["--test-cmd-timeout", "5"], "--test-cmd-timeout requires --test-cmd."],
    [["--test-cmd", "  "], "--test-cmd must not be blank."],
  ]) {
    const result = await executeRoleCommand(
      withRepo(dispatchArgv([...INIT_OVERRIDES, ...extra], "worker"), repo),
      { ...deps, stdin: stdinPrompt },
    );
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain(message);
  }
});
