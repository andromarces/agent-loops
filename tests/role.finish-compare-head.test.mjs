import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on, so no test here
// starts a `git` process.
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

import { executeRoleCommand, parseRoleArgs } from "../src/role/index.mjs";
import {
  ACCEPT,
  basicDeps,
  cleanup,
  dispatchArgv,
  dispatchReviewer,
  finishCall,
  GATE_SUMMARY,
  initPrRun,
  initWorkerRun,
  readRepoState,
  repos,
  REVIEW_ONLY_OVERRIDES,
  setup,
  UNRESOLVED_SUMMARY,
  withRepo,
} from "./role-helpers.mjs";
import { equalsArgs, prViewArgs } from "./gh-doubles.mjs";
import { CLEAN_REPO_HEAD, cleanRepoGit } from "./git-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  gitDouble.answer = null;
});

// A directory with a `.git` entry stands in for a repo, and `git` is answered
// from memory until the test ends. `answer` replaces `cleanRepoGit` where the
// test needs another repo state.
async function useCleanRepo(answer = cleanRepoGit) {
  const repo = await mkdtemp(join(tmpdir(), "role-test-clean-repo-"));
  await mkdir(join(repo, ".git"));
  repos.push(repo);
  gitDouble.answer = answer;
  return repo;
}

// A clean repo whose work tree status is `status`, in the `--porcelain=v1 -z` format.
function gitWithStatus(status) {
  return (command, args, options) =>
    args[0] === "status"
      ? { exitCode: 0, stdout: status, stderr: "" }
      : cleanRepoGit(command, args, options);
}

describe("finish --compare-head", () => {
  // A `gh` that answers only the PR read, and records every call, so a read of any
  // required-check source fails the test by name.
  const headGh =
    (head, calls, state = "OPEN") =>
    async (args) => {
      calls.push(args.join(" "));
      if (equalsArgs(args, prViewArgs(42))) {
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: head,
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
            potentialMergeCommit: null,
            state,
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected read: ${JSON.stringify(args)}` };
    };

  // Usefulness: verifies requirement "a matching clean head records a verified compare that differs
  // from unresolvedCompare" (#1098). It also verifies that the compare reads the PR head and no
  // required-check source, so it works where those sources are unreadable.
  test("a matching clean head records headCompare verified after one PR read", async () => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);
    await dispatchReviewer(repo, ACCEPT);

    const calls = [];
    const result = await finishCall(repo, ["--compare-head", "42"], {
      gh: headGh(CLEAN_REPO_HEAD, calls),
    });
    expect(result.exitCode).toBe(0);
    expect(result.payload).toEqual({
      status: "ok",
      lifecycle: "finished",
      headCompare: "verified",
    });
    expect(calls).toEqual([prViewArgs(42).join(" ")]);
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("finished");
    expect(state.headCompare).toBe("verified");
    expect(state).not.toHaveProperty("unresolvedCompare");
  });

  // Usefulness: verifies requirement "a PR head that differs from reviewed.head refuses the
  // finish" (#1098): the run stays active so a reviewer turn can retry.
  test("a PR head that differs from the reviewed head refuses and keeps the run active", async () => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);
    await dispatchReviewer(repo, ACCEPT);

    const result = await finishCall(repo, ["--compare-head", "42"], {
      gh: headGh("f".repeat(40), []),
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("the PR head differs from the reviewed commit");
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("active");
    expect(state).not.toHaveProperty("headCompare");
  });

  // Usefulness: verifies a closed PR with an unchanged head refuses the compare (#1111). The head
  // alone cannot tell an open PR from one that left the open list.
  test("a closed PR with a matching head refuses and keeps the run active", async () => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);
    await dispatchReviewer(repo, ACCEPT);

    const result = await finishCall(repo, ["--compare-head", "42"], {
      gh: headGh(CLEAN_REPO_HEAD, [], "CLOSED"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("PR 42 is closed, not open");
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies requirement "a reviewed tree that is not clean refuses the finish" (#1098),
  // before any GitHub read.
  test("a reviewed tree that is not clean refuses without a GitHub read", async () => {
    await setup();
    const repo = await useCleanRepo();
    await writeFile(join(repo, "new.txt"), "x");
    gitDouble.answer = gitWithStatus("?? new.txt\0");
    await initWorkerRun(repo);
    await dispatchReviewer(repo, ACCEPT);
    expect((await readRepoState(repo)).lastResult.reviewed.clean).toBe(false);

    const calls = [];
    const result = await finishCall(repo, ["--compare-head", "42"], {
      gh: headGh(CLEAN_REPO_HEAD, calls),
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("the reviewed work tree is not clean");
    expect(calls).toEqual([]);
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies requirement "no reviewer turn means no compare" (#1098): without a
  // reviewed state there is no `reviewed.head` to compare.
  test("a finish with no reviewer turn refuses", async () => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);

    const result = await finishCall(repo, ["--compare-head", "42"], {
      gh: headGh(CLEAN_REPO_HEAD, []),
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("no reviewed state");
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies requirement "refuses together with --require-ci or unresolvedCompare"
  // (#1098), before any GitHub read, so the three finish records stay mutually exclusive.
  test.each([
    ["--require-ci", { extra: ["--require-ci", "42"], summary: GATE_SUMMARY }, "--require-ci"],
    ["unresolvedCompare", { extra: [], summary: UNRESOLVED_SUMMARY }, "unresolvedCompare"],
  ])("refuses together with %s", async (_name, { extra, summary }, word) => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);
    await dispatchReviewer(repo, ACCEPT);

    const calls = [];
    const result = await executeRoleCommand(
      withRepo(["finish", "--cwd", "<repo>", "--compare-head", "42", ...extra], repo),
      { stdin: async () => JSON.stringify(summary), gh: headGh(CLEAN_REPO_HEAD, calls) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("--compare-head cannot be combined with");
    expect(result.payload.error).toContain(word);
    expect(calls).toEqual([]);
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies a run that declared its PR still needs the gate, so the compare is no way
  // around it (#1098, #302).
  test("a run that declares a PR refuses the compare in place of the gate", async () => {
    await setup();
    const repo = await useCleanRepo();
    await initPrRun(repo, 42);
    await dispatchReviewer(repo, ACCEPT);

    const result = await finishCall(repo, ["--compare-head", "42"], {
      gh: headGh(CLEAN_REPO_HEAD, []),
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("--require-ci 42 gate");
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies the flag is finish-only, like the other finish flags, and that review-only
  // (no PR work) refuses it (#1098).
  test("is refused outside finish and in review-only", async () => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);

    const dispatched = await executeRoleCommand(
      withRepo(["dispatch", "--role", "worker", "--cwd", "<repo>", "--compare-head", "42"], repo),
      basicDeps(),
    );
    expect(dispatched.exitCode).toBe(1);
    expect(dispatched.payload.error).toContain("--compare-head is only valid for finish");

    const reviewOnly = await useCleanRepo();
    await executeRoleCommand(
      withRepo(dispatchArgv(REVIEW_ONLY_OVERRIDES, "reviewer"), reviewOnly),
      basicDeps(),
    );
    const refused = await finishCall(reviewOnly, ["--compare-head", "42"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.payload.error).toContain("review-only");
  });

  // Usefulness: verifies the flag value is a positive PR number, as `--require-ci` requires.
  test("rejects a value that is not a PR number", () => {
    expect(() => parseRoleArgs(["finish", "--compare-head", "abc"])).toThrow(
      "--compare-head must be a positive integer",
    );
  });
});
