import { afterEach, expect, test } from "vite-plus/test";
import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
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

// Interactive behavior of the Codex reviewer sandbox mode (issue #421, ADR 0019, ADR 0038).
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
const FLAG = "--reviewer-sandbox";
const ALIAS = "--reviewer-workspace-write";

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

// Usefulness: verifies a new run with no flag records `none` and passes it to the reviewer turn
// only, with readOnly kept, so the worker turn and the read-only guard are unchanged (ADR 0038).
test("a new run without the flag stores none and a reviewer dispatch passes it", async () => {
  const { repo, worker, reviewer, agents, init } = await start();
  expect(init.exitCode).toBe(0);
  expect((await readRepoState(repo)).reviewerSandbox).toBe("none");
  expect(worker.recorded[0].options).not.toHaveProperty("sandbox");

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(reviewer.recorded[0].options).toMatchObject({ readOnly: true, sandbox: "none" });
  expect(reviewer.recorded[0].prompt).toContain("no sandbox");
});

// Usefulness: verifies each flag form stores its mode at init and passes it on every dispatch,
// including the alias, so the opt-in modes reach the adapter (ADR 0038).
test.each([
  [[FLAG, "read-only"], "read-only"],
  [[FLAG, "workspace-write"], "workspace-write"],
  [[ALIAS], "workspace-write"],
])("init with %j stores %s and the reviewer turn passes it", async (extra, mode) => {
  const { repo, reviewer, agents } = await start(extra);
  expect((await readRepoState(repo)).reviewerSandbox).toBe(mode);
  await reviewerTurn(repo, agents);
  expect(reviewer.recorded[0].options).toMatchObject({ readOnly: true, sandbox: mode });
  expect(reviewer.recorded[0].prompt).toContain(`${mode} sandbox`);
});

// Usefulness: verifies the init-field rules: the stored value governs a call that omits the
// flag, and a call that repeats the same value, or its alias, is accepted.
test("a later call reads the stored mode and accepts the same value again", async () => {
  const { repo, reviewer, agents } = await start([FLAG, "workspace-write"]);
  await reviewerTurn(repo, agents);
  expect((await reviewerTurn(repo, agents, [FLAG, "workspace-write"])).exitCode).toBe(0);
  expect((await reviewerTurn(repo, agents, [ALIAS])).exitCode).toBe(0);
  expect(reviewer.recorded.map((r) => r.options.sandbox)).toEqual([
    "workspace-write",
    "workspace-write",
    "workspace-write",
  ]);
});

// Usefulness: verifies the mode cannot change after init in either direction, so a later call
// cannot widen the sandbox of a run that started sandboxed, nor narrow a no-sandbox run.
test.each([
  [[], [FLAG, "read-only"], "none"],
  [[], [ALIAS], "none"],
  [[FLAG, "read-only"], [FLAG, "workspace-write"], "read-only"],
  [[FLAG, "workspace-write"], [FLAG, "read-only"], "workspace-write"],
])("init %j then a call with %j is refused", async (initFlags, later, held) => {
  const { repo, reviewer, agents } = await start(initFlags);
  const turn = await reviewerTurn(repo, agents, later);
  expect(turn.exitCode).toBe(1);
  expect(turn.payload.error).toContain(
    `--reviewer-sandbox cannot be changed after init (state holds: ${held}).`,
  );
  expect(reviewer.recorded).toHaveLength(0);
});

// Usefulness: verifies the flag is refused at init for a reviewer that is not Codex, before any
// state is written, and that such a run stores and passes no mode (ADR 0038).
test("init refuses the flag for a reviewer that is not Codex, and stores no mode without it", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const other = INIT.map((v) => (v === "codex" ? "fake2" : v));
  const refused = await executeRoleCommand(
    withRepo(dispatchArgv([...other, FLAG, "read-only"], "worker"), repo),
    { agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("--reviewer-sandbox requires --reviewer codex.");
  expect(await readState(statePaths({ cwd: repo }).stateFile)).toBeNull();

  const fake2 = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2 };
  await executeRoleCommand(withRepo(dispatchArgv(other, "worker"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(await readRepoState(repo)).not.toHaveProperty("reviewerSandbox");
  await reviewerTurn(repo, agents);
  expect(fake2.recorded[0].options).not.toHaveProperty("sandbox");
  expect(fake2.recorded[0].prompt).not.toMatch(/sandbox/i);
});

// Usefulness: verifies a state file from before ADR 0038 never loses its sandbox: it gets
// `workspace-write` with the legacy field and `read-only` without it, never `none`.
test.each([
  [{ reviewerWorkspaceWrite: true }, "workspace-write"],
  [{}, "read-only"],
])("a state file with no recorded mode and %j gets %s", async (legacy, mode) => {
  const { repo, reviewer, agents } = await start();
  const { stateFile } = statePaths({ cwd: repo });
  const state = await readState(stateFile);
  delete state.reviewerSandbox;
  await writeState(stateFile, { ...state, ...legacy });

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(reviewer.recorded[0].options.sandbox).toBe(mode);
  // A later call that names the legacy mode is a repeat, and any other mode is a change.
  expect((await reviewerTurn(repo, agents, [FLAG, mode])).exitCode).toBe(0);
  const other = mode === "read-only" ? "workspace-write" : "read-only";
  expect((await reviewerTurn(repo, agents, [FLAG, other])).exitCode).toBe(1);
});
