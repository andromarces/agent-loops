import { afterEach, expect, test } from "vitest";
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
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

// Usefulness: verifies acceptance — finish from active in review-only mode
// succeeds with verdict: reject recorded in the summary.
test("finish from active in review-only mode succeeds with the verdict recorded", async () => {
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
        "--worker",
        "fake1",
        "--reviewer",
        "fake2",
      ],
      "reviewer",
    ),
    repo,
  );
  await executeRoleCommand(init, {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  const summary = {
    changed: "none",
    verified: "review ran",
    deferred: "none",
    notDone: "verdict: reject, two blockers open",
    open: "blockers 1 and 2",
  };
  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(summary),
  });
  expect(result.exitCode).toBe(0);

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("finished");
  expect(state.summary.notDone).toContain("verdict: reject");
});

// Usefulness: verifies acceptance — finish with an invalid summary exits
// non-zero and leaves lifecycle active.
test("finish with an invalid summary exits non-zero and keeps lifecycle active", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });

  const finishArgs = withRepo(["finish", "--cwd", "<repo>"], repo);
  const badJson = await executeRoleCommand(finishArgs, { stdin: async () => "not json" });
  expect(badJson.exitCode).toBe(1);
  expect(badJson.payload.error).toContain("finish summary must be a JSON object");

  const missingKey = await executeRoleCommand(finishArgs, {
    stdin: async () => JSON.stringify({ changed: "a", verified: "b" }),
  });
  expect(missingKey.exitCode).toBe(1);
  expect(missingKey.payload.error).toContain("non-empty string for deferred");

  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies finish and abort read configuration from the state file
// too — a changed init flag exits non-zero and leaves the state unchanged.
test("finish and abort reject changed init flags", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());

  const badFinish = await executeRoleCommand(
    withRepo(["finish", "--cwd", "<repo>", "--max-steps", "99"], repo),
    {
      stdin: async () =>
        JSON.stringify({ changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" }),
    },
  );
  expect(badFinish.exitCode).toBe(1);
  expect(badFinish.payload.error).toContain("--max-steps cannot be changed after init");

  const badAbort = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "r", "--mode", "review-only"], repo),
  );
  expect(badAbort.exitCode).toBe(1);
  expect(badAbort.payload.error).toContain("--mode cannot be changed after init");

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("active");
  expect(state.maxSteps).toBe(20);
  expect(state.mode).toBe("work-first");
});
