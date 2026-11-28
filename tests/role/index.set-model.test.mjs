import { stat } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { SPAWNED_RUN_ENV, spawnedRunMarker } from "../../src/lib/exec.mjs";
import { statePaths, writeState } from "../../src/lib/runstate.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role/index.mjs";
import {
  cleanup,
  dispatchArgv,
  finishCall,
  initRun,
  newCleanRunRepo,
  readRepoState,
  recordingAdapter,
  REPORT,
  reviewerTurn,
  stdinPrompt,
  withRepo,
} from "./helpers.mjs";

// `cleanRepoGit` doubles every Git guard and read of this case; `tests/git-helpers.mjs` lists them.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

const startRun = async (options = {}) => {
  const repo = await newCleanRunRepo(gitDouble);
  return { repo, agents: await initRun(repo, options) };
};

afterEach(cleanup);
afterEach(() => {
  gitDouble.answer = null;
  vi.unstubAllEnvs();
});

const REFUSED = "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.";

/** A failed turn that the adapter marks as a provider safety refusal (issue #2056). */
const providerSafetyRefusal = () =>
  Object.assign(new Error("codex exited with code 1."), { refusal: "provider-safety" });

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

const setModelOn = (repo, agents, ...flags) =>
  executeRoleCommand(withRepo(setModelArgv(...flags), repo), { agents });

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

/** A run whose reviewer completed an ok turn and then failed with a provider-safety refusal. */
async function startSafetyRefusedReviewerRun() {
  const seen = [];
  let call = 0;
  const reviewer = recordingAdapter([]);
  reviewer.run = async (state, prompt) => {
    call += 1;
    seen.push({ model: state.model, incomingSessionId: state.sessionId, prompt });
    if (state.sessionId === null) state.sessionId = `sess-${call}`;
    if (call === 2) throw providerSafetyRefusal();
    return `${REPORT}\nVerdict: accept`;
  };
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  return { repo, agents, reviewer, seen };
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

// Usefulness: verifies #1274 — a same-model request succeeds without recording a change that did not
// happen, so the history lists only real replacements and the state file is not rewritten.
test("set-model succeeds on the current model without a history entry or a state write", async () => {
  const { repo } = await startRefusedReviewerRun();
  expect((await setModel(repo, "--reviewer-model", "gpt-6.1-sol")).exitCode).toBe(0);
  const { stateFile } = statePaths({ cwd: repo });
  const before = await readRepoState(repo);
  const mtimeBefore = (await stat(stateFile)).mtimeMs;

  const repeated = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(repeated.exitCode).toBe(0);
  expect(repeated.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    role: "reviewer",
    model: "gpt-6.1-sol",
    previousModel: "gpt-6.1-sol",
  });
  expect(before.modelChanges).toHaveLength(1);
  expect(await readRepoState(repo)).toEqual(before);
  expect((await stat(stateFile)).mtimeMs).toBe(mtimeBefore);
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
  vi.stubEnv(SPAWNED_RUN_ENV, spawnedRunMarker(repo));
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

// Usefulness: verifies a role whose refused first turn kept a session id still takes set-model, and
// that the next dispatch resumes that kept session on the new model, where a new run would not.
test("set-model accepts a role whose failed first turn kept a session id and the next dispatch resumes it", async () => {
  const seen = [];
  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    seen.push({ model: state.model, incomingSessionId: state.sessionId });
    state.sessionId = "sess-kept";
    if (state.model === "gpt-6.1") throw new Error(REFUSED);
    return "Conclusion: done\nWhy: ok\nBlockers: none";
  };
  const agents = { fake1: modelAdapter(), fake2: reviewer };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  expect((await readRepoState(repo)).roles.reviewer.sessionId).toBe("sess-kept");

  expect((await setModel(repo, "--reviewer-model", "gpt-6.1-sol")).exitCode).toBe(0);
  expect((await readRepoState(repo)).roles.reviewer.sessionId).toBe("sess-kept");

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(seen).toEqual([
    { model: "gpt-6.1", incomingSessionId: null },
    { model: "gpt-6.1-sol", incomingSessionId: "sess-kept" },
  ]);
});

// Usefulness: verifies acceptance of #2065 — a reviewer that keeps an ok turn and then fails with a
// provider-safety refusal takes a model change, starts a new session with the init task, and keeps
// the worker session, so a recurring refusal no longer needs abort and a new run.
test("set-model accepts a reviewer whose latest turn is a provider-safety refusal and restarts its session", async () => {
  const { repo, agents, seen } = await startSafetyRefusedReviewerRun();
  const before = await readRepoState(repo);
  expect(before.turns.at(-1)).toMatchObject({
    role: "reviewer",
    status: "error",
    refusal: "provider-safety",
  });
  expect(before.roles.reviewer.sessionId).toBe("sess-1");
  const workerBefore = before.roles.worker.sessionId;

  const result = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    role: "reviewer",
    model: "gpt-6.1-sol",
    previousModel: "gpt-6.1",
  });

  const changed = await readRepoState(repo);
  expect(changed.modelChanges).toEqual([
    { role: "reviewer", from: "gpt-6.1", to: "gpt-6.1-sol", at: expect.any(String) },
  ]);
  expect(changed.roles.reviewer).toMatchObject({ model: "gpt-6.1-sol", sessionId: null });
  expect(changed.roles.worker.sessionId).toBe(workerBefore);
  expect(changed.stepsUsed).toBe(before.stepsUsed);
  expect(changed.turns).toEqual(before.turns);

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(seen.at(-1)).toMatchObject({ model: "gpt-6.1-sol", incomingSessionId: null });
  expect(seen.at(-1).prompt).toContain("Init task:\nFix the flaky test.");
});

