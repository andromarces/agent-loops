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
  CLEAN_REPO_BRANCH,
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createCleanRepoDir,
  equalsArgs,
  gateRoles,
  prGateGh,
  removePath,
  REVIEW_ACCEPT,
  scripted,
  SUMMARY,
} from "./runtime-helpers.mjs";

const OTHER_HEAD = "2".repeat(40);
const MATCH = {
  number: 42,
  headRefName: CLEAN_REPO_BRANCH,
  headRefOid: CLEAN_REPO_HEAD,
  isCrossRepository: false,
};

// `gh pr list` for the run branch answers `listReply`; every other read is the shared gate fixture
// for PR 42. `listReply` is a list of PRs, or a function that throws or returns a gh result.
function declareGh(listReply, calls = []) {
  const gate = prGateGh(CLEAN_REPO_HEAD, calls);
  return async (args, cwd, options) => {
    if (equalsArgs(args.slice(0, 5), ["pr", "list", "--head", CLEAN_REPO_BRANCH, "--state"])) {
      calls.push("pr list");
      if (typeof listReply === "function") return listReply();
      return { status: 0, stdout: JSON.stringify(listReply), stderr: "" };
    }
    return gate(args, cwd, options);
  };
}

async function runWorkerPrRun({ gh, orchReplies, extra = {} }) {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const rev = scripted([REVIEW_ACCEPT, REVIEW_ACCEPT]);
    const orch = scripted(orchReplies);
    const events = [];
    const result = await runLoop({
      task: "PR work: address issue 919 through a PR that the worker opens.",
      cwd: repo,
      maxSteps: 6,
      gh,
      roles: gateRoles(),
      agents: { orch, work: scripted(["worker opened the PR", "worker again"]), rev },
      onEvent: (event) => events.push(event),
      ...extra,
    });
    return { result, events, rev, orch };
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
}

const work = JSON.stringify({ action: "run_worker", prompt: "work" });
const review = JSON.stringify({ action: "run_reviewer", prompt: "review" });
const finish = (extra = {}) => JSON.stringify({ action: "finish", summary: SUMMARY, ...extra });

// Usefulness: verifies issue #919 option 1 end to end. A headless run whose worker opened the PR
// declares it from Git and GitHub state, supplies its check status to the next reviewer prompt,
// and refuses a finish that has no --require-ci gate for it, including one with unresolvedCompare.
test("a headless run declares the PR its worker opened, supplies its status, and gates the finish", async () => {
  const { result, events, rev, orch } = await runWorkerPrRun({
    gh: declareGh([MATCH]),
    orchReplies: [work, review, finish({ unresolvedCompare: true }), finish()],
  });

  expect(events.filter((e) => e.type === "pr-declared")).toEqual([
    { type: "pr-declared", pr: 42, stepsUsed: 1 },
  ]);
  expect(orch.recorded[1].prompt).toContain('"declaredPr": 42');
  const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
  expect(reviewed.result.prChecks).toMatchObject({ pr: 42 });
  expect(rev.recorded[0].prompt).toContain("This run read the required checks for PR 42");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("this run declares PR 42");
  expect(result.reason).toContain("this run carries no --require-ci gate");
  expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
});

// Usefulness: verifies the runtime declares at most one PR per run, so a later worker turn that
// opens or moves another PR cannot change the declared one.
test("a declared PR is read once and never changes", async () => {
  const calls = [];
  const { events } = await runWorkerPrRun({
    gh: declareGh([MATCH], calls),
    orchReplies: [work, work, review, finish(), finish()],
  });

  expect(calls.filter((c) => c === "pr list")).toHaveLength(1);
  expect(events.filter((e) => e.type === "pr-declared")).toHaveLength(1);
});

// Usefulness: verifies a run with --pr or --require-ci at start is unchanged: no PR read is made,
// so the operator-supplied PR stays the only PR input.
test.each([
  ["--pr", { pr: 7, requireCi: 7 }],
  ["--require-ci", { requireCi: 7 }],
])("a run with %s at start never resolves a PR", async (_name, extra) => {
  const calls = [];
  const { events } = await runWorkerPrRun({
    gh: declareGh([MATCH], calls),
    orchReplies: [work, finish(), finish()],
    extra,
  });

  expect(calls).not.toContain("pr list");
  expect(events.some((e) => e.type === "pr-declared")).toBe(false);
});

// Usefulness: verifies every ambiguous or unreadable GitHub state leaves the run undeclared, so
// the marker rule and the reviewer's own check read stay in force and no wrong PR gates the run.
test.each([
  ["no open PR", () => []],
  ["several PRs", () => [MATCH, { ...MATCH, number: 43 }]],
  ["a PR head that differs from the work tree head", () => [{ ...MATCH, headRefOid: OTHER_HEAD }]],
  ["a PR from a fork", () => [{ ...MATCH, isCrossRepository: true }]],
  ["a PR for another branch", () => [{ ...MATCH, headRefName: "other" }]],
  ["a failed gh read", () => ({ status: 1, stdout: "", stderr: "gh: not logged in" })],
  ["an unparseable reply", () => ({ status: 0, stdout: "not json", stderr: "" })],
  [
    "a thrown gh error",
    () => {
      throw new Error("spawn gh ENOENT");
    },
  ],
])("%s leaves the run undeclared", async (_name, reply) => {
  const { result, events, rev } = await runWorkerPrRun({
    gh: declareGh(() => {
      const value = reply();
      return Array.isArray(value)
        ? { status: 0, stdout: JSON.stringify(value), stderr: "" }
        : value;
    }),
    orchReplies: [work, review, finish({ unresolvedCompare: true })],
  });

  expect(events.some((e) => e.type === "pr-declared")).toBe(false);
  expect(rev.recorded[0].prompt).not.toMatch(/runtime read/);
  expect(result.exitCode).toBe(0);
  expect(result.unresolvedCompare).toBe(true);
});
