import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

// Runs the first run, which declares PR 42 after its worker turn, and returns a continuation call.
// The call counts the turns that the continued run makes, so a refusal can show that none ran.
async function declareThenContinue(repo, transcriptPath, errorSpy) {
  doubles.git = git;
  doubles.gh = () => ({ exitCode: 0, stdout: JSON.stringify([MATCH]), stderr: "" });
  await main(
    [...BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
    continueAgents([work, work]),
  );
  expect(process.exitCode).toBe(2);
  doubles.gh = null;
  return async (
    extraArgs,
    replies = [finish, finish],
    { from = transcriptPath, to = from } = {},
  ) => {
    errorSpy.mockClear();
    const agents = continueAgents(replies);
    const turns = [];
    for (const kind of Object.keys(agents)) {
      const run = agents[kind].run;
      agents[kind].run = (...args) => {
        turns.push(kind);
        return run(...args);
      };
    }
    await main(
      [
        ...BASE,
        "--cwd",
        repo,
        "--max-steps",
        "3",
        "--continue-from",
        from,
        "--transcript",
        to,
        ...extraArgs,
      ],
      agents,
    );
    return { turns, error: errorSpy.mock.calls.flat().join("\n") };
  };
}

// Usefulness: verifies a continuation flag that names another PR than the declared one is refused
// before any turn runs, as a changed init field is refused, so no flag replaces the binding.
test.each([
  ["--require-ci", ["--require-ci", "7"]],
  ["--pr", ["--pr", "7"]],
])("--continue-from refuses %s for another PR than the declared one", async (_name, flags) => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const cont = await declareThenContinue(repo, transcriptPath, errorSpy);
    const { turns, error } = await cont(flags);

    expect(process.exitCode).toBe(1);
    expect(error).toContain("PR 42");
    expect(error).toContain("cannot change");
    expect(turns).toEqual([]);
  });
});

// Usefulness: verifies a flag that names the declared PR is accepted, so an operator can add the
// gate for the PR that the earlier run declared.
test("--continue-from accepts --require-ci for the declared PR", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const cont = await declareThenContinue(repo, transcriptPath, errorSpy);
    const abort = JSON.stringify({ action: "abort", reason: "stop" });
    const { turns, error } = await cont(["--require-ci", "42"], [abort]);

    expect(error).not.toContain("cannot change");
    expect(turns).toEqual(["codex"]);
  });
});

// Usefulness: verifies a continuation that restores a declared PR refuses `--mode review-only`
// before any turn runs, because that mode refuses a declared PR at init.
test("--continue-from refuses --mode review-only for a declared PR", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const cont = await declareThenContinue(repo, transcriptPath, errorSpy);
    const reviewer = JSON.stringify({ action: "run_reviewer", prompt: "r" });
    const { turns, error } = await cont(["--mode", "review-only"], [reviewer, finish]);

    expect(process.exitCode).toBe(1);
    expect(error).toContain("review-only");
    expect(error).toContain("PR 42");
    expect(turns).toEqual([]);
  });
});

// Usefulness: verifies a malformed declaration record is refused before any turn runs, so an edited
// transcript cannot drop the declared-PR finish rule while the completion replay stays valid.
test("--continue-from refuses a malformed pr-declared record", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const cont = await declareThenContinue(repo, transcriptPath, errorSpy);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    transcript.events.find((e) => e.type === "pr-declared").pr = "42";
    await writeFile(transcriptPath, JSON.stringify(transcript));
    const { turns, error } = await cont([]);

    expect(process.exitCode).toBe(1);
    expect(error).toContain("pr-declared");
    expect(turns).toEqual([]);
  });
});

// Usefulness: verifies a chain of continuations keeps the declared PR whatever flags a link passes.
// A link with a matching flag writes the declaration into its own transcript, so a later link with
// no flags still refuses a finish that has no gate, with no transcript edit (issue #919).
test.each([
  ["--require-ci", ["--require-ci", "42"]],
  ["--pr", ["--pr", "42"]],
])("a chain of continuations keeps the PR through a link with %s", async (_name, flags) => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const cont = await declareThenContinue(repo, transcriptPath, errorSpy);
    const abort = JSON.stringify({ action: "abort", reason: "stop" });
    const second = join(repo, "second.json");
    const third = join(repo, "third.json");
    await cont(flags, [abort], { from: transcriptPath, to: second });
    const link = JSON.parse(await readFile(second, "utf8"));
    expect(link.events.filter((e) => e.type === "pr-declared").map((e) => e.pr)).toEqual([42]);

    const reviewer = JSON.stringify({ action: "run_reviewer", prompt: "r" });
    const { error } = await cont([], [reviewer, finish, finish], { from: second, to: third });

    expect(process.exitCode).toBe(1);
    expect(error).toContain("this run declares PR 42");
  });
});
