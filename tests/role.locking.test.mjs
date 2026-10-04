import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
  WORKER_REPLY,
} from "./role-helpers.mjs";
import { createTempRepo, deadPid } from "./runtime-helpers.mjs";

afterEach(cleanup);

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
//
// The winner's child holds the lock until the loser has returned, so the result
// does not depend on how long either call takes to start. A fixed delay in the
// child let a loaded runner start the second call after the first had released
// the lock, and both then ran (issue #399). A second child that starts anyway
// releases the first at once, so a broken lock fails on the assertions and does
// not hang.
test("concurrent dispatches: exactly one child runs, the loser exits non-zero", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const first = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });
  expect(first.exitCode).toBe(0);

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const holdingWorker = {
    recorded: [],
    async run(state, prompt, options) {
      this.recorded.push({ state, prompt, options });
      state.sessionId = "sess-slow";
      if (this.recorded.length > 1) {
        release();
      }
      await held;
      return WORKER_REPLY;
    },
  };
  const agents = { fake1: holdingWorker, fake2: recordingAdapter([]) };
  const args = withRepo(dispatchArgv(), repo);

  const calls = [
    executeRoleCommand(args, { agents, stdin: stdinPrompt }),
    executeRoleCommand(args, { agents, stdin: stdinPrompt }),
  ];
  // The call that settles first is the loser: the winner is parked in its child.
  const loser = await Promise.race(calls);
  release();
  const [a, b] = await Promise.all(calls);

  expect([a.exitCode, b.exitCode].sort()).toEqual([0, 1]);
  expect(loser.exitCode).toBe(1);
  // Both refusal messages stay valid fail-closed outcomes: atomic creation
  // (#176) removes the half-written window, but a contender that loses the
  // link race can still read after the winner releases (removal race, #172).
  expect(loser.payload.error).toMatch(/locked by a live process|not readable yet/);
  expect(holdingWorker.recorded.length).toBe(1);
  expect((await readRepoState(repo)).stepsUsed).toBe(2);
});
