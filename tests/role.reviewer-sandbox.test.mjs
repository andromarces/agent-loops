import { afterEach, expect, test } from "vitest";
import { readState, statePaths } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

// Interactive behavior of `--reviewer-workspace-write` (issue #421, ADR 0019).
const INIT = [
  "--task",
  "Fix the flaky test.",
  "--mode",
  "work-first",
  "--parent-session",
  "parent-sess-1",
  "--worker",
  "fake1",
  "--reviewer",
  "codex",
];
const FLAG = "--reviewer-workspace-write";

async function start(extra = []) {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const worker = recordingAdapter([]);
  const reviewer = recordingAdapter([]);
  const agents = { fake1: worker, codex: reviewer };
  const init = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT, ...extra], "worker"), repo),
    { agents, stdin: stdinPrompt },
  );
  return { repo, worker, reviewer, agents, init };
}

const reviewerTurn = (repo, agents, overrides = []) =>
  executeRoleCommand(withRepo(dispatchArgv(overrides, "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
  });

// Usefulness: verifies the opt-in is stored at init and reaches only the reviewer turn as the
// sandbox input, with readOnly kept, so the worker turn and the read-only guard are unchanged.
test("init stores the opt-in and a reviewer dispatch passes the sandbox input", async () => {
  const { repo, worker, reviewer, agents, init } = await start([FLAG]);
  expect(init.exitCode).toBe(0);
  expect((await readRepoState(repo)).reviewerWorkspaceWrite).toBe(true);
  expect(worker.recorded[0].options).not.toHaveProperty("sandbox");

  const turn = await reviewerTurn(repo, agents);
  expect(turn.exitCode).toBe(0);
  expect(reviewer.recorded[0].options).toMatchObject({
    readOnly: true,
    sandbox: "workspace-write",
  });
  expect(reviewer.recorded[0].prompt).toContain("workspace-write");
});

// Usefulness: verifies a run without the opt-in keeps the state shape, the read-only reviewer
// input, and the prompt it had before the setting existed.
test("a run without the opt-in records no field and passes no sandbox input", async () => {
  const { repo, reviewer, agents } = await start();
  expect(await readRepoState(repo)).not.toHaveProperty("reviewerWorkspaceWrite");
  await reviewerTurn(repo, agents);
  expect(reviewer.recorded[0].options.readOnly).toBe(true);
  expect(reviewer.recorded[0].options).not.toHaveProperty("sandbox");
  expect(reviewer.recorded[0].prompt).not.toContain("workspace-write");
});

// Usefulness: verifies the init-field rules: the stored value governs a call that omits the
// flag, and a call that repeats the same value is accepted.
test("a later call reads the stored opt-in and accepts the same value again", async () => {
  const { repo, reviewer, agents } = await start([FLAG]);
  await reviewerTurn(repo, agents);
  const again = await reviewerTurn(repo, agents, [FLAG]);
  expect(again.exitCode).toBe(0);
  expect(reviewer.recorded.map((r) => r.options.sandbox)).toEqual([
    "workspace-write",
    "workspace-write",
  ]);
});

// Usefulness: verifies the opt-in cannot be switched on after init, so a later call cannot widen
// the sandbox of a run that started read-only.
test("a later call cannot turn the opt-in on", async () => {
  const { repo, reviewer, agents } = await start();
  const turn = await reviewerTurn(repo, agents, [FLAG]);
  expect(turn.exitCode).toBe(1);
  expect(turn.payload.error).toContain(`${FLAG} cannot be changed after init`);
  expect(reviewer.recorded).toHaveLength(0);
});

// Usefulness: verifies the opt-in is refused at init for a reviewer that is not Codex, before any
// state is written, so it never claims a sandbox that no adapter applies.
test("init refuses the opt-in for a reviewer that is not Codex", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const result = await executeRoleCommand(
    withRepo(
      dispatchArgv(INIT.map((v) => (v === "codex" ? "fake2" : v)).concat(FLAG), "worker"),
      repo,
    ),
    { agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain(`${FLAG} requires --reviewer codex.`);
  expect(await readState(statePaths({ cwd: repo }).stateFile)).toBeNull();
});
