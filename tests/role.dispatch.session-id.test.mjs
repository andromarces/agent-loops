import { afterEach, expect } from "vite-plus/test";
import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  REPORT,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createBarrierTest } from "./barrier-test.mjs";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

afterEach(cleanup);

// Usefulness: verifies a failed first turn that reported a session id persists it, so the next
// dispatch resumes that session, and a missing resumed session clears the stored id and reruns as
// a first turn without a second step (issue #360, ADR 0016).
test("a failed first turn keeps its session id and a missing session falls back in one step", async () => {
  const repo = await newRunRepo();
  const prompts = [];
  const worker = {
    async run(state, prompt) {
      prompts.push({ sessionId: state.sessionId, prompt });
      if (prompts.length === 1) {
        state.sessionId = "sess-failed";
        throw new Error("boom");
      }
      if (state.sessionId === "sess-failed") {
        throw Object.assign(new Error("No conversation found"), { sessionMissing: true });
      }
      state.sessionId = "sess-new";
      return REPORT;
    },
  };
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  const first = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(first.payload).toMatchObject({ status: "error" });
  expect((await readRepoState(repo)).roles.worker.sessionId).toBe("sess-failed");

  const second = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(second.payload).toMatchObject({ status: "ok" });
  expect(prompts.map((p) => p.sessionId)).toEqual([null, "sess-failed", null]);
  expect(prompts[1].prompt).not.toContain("You are the implementation agent");
  expect(prompts[2].prompt).toContain("You are the implementation agent");

  const state = await readRepoState(repo);
  expect(state).toMatchObject({ stepsUsed: 2 });
  expect(state.turns).toHaveLength(2);
  expect(state.roles.worker.sessionId).toBe("sess-new");
});

// Usefulness: verifies a pre-assigned session id reaches the state file before the child runs, so
// a parent crash during a first turn still leaves the id that the resume after
// `--resume-interrupted` needs (issue #395). No other test reads the state file mid-turn.
test("a pre-assigned session id is persisted before the child turn runs", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });
  let midTurn = null;
  const worker = {
    async run(state, _prompt, options) {
      await options.onSessionAssigned("pre-1");
      midTurn = await readState(paths.stateFile);
      throw new Error("parent crashed");
    },
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(midTurn).toMatchObject({
    lifecycle: "dispatched",
    roles: { worker: { sessionId: "pre-1" } },
  });

  // Restore the mid-turn file, as left by a crash, then recover.
  await writeState(paths.stateFile, midTurn);
  const resumer = recordingAdapter([]);
  const agents = { fake1: resumer, fake2: recordingAdapter([]) };
  const marked = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(marked.exitCode).toBe(1);
  const resumed = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(resumed.exitCode).toBe(0);
  expect(resumer.recorded[0].incomingSessionId).toBe("pre-1");
});

// Usefulness: verifies the early-persisted id is cleared in the state file as soon as the adapter
// reports it rejected, so a parent crash right after the rejection cannot leave an id that
// `--resume-interrupted` would resume (issue #395). The result write alone cannot cover that window.
test("a rejected pre-assigned id is cleared from the state file before the turn ends", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });
  let afterRejection = null;
  const worker = {
    async run(_state, _prompt, options) {
      await options.onSessionAssigned("pre-rejected");
      await options.onSessionAssigned(null);
      afterRejection = await readState(paths.stateFile);
      throw new Error("parent crashed");
    },
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(afterRejection).toMatchObject({
    lifecycle: "dispatched",
    roles: { worker: { sessionId: null } },
  });
});

// Usefulness: verifies a turn that fails with no id on its role state clears the id persisted
// before the turn, so a rejected pre-assigned id never becomes a resume target (issue #395).
test("a failed first turn that keeps no id clears the pre-assigned id from the state file", async () => {
  const repo = await newRunRepo();
  const worker = {
    async run(state, _prompt, options) {
      await options.onSessionAssigned("pre-rejected");
      state.sessionId = null;
      throw new Error("Session ID pre-rejected is already in use.");
    },
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload).toMatchObject({ status: "error" });
  expect((await readRepoState(repo)).roles.worker.sessionId).toBeNull();
});

// Usefulness: verifies the unconfirmed mark is saved with the early id, so recovery can tell an
// id the CLI never confirmed from one it did, and that a turn which confirms it clears the saved
// mark (issue #395).
test("the state file marks a pre-assigned id unconfirmed until the turn confirms it", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });
  let midTurn = null;
  const worker = {
    async run(state, _prompt, options) {
      state.sessionUnconfirmed = true;
      await options.onSessionAssigned("pre-2");
      midTurn = await readState(paths.stateFile);
      state.sessionId = "pre-2";
      delete state.sessionUnconfirmed;
      return REPORT;
    },
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(midTurn.roles.worker).toMatchObject({ sessionId: "pre-2", sessionUnconfirmed: true });
  const after = (await readState(paths.stateFile)).roles.worker;
  expect(after.sessionId).toBe("pre-2");
  expect(after.sessionUnconfirmed).toBeUndefined();
});