// Usefulness: verifies the first-refusal case of #2065 — a reviewer whose only turn is a
// provider-safety refusal that kept a session id starts a new session on the next dispatch, with
// the new model and the init task, so no refused thread is resumed.
test("set-model starts a new reviewer session after a first provider-safety refusal that kept an id", async () => {
  const seen = [];
  const reviewer = recordingAdapter([]);
  reviewer.run = async (state, prompt) => {
    seen.push({ model: state.model, incomingSessionId: state.sessionId, prompt });
    if (seen.length === 1) {
      state.sessionId = "sess-refused";
      throw providerSafetyRefusal();
    }
    return `${REPORT}\nVerdict: accept`;
  };
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  const before = await readRepoState(repo);
  expect(
    before.turns.filter((turn) => turn.role === "reviewer").map((turn) => turn.status),
  ).toEqual(["error"]);
  expect(before.turns.find((turn) => turn.role === "reviewer").refusal).toBe("provider-safety");
  expect(before.roles.reviewer.sessionId).toBe("sess-refused");

  const changed = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(changed.exitCode).toBe(0);
  expect((await readRepoState(repo)).roles.reviewer).toMatchObject({
    model: "gpt-6.1-sol",
    sessionId: null,
  });
  expect((await readRepoState(repo)).modelChanges).toEqual([
    { role: "reviewer", from: "gpt-6.1", to: "gpt-6.1-sol", at: expect.any(String) },
  ]);

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(seen.at(-1)).toMatchObject({ model: "gpt-6.1-sol", incomingSessionId: null });
  expect(seen.at(-1).prompt).toContain("Init task:\nFix the flaky test.");
});

