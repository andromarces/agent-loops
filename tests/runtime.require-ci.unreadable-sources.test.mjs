import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory (see `cleanRepoGit` in runtime-helpers.mjs).
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { runLoop } from "../src/runtime.mjs";
import {
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createCleanRepoDir,
  removePath,
  scripted,
} from "./runtime-helpers.mjs";
import {
  freePlanGh,
  gateRoles,
  prGateGh,
  REVIEW_ACCEPT,
  SUMMARY,
  unreachableGh,
} from "./gh-doubles.mjs";

const REVIEW_THEN_FINISH = [
  JSON.stringify({ action: "run_reviewer", prompt: "review" }),
  JSON.stringify({ action: "finish", summary: SUMMARY }),
];

/** Runs a headless run that declares PR 42, and returns the result, the orchestrator, and the events. */
async function runDeclared(gh, orchReplies = REVIEW_THEN_FINISH) {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  const orch = scripted(orchReplies);
  try {
    const events = [];
    const settled = await runLoop({
      task: "PR work: address issue 1092 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The init copy of local files is out of scope, and its `git` calls have no answer in the double.
      copyLocalFiles: false,
      gh,
      roles: gateRoles(),
      agents: { orch, work: scripted([]), rev: scripted([REVIEW_ACCEPT]) },
      onEvent: (event) => events.push(event),
    });
    return { settled, orch, events };
  } catch (error) {
    return { error, orch };
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
}

// Usefulness: verifies acceptance of #1092 on the headless path — a declared run whose required-check
// sources all answer the Free-plan 403 is refused before the first child turn, because the gate
// would refuse every finish of it.
test("a headless --pr run on a repository with unreadable required-check sources is refused before any turn", async () => {
  const calls = [];
  const { error, orch } = await runDeclared(freePlanGh(CLEAN_REPO_HEAD, calls));
  expect(error?.message).toContain("--pr 42 is refused");
  expect(error.message).toContain("repository rulesets");
  expect(error.message).toContain("omit --pr");
  expect(orch.recorded).toHaveLength(0);
});

// Usefulness: verifies a declared run on a readable repository is unchanged, so the refusal does
// not reach a run whose gate can judge the checks.
test("a headless --pr run with a readable required-check source starts and finishes", async () => {
  const { settled, error } = await runDeclared(prGateGh(CLEAN_REPO_HEAD));
  expect(error).toBeUndefined();
  expect(settled.exitCode).toBe(0);
});

// Usefulness: verifies a continuation that restored its PR makes no start read and its orchestrator
// prompt does not claim one, so the prompt states only what the runtime did.
test("a continued run that restored its PR reads nothing at start and its prompt claims no read", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  const orch = scripted([JSON.stringify({ action: "abort", reason: "stop" })]);
  const calls = [];
  try {
    await runLoop({
      task: "PR work: address issue 1092 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      continued: true,
      earlierPr: 42,
      copyLocalFiles: false,
      gh: prGateGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: { orch, work: scripted([]), rev: scripted([]) },
    });
    expect(calls).toEqual([]);
    expect(orch.recorded[0].prompt).toContain("This run declares PR #42");
    expect(orch.recorded[0].prompt).not.toContain("At start, the runtime read");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a read that fails for another reason than an unreadable source warns and
// lets the run start, so a network outage at init does not block a run the gate may still judge.
test("a headless --pr run does not refuse when the read fails for another reason", async () => {
  const { error, orch } = await runDeclared(unreachableGh(), [
    JSON.stringify({ action: "abort", reason: "stop" }),
  ]);
  expect(error).toBeUndefined();
  expect(orch.recorded.length).toBeGreaterThan(0);
});

// Usefulness: verifies acceptance of #1124 on the headless path — a cancel during the start read of
// a `--pr` run ends the hung read and rejects as a cancel, before any child turn and before the
// 60 s read deadline, instead of waiting it out and starting the run.
test("a cancel during the start read of a headless --pr run rejects as a cancel before any turn", async () => {
  const controller = new AbortController();
  const hungGh = (args, cwd, { signal } = {}) =>
    new Promise((resolve) => {
      const settle = () => resolve({ status: 1, stdout: "", stderr: "gh was canceled" });
      if (signal?.aborted) return settle();
      signal?.addEventListener("abort", settle, { once: true });
      controller.abort();
    });
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  const orch = scripted([JSON.stringify({ action: "abort", reason: "stop" })]);
  const begun = Date.now();
  try {
    await expect(
      runLoop({
        task: "PR work: address issue 1124 through PR 42.",
        cwd: repo,
        maxSteps: 5,
        pr: 42,
        requireCi: 42,
        copyLocalFiles: false,
        gh: hungGh,
        signal: controller.signal,
        roles: gateRoles(),
        agents: { orch, work: scripted([]), rev: scripted([]) },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(orch.recorded).toHaveLength(0);
    expect(Date.now() - begun).toBeLessThan(5_000);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
