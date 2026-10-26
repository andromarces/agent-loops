import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see `cleanRepoGit` in runtime-helpers.mjs).
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

import { snapshot } from "../src/lib/snapshot.mjs";
import { runLoop } from "../src/runtime.mjs";
import {
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createCleanRepoDir,
  createTempRepo,
  freePlanGh,
  gateRoles,
  removePath,
  REVIEW_ACCEPT,
  scripted,
  SUMMARY,
} from "./runtime-helpers.mjs";

const OTHER_HEAD = "2".repeat(40);

// The reads of a required-check source: a compare must make none of them.
const REQUIRED_CHECK_READS = ["repo view", "rules/branches", "protection", "check-runs", "/status"];

const REVIEW_THEN_FINISH = [
  JSON.stringify({ action: "run_reviewer", prompt: "review" }),
  JSON.stringify({ action: "finish", summary: SUMMARY }),
];

/** Runs a headless `--compare-head 42` run on a clean repository, and returns the result and the events. */
async function runCompare(gh, { orchReplies = REVIEW_THEN_FINISH, maxSteps = 5, ...extra } = {}) {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  const orch = scripted(orchReplies);
  const events = [];
  try {
    const result = await runLoop({
      task: "Update PR 42 on a repository whose required-check sources are unreadable.",
      cwd: repo,
      maxSteps,
      compareHead: 42,
      copyLocalFiles: false,
      gh,
      roles: gateRoles(),
      agents: { orch, work: scripted([]), rev: scripted([REVIEW_ACCEPT]) },
      onEvent: (event) => events.push(event),
      ...extra,
    });
    return { result, orch, events };
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
}

// Usefulness: verifies acceptance of #1104 — on a repository whose required-check sources are
// unreadable, a finish whose PR head equals the reviewed head records a verified compare, exits 0, and
// leaves no unresolved-compare event, so a matched head differs from an unreadable one. It reads no
// required-check source.
test("a headless compare-head run finishes with a verified compare on a matching clean head", async () => {
  const calls = [];
  const { result, events } = await runCompare(freePlanGh(CLEAN_REPO_HEAD, calls));
  expect(result.exitCode).toBe(0);
  expect(result.headCompare).toBe("verified");
  expect(result.unresolvedCompare).toBe(false);
  expect(events.filter((e) => e.type === "head-compare")).toMatchObject([{ pr: 42 }]);
  expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  for (const read of REQUIRED_CHECK_READS) {
    expect(calls.filter((call) => call.includes(read))).toEqual([]);
  }
});

// Usefulness: verifies a PR head that differs from the reviewed head refuses the finish, so a
// moved PR is never recorded as a verified compare.
test("a headless compare-head run refuses a finish when the PR head differs from the reviewed head", async () => {
  const { result, events } = await runCompare(freePlanGh(OTHER_HEAD), { maxSteps: 1 });
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("the PR head differs from the reviewed commit");
  expect(result.headCompare).toBeUndefined();
  expect(events.some((e) => e.type === "head-compare")).toBe(false);
});

// Usefulness: verifies a reviewed work tree that is not clean refuses the finish, because the
// compare speaks for the committed head only.
test("a headless compare-head run refuses a finish when the reviewed tree is not clean", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    await writeFile(join(repo, "uncommitted.txt"), "x");
    const events = [];
    const result = await runLoop({
      task: "Update PR 42.",
      cwd: repo,
      maxSteps: 1,
      compareHead: 42,
      gh: freePlanGh(head),
      roles: gateRoles(),
      agents: {
        orch: scripted(REVIEW_THEN_FINISH),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the reviewed work tree is not clean");
    expect(events.some((e) => e.type === "head-compare")).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a finish with no reviewer turn is refused, because the compare reads the
// reviewed head that only a reviewer turn establishes.
test("a headless compare-head run refuses a finish before any reviewer turn", async () => {
  const { result } = await runCompare(freePlanGh(CLEAN_REPO_HEAD), {
    orchReplies: Array(2).fill(JSON.stringify({ action: "finish", summary: SUMMARY })),
    maxSteps: 1,
  });
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
});

// Usefulness: verifies the marker is refused beside the compare, so one head never records two outcomes.
test("a headless compare-head run refuses a finish that also sets unresolvedCompare before any GitHub read", async () => {
  const calls = [];
  const { result, events } = await runCompare(freePlanGh(CLEAN_REPO_HEAD, calls), {
    orchReplies: [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY, unresolvedCompare: true }),
      JSON.stringify({ action: "finish", summary: SUMMARY, unresolvedCompare: true }),
    ],
  });
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("--compare-head cannot be combined with unresolvedCompare");
  expect(calls).toEqual([]);
  expect(events.some((e) => e.type === "head-compare")).toBe(false);
});

// Usefulness: verifies the runtime refuses the compare beside a PR input before any child turn, as
// the command line does, so a caller that skips the parser cannot record two outcomes for one PR.
test("a headless compare-head run is refused beside a PR input before any turn", async () => {
  for (const input of [{ pr: 42 }, { requireCi: 42 }]) {
    await expect(runCompare(freePlanGh(CLEAN_REPO_HEAD), input)).rejects.toThrow(
      "--compare-head cannot be combined with --pr or --require-ci",
    );
  }
});

// Usefulness: verifies the orchestrator prompt states the compare and its limit, so the
// orchestrator neither compares the head itself nor claims a check result from it.
test("the orchestrator prompt of a compare-head run names the compare and refuses the marker", async () => {
  const { orch } = await runCompare(freePlanGh(CLEAN_REPO_HEAD));
  const prompt = orch.recorded[0].prompt;
  expect(prompt).toContain("--compare-head 42");
  expect(prompt).toContain("reads no required-check source");
  expect(prompt).toContain('"unresolvedCompare": true is refused');
});

// Usefulness: verifies a continuation of a run that declared its PR refuses the compare, because
// that run ends through its --require-ci gate.
test("a headless compare-head run refuses a continuation of a declared PR", async () => {
  await expect(
    runCompare(freePlanGh(CLEAN_REPO_HEAD), { continued: true, earlierPr: 42 }),
  ).rejects.toThrow("--compare-head cannot be combined with a continuation of PR 42");
});
