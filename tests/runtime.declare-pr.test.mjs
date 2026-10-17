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
  url: "https://github.com/owner/repo/pull/42",
};

// The state the `git` double reports. A test changes it to move the head during the GitHub read or
// to point the run remote at another repository.
const gitState = {
  head: CLEAN_REPO_HEAD,
  branch: CLEAN_REPO_BRANCH,
  remoteUrl: "https://github.com/owner/repo.git",
  // The head that the first head read of the resolver reports, when the test sets one.
  preReadHead: null,
  resolverReads: 0,
};

// `cleanRepoGit` plus the reads of the PR resolver: the head, which `gitState` can move, the branch
// remote setting, which the run does not set, and the URL of the `origin` remote.
function declareGit(command, args, options) {
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
  switch (JSON.stringify(args)) {
    case '["rev-parse","--verify","-q","HEAD"]':
      return ok(
        gitState.resolverReads === 1 && gitState.preReadHead ? gitState.preReadHead : gitState.head,
      );
    case '["symbolic-ref","--short","-q","HEAD"]':
      gitState.resolverReads += 1;
      return ok(gitState.branch);
    case `["config","--get","branch.${CLEAN_REPO_BRANCH}.remote"]`:
      return { exitCode: 1, stdout: "", stderr: "" };
    case '["remote","get-url","origin"]':
      return ok(gitState.remoteUrl);
    default:
      return cleanRepoGit(command, args, options);
  }
}

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

async function runWorkerPrRun({
  gh,
  orchReplies,
  remoteUrl = "https://github.com/owner/repo.git",
  preReadHead = null,
  extra = {},
}) {
  gitState.head = CLEAN_REPO_HEAD;
  gitState.branch = CLEAN_REPO_BRANCH;
  gitState.remoteUrl = remoteUrl;
  gitState.preReadHead = preReadHead;
  gitState.resolverReads = 0;
  gitDouble.answer = declareGit;
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
  ["a malformed entry beside a match", () => [MATCH, {}]],
  ["a null entry beside a match", () => [MATCH, null]],
  ["an entry with a non-numeric number beside a match", () => [MATCH, { ...MATCH, number: "43" }]],
  ["a PR with no url", () => [{ ...MATCH, url: undefined }]],
  [
    "a work tree head that changes during the read",
    () => {
      gitState.head = OTHER_HEAD;
      return [MATCH];
    },
  ],
  [
    "a branch switch to the same commit during the read",
    () => {
      gitState.branch = "other";
      return [MATCH];
    },
  ],
  [
    "a remote that moves to another repository during the read",
    () => {
      gitState.remoteUrl = "https://github.com/other/repo.git";
      return [MATCH];
    },
  ],
  [
    "a PR URL whose number is not a number",
    () => [{ ...MATCH, url: `${MATCH.url.slice(0, -2)}x` }],
  ],
  ["a PR URL with a path after the number", () => [{ ...MATCH, url: `${MATCH.url}/files` }]],
  ["a PR URL for another number", () => [{ ...MATCH, url: `${MATCH.url.slice(0, -2)}43` }]],
  [
    "a reply that fills the list limit",
    () =>
      Array.from({ length: 100 }, (_, i) => ({ ...MATCH, number: i + 1, isCrossRepository: true })),
  ],
  [
    "a PR whose base repository is not the run repository",
    () => [{ ...MATCH, url: "https://github.com/other/repo/pull/42" }],
  ],
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

// Usefulness: verifies a remote that names another repository, or no GitHub repository, leaves the
// run undeclared, so a PR in a repository other than the run repository never gates the run.
test.each([
  ["a remote that names another repository", "git@github.com:other/repo.git"],
  ["a remote URL that names no GitHub repository", "/srv/git/repo.git"],
])("%s leaves the run undeclared", async (_name, remoteUrl) => {
  const { events } = await runWorkerPrRun({
    gh: declareGh([MATCH]),
    orchReplies: [work, finish({ unresolvedCompare: true })],
    remoteUrl,
  });

  expect(events.some((e) => e.type === "pr-declared")).toBe(false);
});

// Usefulness: verifies the base repository check accepts the remote URL forms that GitHub gives, so
// the check does not turn an SSH or mixed-case remote into an undeclared run.
test.each([
  ["scp", "git@github.com:Owner/Repo.git"],
  ["ssh", "ssh://git@github.com/owner/repo"],
  ["https with a trailing slash", "https://github.com/owner/repo.git/"],
])("a PR whose base repository matches a %s remote is declared", async (_name, remoteUrl) => {
  const { events } = await runWorkerPrRun({
    gh: declareGh([MATCH]),
    orchReplies: [work, finish(), finish()],
    remoteUrl,
  });

  expect(events.filter((e) => e.type === "pr-declared")).toHaveLength(1);
});

// Usefulness: verifies the runtime itself refuses a continued run whose PR flag or mode conflicts
// with the restored PR before any turn runs, so a caller other than the CLI cannot replace the
// binding either.
test.each([
  ["--pr for another PR", { pr: 7 }],
  ["--require-ci for another PR", { requireCi: 7 }],
  ["mode review-only", { mode: "review-only" }],
])("a continued run with %s refuses the restored PR before any turn", async (_name, extra) => {
  const orch = scripted([finish()]);
  gitDouble.answer = declareGit;
  const repo = await createCleanRepoDir();
  try {
    await expect(
      runLoop({
        task: "t",
        cwd: repo,
        maxSteps: 3,
        roles: gateRoles(),
        agents: { orch, work: scripted([]), rev: scripted([]) },
        continued: true,
        earlierPr: 42,
        ...extra,
      }),
    ).rejects.toThrow(/declared PR 42|PR 42/);
    expect(orch.recorded).toEqual([]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the work tree head must be the same at the worker snapshot, before the GitHub
// read, after it, and at the PR head. A head that differs only in the middle of that sequence leaves
// the run undeclared, because the PR matched a head the work tree did not hold throughout.
test("a head that differs before the read and returns after it leaves the run undeclared", async () => {
  const { events } = await runWorkerPrRun({
    gh: declareGh([MATCH]),
    orchReplies: [work, finish({ unresolvedCompare: true })],
    preReadHead: OTHER_HEAD,
  });

  expect(events.some((e) => e.type === "pr-declared")).toBe(false);
});