// Usefulness: verifies a reviewer with an ok turn and no provider-safety refusal stays refused, so
// the exception cannot split an ordinary conversation across two models.
test("set-model refuses a reviewer with an ok turn and no provider-safety refusal", async () => {
  const { repo, agents } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  const before = await readRepoState(repo);

  const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("completed a turn");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a provider-safety refusal that a later ok turn clears no longer permits the
// change, so only the latest turn decides the exception.
test("set-model refuses a reviewer whose provider-safety refusal a later ok turn followed", async () => {
  let call = 0;
  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    call += 1;
    if (state.sessionId === null) state.sessionId = "sess-1";
    if (call === 2) throw providerSafetyRefusal();
    return `${REPORT}\nVerdict: accept`;
  };
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  const before = await readRepoState(repo);
  expect(before.turns.at(-1).status).toBe("ok");

  const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("completed a turn");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies only the latest turn decides the exception, so a model refusal after an
// earlier provider-safety refusal refuses the change and no refused thread is dropped by mistake.
test("set-model refuses a reviewer whose provider-safety refusal a later model refusal followed", async () => {
  let call = 0;
  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    call += 1;
    if (state.sessionId === null) state.sessionId = "sess-1";
    if (call === 2) throw providerSafetyRefusal();
    if (call === 3) {
      throw Object.assign(new Error(REFUSED), { refusedModel: "gpt-6.1" });
    }
    return `${REPORT}\nVerdict: accept`;
  };
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  const before = await readRepoState(repo);
  expect(before.turns.at(-1)).toMatchObject({ role: "reviewer", status: "error" });
  expect(before.turns.at(-1).refusal).toBeUndefined();
  expect(before.roles.reviewer.sessionId).toBe("sess-1");

  const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("completed a turn");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a finished run refuses the change, so a terminal run takes no model change.
test("set-model refuses a finished run", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  expect((await finishCall(repo)).exitCode).toBe(0);
  const before = await readRepoState(repo);
  expect(before.lifecycle).toBe("finished");

  const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toBe("Run is already finished.");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies the exception names the reviewer only, so a worker whose provider-safety
// refusal follows an ok turn keeps the rule that a conversation on the old model is refused.
test("set-model refuses a worker after a provider-safety refusal that an ok turn preceded", async () => {
  const failing = recordingAdapter([
    () => {
      throw providerSafetyRefusal();
    },
  ]);
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const failed = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents: { fake1: failing, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(failed.payload.refusal).toBe("provider-safety");
  const before = await readRepoState(repo);

  const refused = await setModel(repo, "--worker-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("completed a turn");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a state file with no turn history is still refused on the provider-safety
// path, because it cannot prove the latest turn.
test("set-model refuses a run with no turn history", async () => {
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  const state = await readRepoState(repo);
  delete state.turns;
  await writeState(statePaths({ cwd: repo }).stateFile, state);
  const before = await readRepoState(repo);

  const refused = await setModel(repo, "--reviewer-model", "gpt-6.1-sol");
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("kept no turn history");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a same-model request on the provider-safety path writes no state, so the
// reviewer session is not reset by a change that did not happen.
test("set-model succeeds on the current model on the provider-safety path without a state write", async () => {
  const { repo } = await startSafetyRefusedReviewerRun();
  const { stateFile } = statePaths({ cwd: repo });
  const before = await readRepoState(repo);
  const mtimeBefore = (await stat(stateFile)).mtimeMs;

  const repeated = await setModel(repo, "--reviewer-model", "gpt-6.1");
  expect(repeated.exitCode).toBe(0);
  expect(repeated.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    role: "reviewer",
    model: "gpt-6.1",
    previousModel: "gpt-6.1",
  });
  expect(await readRepoState(repo)).toEqual(before);
  expect((await stat(stateFile)).mtimeMs).toBe(mtimeBefore);
  expect(before.roles.reviewer.sessionId).toBe("sess-1");
});

// Usefulness: verifies a CLI switch on a run that is not active is refused, so no change reaches a
// run whose turn can still run on the old CLI.
test("set-model refuses a CLI switch on a run that is not active", async () => {
  for (const lifecycle of ["dispatched", "interrupted"]) {
    const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
    const state = await readRepoState(repo);
    state.lifecycle = lifecycle;
    await writeState(statePaths({ cwd: repo }).stateFile, state);

    const refused = await setModel(repo, "--reviewer", "fake1", "--reviewer-model", "gpt-6.1-sol");
    expect(refused.exitCode, lifecycle).toBe(1);
    expect(refused.payload.error, lifecycle).toContain(lifecycle);
    expect((await readRepoState(repo)).roles.reviewer.kind, lifecycle).toBe("fake2");
  }

  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  const ended = await setModel(repo, "--reviewer", "fake1", "--reviewer-model", "gpt-6.1-sol");
  expect(ended.payload.error).toBe("Run is already aborted.");
});

// Usefulness: verifies a CLI switch needs a latest reviewer turn that is a provider-safety refusal,
// with or without a turn, so the exception cannot move an ordinary conversation to another CLI.
test("set-model refuses a CLI switch without a latest provider-safety refusal", async () => {
  for (const withOkTurn of [false, true]) {
    const { repo, agents } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"] });
    if (withOkTurn) {
      expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
    }
    const before = await readRepoState(repo);

    const refused = await setModel(repo, "--reviewer", "fake1", "--reviewer-model", "gpt-6.1-sol");
    expect(refused.exitCode, String(withOkTurn)).toBe(1);
    if (!withOkTurn) {
      expect(refused.payload.error).toContain("provider-safety");
    }
    expect(await readRepoState(repo), String(withOkTurn)).toEqual(before);
  }
});

// Usefulness: verifies an unknown or unsupported reviewer CLI is refused, so a CLI switch cannot
// leave the run with a kind that no adapter can run.
test("set-model refuses an unknown or unsupported reviewer CLI", async () => {
  const { repo } = await startSafetyRefusedReviewerRun();
  const before = await readRepoState(repo);

  for (const kind of ["nope", "fake9", "constructor"]) {
    const refused = await setModel(repo, "--reviewer", kind, "--reviewer-model", "gpt-6.1-sol");
    expect(refused.exitCode, kind).toBe(1);
    expect(refused.payload.error, kind).toContain("Unsupported reviewer CLI");
    expect(await readRepoState(repo), kind).toEqual(before);
  }
});

// Usefulness: verifies a CLI switch validates the model and effort against the new CLI, so an
// invalid pair is refused before any state changes.
test("set-model refuses a CLI change with an invalid model or effort for the new CLI", async () => {
  const { repo } = await startSafetyRefusedReviewerRun();
  const before = await readRepoState(repo);

  const refused = await setModel(
    repo,
    "--reviewer",
    "opencode",
    "--reviewer-model",
    "p/m#low",
    "--reviewer-effort",
    "high",
  );
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("already contains a variant");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a CLI switch after a provider-safety refusal starts the new CLI in a new
// session with the init task, and keeps the worker session, the step count, and the turn history.
test("set-model switches the reviewer CLI and the next dispatch starts a new session with the init task", async () => {
  const newCliCalls = [];
  const newReviewer = {
    async run(state, prompt) {
      newCliCalls.push({ kind: state.kind, incomingSessionId: state.sessionId, prompt });
      state.sessionId = "sess-new-cli";
      return REPORT + "\nVerdict: accept";
    },
  };
  let oldCalls = 0;
  const oldReviewer = recordingAdapter([]);
  oldReviewer.run = async (state) => {
    oldCalls += 1;
    if (state.sessionId === null) state.sessionId = "sess-old-cli";
    if (oldCalls === 1) throw providerSafetyRefusal();
    return REPORT + "\nVerdict: accept";
  };
  const agents = {
    fake1: recordingAdapter([]),
    fake2: oldReviewer,
    fake3: newReviewer,
  };
  const { repo } = await startRun({ initFlags: ["--reviewer-model", "gpt-6.1"], agents });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  const before = await readRepoState(repo);
  expect(before.roles.reviewer).toMatchObject({ kind: "fake2", sessionId: "sess-old-cli" });

  const changed = await setModelOn(
    repo,
    agents,
    "--reviewer",
    "fake3",
    "--reviewer-model",
    "gpt-6.1-sol",
    "--reviewer-effort",
    "high",
  );
  expect(changed.exitCode).toBe(0);
  expect(changed.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    role: "reviewer",
    model: "gpt-6.1-sol",
    previousModel: "gpt-6.1",
    kind: "fake3",
    previousKind: "fake2",
  });

  const after = await readRepoState(repo);
  expect(after.roles.reviewer).toMatchObject({
    kind: "fake3",
    model: "gpt-6.1-sol",
    effort: "high",
    sessionId: null,
  });
  expect(after.cliChanges).toEqual([
    { role: "reviewer", from: "fake2", to: "fake3", at: expect.any(String) },
  ]);
  expect(after.modelChanges).toEqual([
    { role: "reviewer", from: "gpt-6.1", to: "gpt-6.1-sol", at: expect.any(String) },
  ]);
  expect(after.roles.worker).toEqual(before.roles.worker);
  expect(after.stepsUsed).toBe(before.stepsUsed);
  expect(after.turns).toEqual(before.turns);

  expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  expect(newCliCalls).toHaveLength(1);
  expect(newCliCalls[0]).toMatchObject({ kind: "fake3", incomingSessionId: null });
  expect(newCliCalls[0].prompt).toContain("Init task:\nFix the flaky test.");
  expect(oldCalls).toBe(1);
});

// Usefulness: verifies a CLI switch cannot drop a stored Codex reviewer sandbox on a CLI that does
// not support it, and names the option in the refusal.
test("set-model refuses a CLI switch that would drop a stored reviewer sandbox", async () => {
  const reviewer = {
    async run() {
      throw providerSafetyRefusal();
    },
  };
  const agents = { fake1: recordingAdapter([]), codex: reviewer };
  const { repo } = await startRun({
    initFlags: [
      "--reviewer",
      "codex",
      "--reviewer-model",
      "gpt-6.1",
      "--reviewer-sandbox",
      "read-only",
    ],
    agents,
  });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  const before = await readRepoState(repo);
  expect(before.roles.reviewer).toMatchObject({ kind: "codex" });
  expect(before.reviewerSandbox).toBe("read-only");

  const refused = await setModelOn(
    repo,
    agents,
    "--reviewer",
    "opencode",
    "--reviewer-model",
    "p/m",
    "--reviewer-effort",
    "high",
  );
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("--reviewer-sandbox");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies the CLI-switch path applies init's model rule, so a Copilot model that init
// accepts is not refused by a stricter pattern check (ADR 0049).
test("set-model accepts a Copilot model that init accepts", async () => {
  const { repo } = await startSafetyRefusedReviewerRun();

  const changed = await setModel(
    repo,
    "--reviewer",
    "copilot",
    "--reviewer-model",
    "mai-code-1.1-flash",
  );
  expect(changed.exitCode).toBe(0);
  const after = await readRepoState(repo);
  expect(after.roles.reviewer).toMatchObject({
    kind: "copilot",
    model: "mai-code-1.1-flash",
    sessionId: null,
  });
  expect(after.cliChanges).toEqual([
    { role: "reviewer", from: "fake2", to: "copilot", at: expect.any(String) },
  ]);
});

// Usefulness: verifies a --reviewer value that names the current CLI follows the model-only path,
// so naming the current model writes no cliChanges and no state.
test("set-model treats the current CLI as the model-only path without a state write", async () => {
  const { repo } = await startSafetyRefusedReviewerRun();
  const { stateFile } = statePaths({ cwd: repo });
  const before = await readRepoState(repo);
  const mtimeBefore = (await stat(stateFile)).mtimeMs;

  const repeated = await setModel(repo, "--reviewer", "fake2", "--reviewer-model", "gpt-6.1");
  expect(repeated.exitCode).toBe(0);
  expect(repeated.payload).toEqual({
    status: "ok",
    lifecycle: "active",
    role: "reviewer",
    model: "gpt-6.1",
    previousModel: "gpt-6.1",
  });
  expect(await readRepoState(repo)).toEqual(before);
  expect((await stat(stateFile)).mtimeMs).toBe(mtimeBefore);
  expect(before.cliChanges).toBeUndefined();
});

// Usefulness: verifies a default Codex run (sandbox none) can still switch CLI and the stored
// sandbox option is cleared, so the next dispatch of the new CLI carries no unsupported option.
test("set-model clears a none reviewer sandbox on a CLI switch", async () => {
  const reviewer = {
    async run() {
      throw providerSafetyRefusal();
    },
  };
  const agents = { fake1: recordingAdapter([]), codex: reviewer, fake3: recordingAdapter([]) };
  const { repo } = await startRun({
    initFlags: ["--reviewer", "codex", "--reviewer-model", "gpt-6.1"],
    agents,
  });
  expect((await reviewerTurn(repo, agents)).exitCode).toBe(1);
  expect((await readRepoState(repo)).reviewerSandbox).toBe("none");

  const changed = await setModelOn(
    repo,
    agents,
    "--reviewer",
    "fake3",
    "--reviewer-model",
    "m",
    "--reviewer-effort",
    "high",
  );
  expect(changed.exitCode).toBe(0);
  const after = await readRepoState(repo);
  expect(after.roles.reviewer.kind).toBe("fake3");
  expect(after.reviewerSandbox).toBeUndefined();
  expect(after.cliChanges).toEqual([
    { role: "reviewer", from: "codex", to: "fake3", at: expect.any(String) },
  ]);
});
