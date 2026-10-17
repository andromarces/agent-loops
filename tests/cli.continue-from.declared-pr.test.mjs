import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vite-plus/test";

// Answers `git` and `gh` from memory, so the first run declares a PR with no network.
const doubles = vi.hoisted(() => ({ git: null, gh: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      if (command === "git" && doubles.git) return doubles.git(command, args, options);
      if (command === "gh" && doubles.gh) return doubles.gh(command, args, options);
      return real.execa(command, args, options);
    },
  };
});

import { main } from "../src/cli.mjs";
import {
  CLEAN_REPO_BRANCH,
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  continueAgents,
  createWithContinueRepo,
  SUMMARY,
} from "./runtime-helpers.mjs";

const withContinueRepo = createWithContinueRepo(doubles);
const BASE = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy", "--task", "t"];
const work = JSON.stringify({ action: "run_worker", prompt: "w" });
const finish = JSON.stringify({ action: "finish", summary: SUMMARY });
const MATCH = {
  number: 42,
  headRefName: CLEAN_REPO_BRANCH,
  headRefOid: CLEAN_REPO_HEAD,
  isCrossRepository: false,
  url: "https://github.com/owner/repo/pull/42",
};

// `cleanRepoGit` plus the PR resolver reads: no branch remote setting, and an `origin` remote.
function git(command, args, options) {
  switch (JSON.stringify(args)) {
    case `["config","--get","branch.${CLEAN_REPO_BRANCH}.remote"]`:
      return { exitCode: 1, stdout: "", stderr: "" };
    case '["remote","get-url","origin"]':
      return { exitCode: 0, stdout: "https://github.com/owner/repo.git", stderr: "" };
    default:
      return cleanRepoGit(command, args, options);
  }
}

// Usefulness: verifies --continue-from keeps the PR that the runtime declared late in the earlier
// run. The continued run refuses a finish that has no --require-ci gate for that PR, and it never
// ends through the unresolvedCompare path (issue #919).
test("--continue-from keeps a PR that the earlier run declared after a worker turn", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    doubles.git = git;
    doubles.gh = () => ({ exitCode: 0, stdout: JSON.stringify([MATCH]), stderr: "" });
    await main(
      [...BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      continueAgents([work, work]),
    );
    expect(process.exitCode).toBe(2);
    const first = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(first.events.filter((e) => e.type === "pr-declared").map((e) => e.pr)).toEqual([42]);

    doubles.gh = null;
    errorSpy.mockClear();
    await main(
      [
        ...BASE,
        "--cwd",
        repo,
        "--max-steps",
        "3",
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      continueAgents([finish, finish]),
    );

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("this run declares PR 42");
    const second = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(second.events.at(-1).type).toBe("gate");
  });
});
