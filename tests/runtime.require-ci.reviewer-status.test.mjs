import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `cleanRepoGit` in git-helpers.mjs); every other test reaches the real `execa`.
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
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import {
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createCleanRepoDir,
  createTempRepo,
} from "./git-helpers.mjs";
import { equalsArgs, gateReads, pagedApiArgs, PASSING_RUN, prGateGh } from "./gh-doubles.mjs";
import { gateRoles, REVIEW_ACCEPT, SUMMARY } from "./run-fixtures.mjs";

// Answers the runtime read of the required checks for PR 42 and the finish gate
// from the shared gate fixture, with `runs` as the check runs of every commit.
const reviewerReadGh = (headRefOid, runs) => prGateGh(headRefOid, [], runs);

// Usefulness: verifies a run that declares a PR supplies the required-check
// status the runtime read to the reviewer turn and records that read in the
// result, so a reviewer whose turn cannot reach the network still sees the
// failing check and the parent can compare it with the reviewer Checks line
// (issue #320).
test("a declared PR supplies the runtime-read required-check status to the reviewer", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The check fails for the status read before the turn and passes for the finish
      // gate after it, so the run can finish while the reviewer holds the failure.
      gh: (args, cwd, options) =>
        reviewerReadGh(head, [
          rev.recorded.length === 0 ? { ...PASSING_RUN, conclusion: "failure" } : PASSING_RUN,
        ])(args, cwd, options),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worker pushed the change"]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(rev.recorded[0].prompt).toContain("ci (ubuntu-latest)");
    expect(rev.recorded[0].prompt).toContain("42");
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.prChecks).toMatchObject({ pr: 42, status: "failing" });
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a headless run that takes only `--require-ci <pr>` supplies
// the status for that PR to the reviewer, because a sandboxed reviewer cannot make
// the read itself and the PR number is already a run input (issue #350).
test("a gate-only run supplies the required-check status for the gated PR", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "Review the change on PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: (args, cwd, options) =>
        reviewerReadGh(head, [
          rev.recorded.length === 0 ? { ...PASSING_RUN, conclusion: "failure" } : PASSING_RUN,
        ])(args, cwd, options),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(rev.recorded[0].prompt).toContain("ci (ubuntu-latest)");
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.prChecks).toMatchObject({ pr: 42, status: "failing" });
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the supplied status is not a pass for a reviewed work tree
// that is not clean, because `--require-ci` refuses that tree, so the runtime must
// hand the status read the clean flag of the reviewed snapshot (issue #349).
test("a declared PR supplies no pass for a reviewed work tree that is not clean", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    await writeFile(join(repo, "uncommitted.txt"), "x");
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    await runLoop({
      task: "PR work: address issue 349 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: reviewerReadGh(head, [PASSING_RUN]),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.reviewed.clean).toBe(false);
    expect(reviewed.result.prChecks.status).not.toBe("pass");
    expect(events.filter((e) => e.type === "refusal").map((e) => e.reason)).toContain(
      "the reviewed work tree is not clean",
    );
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a run that declares no PR reads no status and records
// none, so the reviewer prompt never carries a read the runtime did not make
// (issue #320).
test("a run with no PR input reads no required-check status", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "Task without a pull request.",
      cwd: repo,
      maxSteps: 5,
      gh: async (args) => {
        calls.push(args.join(" "));
        return { status: 0, stdout: "[]", stderr: "" };
      },
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(rev.recorded[0].prompt).not.toMatch(/runtime read/);
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.prChecks).toBeUndefined();
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a hung required-check read does not fail or halt the
// dispatch, because the status is supplied evidence and the reviewer keeps its
// own read, so a stalled `gh` must yield an unresolved status and a completed
// reviewer turn (issue #320 review).
test("a hung required-check read yields an unresolved status and a completed turn", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      timeout: 30,
      readTimeoutMs: 25,
      gh: (args, cwd, options) => {
        // Only the ruleset read stalls: the head resolves, so the read reaches the
        // call a hung `gh` would hold open.
        if (
          rev.recorded.length === 0 &&
          equalsArgs(args, pagedApiArgs("repos/owner/repo/rules/branches/main"))
        ) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("read timed out")));
          });
        }
        return prGateGh(head)(args, cwd, options);
      },
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    // The reviewer turn completed and the run finished: a stalled read neither
    // failed the turn nor ended the run.
    expect(result.exitCode).toBe(0);
    expect(rev.recorded).toHaveLength(1);
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result).toMatchObject({ status: "ok" });
    expect(reviewed.result.prChecks).toMatchObject({ status: "unresolved" });
    // The unresolved status reaches the reviewer prompt, so the reviewer reads
    // the checks itself rather than reporting a pass it did not see.
    expect(rev.recorded[0].prompt).toMatch(/unresolved/i);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the gate-endpoint list the refusal assertions use covers
// every endpoint the finish gate actually reads, because a list that omits one
// lets a refused finish pass a GitHub read it should never make while the test
// still reports no reads (issue #320 review, second round).
test("the refusal assertion covers every endpoint the finish gate reads", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    // A run whose gate matches, so the gate runs and every endpoint it reads is
    // recorded. That recorded list is what a refused finish must not contain.
    const calls = [];
    await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(head, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    // Every call the run made is covered by the list the refusal tests assert on,
    // so a refused finish cannot slip a gate read past them.
    const uncovered = calls.filter((key) => gateReads([key]).length === 0);
    expect(uncovered).toEqual([]);
    // The gate really does read several endpoints, so the list is not vacuous.
    expect(gateReads(calls).length).toBeGreaterThan(1);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
