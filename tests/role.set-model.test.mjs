import { afterEach, expect, test, vi } from "vite-plus/test";
import { SPAWNED_RUN_ENV, exec } from "../src/lib/exec.mjs";
import { statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand, parseRoleArgs } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  readRepoState,
  recordingAdapter,
  reviewerTurn,
  startRun,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});

const REFUSED = "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.";

const setModelArgv = (...flags) => [
  "set-model",
  "--cwd",
  "<repo>",
  "--parent-session",
  "parent-sess-1",
  ...flags,
];

const setModel = (repo, ...flags) =>
  executeRoleCommand(withRepo(setModelArgv(...flags), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
  });

/** An adapter that records the model of each turn and fails the turns while `refuse` returns true. */
function modelAdapter(refuse = () => false) {
  const adapter = recordingAdapter([]);
  adapter.models = [];
  adapter.run = async (state) => {
    adapter.models.push(state.model);
    if (refuse(state.model)) {
      throw new Error(REFUSED);
    }
    return "Conclusion: done\nWhy: ok\nBlockers: none";
  };
  return adapter;
}

/** A run whose reviewer model the reviewer CLI refuses on the first reviewer turn. */
async function startRefusedReviewerRun() {
  const worker = modelAdapter();
  const reviewer = modelAdapter((model) => model === "gpt-6.1");
  const agents = { fake1: worker, fake2: reviewer };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  const failed = await reviewerTurn(repo, agents);
  expect(failed.exitCode).toBe(1);
  return { repo, agents, reviewer };
}

// Usefulness: verifies acceptance of #1254 — a reviewer model that the CLI refused is replaced on
// the same run, so the worker keeps its session and the next reviewer turn runs the valid model.
test("set-model replaces the model of a role that completed no turn and keeps the run", async () => {
  const { repo, agents, reviewer } = await startRefusedReviewerRun();
  const before = await readRepoState(repo);

  const result = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    role: "reviewer",
    model: "gpt-6.1-sol",
    previousModel: "gpt-6.1",
  });

  const state = await readRepoState(repo);
  expect(state.roles.reviewer.model).toBe("gpt-6.1-sol");
  expect(state.roles.worker).toEqual(before.roles.worker);
  expect(state.stepsUsed).toBe(before.stepsUsed);
  expect(state.turns).toEqual(before.turns);
  expect(state.modelChanges).toEqual([
    { role: "reviewer", from: "gpt-6.1", to: "gpt-6.1-sol", at: expect.any(String) },
  ]);

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(reviewer.models).toEqual(["gpt-6.1", "gpt-6.1-sol"]);
});

// Usefulness: verifies the replacement cannot reach a role whose conversation already ran on the
// old model, so a later model change cannot split one session across two models.
test("set-model refuses a role that completed a turn", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const before = await readRepoState(repo);
  expect(before.turns.map((turn) => [turn.role, turn.status])).toEqual([["worker", "ok"]]);

  const refused = await setModel(repo, "--worker-model", "other");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("completed a turn");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a turn in flight or an unresolved one blocks the change, because the child
// of that turn can still run on the old model, and a terminal run takes no change.
test("set-model refuses a run that is not active", async () => {
  for (const lifecycle of ["dispatched", "interrupted"]) {
    const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
    const state = await readRepoState(repo);
    state.lifecycle = lifecycle;
    await writeState(statePaths({ cwd: repo }).stateFile, state);

    const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
    expect(refused.exitCode, lifecycle).toBe(1);
    expect(refused.payload.error, lifecycle).toContain(lifecycle);
    expect((await readRepoState(repo)).roles.reviewer.model, lifecycle).toBe("gpt-6.1");
  }

  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  const ended = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(ended.payload.error).toBe("Run is already aborted.");
});

// Usefulness: verifies the call names exactly one role model, and the run's parent session id,
// so no call changes both roles at once or runs without the guard check that extend uses.
test("set-model refuses a missing or ambiguous model flag and a wrong parent session", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const before = await readRepoState(repo);

  const none = await setModel(repo);
  expect(none.payload.error).toContain("exactly one of --worker-model and --reviewer-model");
  const both = await setModel(repo, "--worker-model", "a", "--reviewer-model", "b");
  expect(both.payload.error).toContain("exactly one of --worker-model and --reviewer-model");

  const noSession = await executeRoleCommand(
    withRepo(["set-model", "--cwd", "<repo>", "--reviewer-model", "b"], repo),
  );
  expect(noSession.payload.error).toContain("--parent-session");
  const wrong = await executeRoleCommand(
    withRepo(
      ["set-model", "--cwd", "<repo>", "--parent-session", "other", "--reviewer-model", "b"],
      repo,
    ),
  );
  expect(wrong.payload.error).toContain("does not match");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a role that the run never configured, as the worker of a review-only run,
// has no model to replace.
test("set-model refuses a role that the run did not configure", async () => {
  const { repo } = await startRun({ initFlags: ["--mode", "review-only"], role: "reviewer" });
  const state = await readRepoState(repo);
  state.roles.worker = null;
  await writeState(statePaths({ cwd: repo }).stateFile, state);
  const refused = await setModel(repo, "--worker-model", "other");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("no worker");
});

// Usefulness: verifies the OpenCode model and effort pair stays valid after the change, as at init.
test("set-model refuses an OpenCode model variant that conflicts with the stored effort", async () => {
  const { repo } = await startRun({
    initFlags: ["--reviewer", "opencode", "--reviewer-model", "p/m", "--reviewer-effort", "high"],
  });
  const refused = await setModel(repo, "--reviewer-model", "p/m#low");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("already contains a variant");
  expect((await readRepoState(repo)).roles.reviewer.model).toBe("p/m");
});

// Usefulness: verifies a spawned child of the run cannot change the model, as it cannot run extend.
test("set-model refuses a child caller of the run", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const script = `console.log(process.env.${SPAWNED_RUN_ENV})`;
  const spawned = await exec(process.execPath, ["-e", script], { role: "worker", cwd: repo });
  vi.stubEnv(SPAWNED_RUN_ENV, spawned.stdout.trim());
  const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("child role");
  expect((await readRepoState(repo)).roles.reviewer.model).toBe("gpt-6.1");
});

// Usefulness: verifies dispatch still rejects a changed model, so set-model stays the only route.
test("dispatch still refuses a changed role model after init", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const refused = await executeRoleCommand(
    withRepo(dispatchArgv(["--reviewer-model", "gpt-6.1-sol"], "reviewer"), repo),
    { stdin: stdinPrompt },
  );
  expect(refused.payload.error).toContain("--reviewer-model cannot be changed after init");
});

// Usefulness: verifies the role comes from the model flag alone, so a dispatch flag is refused.
test("set-model refuses --role", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const refused = await setModel(repo, "--role", "reviewer", "--reviewer-model", "gpt-6.1-sol");
  expect(refused.payload.error).toBe("--role is only valid for dispatch.");
  expect(parseRoleArgs(setModelArgv("--reviewer-model", "m")).operation).toBe("set-model");
});
