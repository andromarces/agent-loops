import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory (see `cleanRepoGit` in git-helpers.mjs).
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

import { tmpdir } from "node:os";
import { runLoop } from "../src/runtime.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import {
  CLEAN_REPO_BRANCH,
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createCleanRepoDir,
} from "./git-helpers.mjs";
import {
  equalsArgs,
  freePlanGh,
  gateReads,
  noRequiredCheckGh,
  pagedApiArgs,
  PASSING_RUN,
  prChecksArgs,
  prGateGh,
  prViewArgs,
  unreachableGh,
} from "./gh-doubles.mjs";
import { gateRoles, REVIEW_ACCEPT, SUMMARY } from "./run-fixtures.mjs";

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
    case '["config","--get","branch.other.remote"]':
      return { exitCode: 1, stdout: "", stderr: "" };
    case '["remote","get-url","origin"]':
      return ok(gitState.remoteUrl);
    default:
      return cleanRepoGit(command, args, options);
  }
}

// `gh pr list` for the run branch answers `listReply`; every other read is the shared gate fixture
// for PR 42. `listReply` is a list of PRs, or a function that throws or returns a gh result.
function declareGh(listReply, calls = [], runs = [PASSING_RUN], gate = null) {
  gate ??= prGateGh(CLEAN_REPO_HEAD, calls, runs);
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

// Usefulness: verifies issue #924 option 1 end to end. A headless run whose worker opened the PR
// declares it from Git and GitHub state, supplies its check status to the next reviewer prompt,
// refuses the unresolvedCompare marker, and ends through the gate for that PR after a reviewer
// accept with passing required checks.
test("a headless run declares the PR its worker opened and finishes through the gate for it", async () => {
  const { result, events, rev, orch } = await runWorkerPrRun({
    gh: declareGh([MATCH]),
    orchReplies: [work, review, finish({ unresolvedCompare: true }), finish()],
  });

  expect(events.filter((e) => e.type === "pr-declared")).toEqual([
    { type: "pr-declared", pr: 42, stepsUsed: 1 },
  ]);
  expect(orch.recorded[1].prompt).toContain('"declaredPr": 42');
  expect(orch.recorded[1].prompt).toContain("--require-ci 42");
  expect(orch.recorded[1].prompt).not.toContain("refuses every finish");
  expect(orch.recorded[1].prompt).toContain(
    "Before it declared the PR, the runtime read the required-check sources of PR #42",
  );
  const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
  expect(reviewed.result.prChecks).toMatchObject({ pr: 42 });
  expect(rev.recorded[0].prompt).toContain("This run read the required checks for PR 42");
  expect(orch.recorded[3].prompt).toContain("unresolvedCompare cannot be combined");
  expect(result.exitCode).toBe(0);
  expect(result.unresolvedCompare).toBeFalsy();
  expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
});

// Usefulness: verifies the gate for a runtime-declared PR refuses a finish while a required check
// fails or is pending, so the gated finish is not a finish without a verified PR state.
test.each([
  ["fails", { ...PASSING_RUN, conclusion: "failure" }, "failed"],
  ["is pending", { ...PASSING_RUN, status: "in_progress", conclusion: null }, "is pending"],
])("a declared PR run refuses the finish while a required check %s", async (_name, run, text) => {
  const { result, events } = await runWorkerPrRun({
    gh: declareGh([MATCH], [], [run]),
    orchReplies: [work, review, finish(), finish()],
  });

  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain(`required check "ci (ubuntu-latest)" ${text}`);
  expect(events.some((e) => e.type === "refusal")).toBe(true);
});

// Usefulness: verifies a continued run keeps the finish gate for the PR that the earlier run
// declared, so a continuation ends through the same gate and not through an unreachable refusal.
test("a continued run gates its finish on the restored declared PR", async () => {
  const { result, events } = await runWorkerPrRun({
    gh: declareGh([MATCH]),
    orchReplies: [finish(), review, finish()],
    extra: { continued: true, earlierPr: 42 },
  });

  expect(events.filter((e) => e.type === "pr-declared")).toEqual([
    { type: "pr-declared", pr: 42, stepsUsed: 0, restored: true },
  ]);
  expect(events.find((e) => e.type === "refusal").reason).toContain("has no reviewed state");
  expect(result.exitCode).toBe(0);
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
  expect(events.some((e) => e.type === "pr-undeclared")).toBe(false);
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

// Usefulness: verifies acceptance of #1111 — a worker-opened PR on a repository whose required-check
// sources settle nothing stays undeclared, is recorded as undeclared, and the finish records a
// verified head compare of it, so the run no longer needs the unresolvedCompare marker. The warning
// names the reason and the compare.
test("a worker-opened PR whose required-check sources are unreadable is compared at finish", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { result, events, orch } = await runWorkerPrRun({
      gh: declareGh([MATCH], [], [PASSING_RUN], freePlanGh(CLEAN_REPO_HEAD)),
      orchReplies: [work, review, finish()],
    });

    expect(events.some((e) => e.type === "pr-declared")).toBe(false);
    expect(events.filter((e) => e.type === "pr-undeclared")).toEqual([
      { type: "pr-undeclared", pr: 42, stepsUsed: 1 },
    ]);
    expect(events.filter((e) => e.type === "head-compare")).toMatchObject([{ pr: 42 }]);
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.headCompare).toBe("verified");
    expect(result.unresolvedCompare).toBe(false);
    expect(orch.recorded[1].prompt).toContain('"undeclaredPr": 42');
    expect(orch.recorded[1].prompt).toContain("compares the PR head of PR #42 at finish");
    const text = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(text).toContain("warn: no PR declared after the worker turn");
    expect(text).toContain("repository rulesets could not be read");
    expect(text).toContain("head compare");
  } finally {
    warn.mockRestore();
  }
});

// Usefulness: verifies a PR head that differs from the reviewed commit at finish refuses the
// finish, so a moved worker-opened PR is never recorded as a verified compare.
test("a worker-opened undeclared PR whose head differs from the reviewed head refuses the finish", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // The list reply carries the work tree head, and the later PR read carries another head.
    const { result, events } = await runWorkerPrRun({
      gh: declareGh([MATCH], [], [PASSING_RUN], freePlanGh(OTHER_HEAD)),
      orchReplies: [work, review, finish(), finish()],
    });

    expect(events.filter((e) => e.type === "pr-undeclared")).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR head differs from the reviewed commit");
    expect(result.headCompare).toBeUndefined();
    expect(events.some((e) => e.type === "head-compare")).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

// Usefulness: verifies a worker-opened undeclared PR that is closed or merged refuses the finish
// even when its head still equals the reviewed head, so a PR that left the open list after a later
// worker turn never records a verified compare (#1111 review).
test.each(["CLOSED", "MERGED"])(
  "a worker-opened undeclared PR that is %s with an unchanged head refuses the finish",
  async (state) => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const base = freePlanGh(CLEAN_REPO_HEAD);
      const gate = async (args, cwd, options) => {
        const reply = await base(args, cwd, options);
        if (!equalsArgs(args, prViewArgs(42))) return reply;
        return { ...reply, stdout: JSON.stringify({ ...JSON.parse(reply.stdout), state }) };
      };
      let lists = 0;
      // The first list names the PR, and the PR is gone from the open list after the next turn.
      const list = () => ({
        status: 0,
        stdout: JSON.stringify((lists += 1) === 1 ? [MATCH] : []),
        stderr: "",
      });
      const { result, events } = await runWorkerPrRun({
        gh: declareGh(list, [], [PASSING_RUN], gate),
        orchReplies: [work, work, review, finish(), finish()],
      });

      expect(events.filter((e) => e.type === "pr-undeclared")).toHaveLength(1);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain(`PR 42 is ${state.toLowerCase()}, not open`);
      expect(result.headCompare).toBeUndefined();
      expect(events.some((e) => e.type === "head-compare")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  },
);

// Usefulness: verifies the runtime compare resolves the head of the undeclared PR, so a finish that
// also records unresolvedCompare is refused and one head never records two outcomes.
test("a finish with unresolvedCompare is refused beside the compare of an undeclared PR", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { result, events } = await runWorkerPrRun({
      gh: declareGh([MATCH], [], [PASSING_RUN], freePlanGh(CLEAN_REPO_HEAD)),
      orchReplies: [work, review, finish({ unresolvedCompare: true }), finish()],
    });

    expect(events.find((e) => e.type === "refusal").reason).toContain(
      "head compare of the undeclared PR cannot be combined with unresolvedCompare",
    );
    expect(result.exitCode).toBe(0);
    expect(result.headCompare).toBe("verified");
    expect(result.unresolvedCompare).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

// Usefulness: verifies the compare needs a reviewer turn on the current state, so a finish after a
// worker turn with no later reviewer turn is refused and never verifies a stale head.
test("a worker-opened undeclared PR is not compared before a reviewer turn", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { result } = await runWorkerPrRun({
      gh: declareGh([MATCH], [], [PASSING_RUN], freePlanGh(CLEAN_REPO_HEAD)),
      orchReplies: [work, finish(), finish()],
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
  } finally {
    warn.mockRestore();
  }
});

// Usefulness: verifies a continuation does not restore the undeclared PR: it restores the PR of a
// `pr-declared` record only, so with no worker turn in the continuation the marker path stays.
test("a continued run keeps the marker path for a PR that the earlier run left undeclared", async () => {
  const { result, events } = await runWorkerPrRun({
    gh: declareGh([MATCH], [], [PASSING_RUN], freePlanGh(CLEAN_REPO_HEAD)),
    orchReplies: [finish({ unresolvedCompare: true })],
    extra: { continued: true, earlierPr: null },
  });

  expect(events.some((e) => e.type === "pr-undeclared")).toBe(false);
  expect(events.some((e) => e.type === "head-compare")).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.unresolvedCompare).toBe(true);
});

// Usefulness: verifies a read that fails for another reason than an unreadable source still
// declares the PR, as the start of a --pr run proceeds on such a failure.
test("a worker-opened PR is declared when the required-check read fails for another reason", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { events } = await runWorkerPrRun({
      gh: declareGh([MATCH], [], [PASSING_RUN], unreachableGh()),
      orchReplies: [work, finish(), finish()],
    });

    expect(events.filter((e) => e.type === "pr-declared")).toEqual([
      { type: "pr-declared", pr: 42, stepsUsed: 1 },
    ]);
    const text = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(text).not.toContain("at start");
  } finally {
    warn.mockRestore();
  }
});

// Usefulness: verifies the identity guard of ADR 0043 covers the required-check read of the
// declaration, so a head, branch, or remote that changes during that read leaves the run undeclared
// with the warning of the other undeclared states, and no PR gates a state the run did not hold.
test.each([
  ["head", () => (gitState.head = OTHER_HEAD)],
  ["branch", () => (gitState.branch = "other")],
  ["remote", () => (gitState.remoteUrl = "https://github.com/other/repo.git")],
])(
  "a %s that changes during the required-check read leaves the run undeclared",
  async (_name, move) => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const base = prGateGh(CLEAN_REPO_HEAD);
      const gate = async (args, cwd, options) => {
        if (args.some((arg) => String(arg).includes("rules/branches"))) move();
        return base(args, cwd, options);
      };
      const { events } = await runWorkerPrRun({
        gh: declareGh([MATCH], [], [PASSING_RUN], gate),
        orchReplies: [work, finish({ unresolvedCompare: true })],
      });

      expect(events.some((e) => e.type === "pr-declared")).toBe(false);
      const text = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(text).toContain("no PR declared after the worker turn");
      expect(text).toContain("changed during the PR read");
    } finally {
      warn.mockRestore();
    }
  },
);

// 52. Usefulness: verifies a run that declares a PR refuses a finish with no
// `--require-ci` gate. Thus a declared PR run cannot finish through a field the
// parent set. A run without the declaration keeps the marker-only gap (#302).
test("a run that declares a PR refuses a finish with no --require-ci gate", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 52 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("declares PR 42");
    expect(result.reason).toContain("--require-ci 42");
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 53. Usefulness: verifies the same declaration refuses a finish that records the
// unresolved compare, because the gate is what the declaration requires. A
// recorded marker on a declared PR run reads as an accepted gap, so the finish is
// refused instead (#302).
test("a run that declares a PR refuses a finish that carries unresolvedCompare", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 53 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("declares PR 42");
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 54. Usefulness: verifies the marker refusal fires on a declared PR run with no
// gate, and that one refusal names both conditions in the existing order. The
// finish breaks two rules and the run grants one corrective turn. Thus a refusal
// that names one of them spends it on the condition the next refusal names
// instead (#302).
test("a declared PR with no gate reports the marker and the gate in one refusal", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };

    const result = await runLoop({
      task: "PR work: address issue 54 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    const marker =
      "unresolvedCompare cannot be combined with a run that declares PR 42 (--pr): the run must end through the --require-ci 42 gate, which resolves that PR head, so that compare is not unresolved";
    const gate =
      "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(`Finish refused: ${marker}; ${gate}.`);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 55. Usefulness: verifies the declared-PR refusal is reported with the completion
// rule in the existing order. Thus one refusal names every condition the finish
// breaks (#302).
test("the missing-gate refusal is reported with the other refusals in order", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const result = await runLoop({
      task: "PR work: address issue 55 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    const gate =
      "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(`Finish refused: no reviewer report on the state; ${gate}.`);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 55. Usefulness: verifies a run that declares a PR and also carries the gate
// behaves exactly as a gated run does today. Thus the declaration adds no second
// enforcement path and no new refusal (#302).
test("a declared PR with a matching gate runs the gate and nothing else", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const result = await runLoop({
      task: "PR work: address issue 55 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(head),
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

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a headless declared run finishes on a base branch with no
// required check and emits a `no-required-checks` event. Thus the recorded run
// says it verified no check instead of reading as a pass on a checked branch
// (issue #336).

// `git` is answered from memory, not spawned. Run alone, the test started 34 `git`
// processes: a repo and the snapshots around its turns. The same cost made the
// finish tests in role.finish-abort.test.mjs time out under load (issue #385). This
// test was not observed to fail (issue #399). The behavior under test is the finish
// gate over the `gh` answers, and the snapshot code has its own tests on real repos.
test("a declared PR finishes on a base branch with no required check", async () => {
  const cwd = tmpdir();
  gitDouble.answer = cleanRepoGit;
  try {
    const events = [];
    const calls = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The init copy of local files is out of scope here, and its `git` calls
      // have no answer in the double.
      copyLocalFiles: false,
      gh: noRequiredCheckGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
    // The absence rests on the two fixtures this double names, so a route that
    // stops matching fails here instead of passing on a fallback.
    expect(calls).toContain(pagedApiArgs("repos/owner/repo/rules/branches/main").join(" "));
    expect(calls).toContain(prChecksArgs(42).join(" "));
    expect(events.filter((e) => e.type === "no-required-checks")).toHaveLength(1);
    // A finish on a checked branch records no such event. Thus the event means the
    // base branch had no required check rather than that the gate ran.
    expect(events.filter((e) => e.type === "refusal")).toEqual([]);
  } finally {
    gitDouble.answer = null;
  }
});

// Usefulness: verifies a refused finish emits no absence event. Thus the event
// cannot report that a run verified no check when the run did not finish at all
// (issue #336 review).
test("a refused finish emits no absence event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const events = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The gate passes on the absence, and the completion rule still refuses the
      // same finish, so the finish is not accepted.
      gh: noRequiredCheckGh("1111111111111111111111111111111111111111"),
      roles: gateRoles(),
      requireAccept: true,
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(events.filter((e) => e.type === "no-required-checks")).toEqual([]);
    expect(events.filter((e) => e.type === "refusal")).not.toEqual([]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a headless gated run on a base branch that does require a
// check emits no absence event. Thus the field on the event cannot read as a
// statement about every gated run (issue #336).
test("a gated run on a checked base branch emits no absence event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const events = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(CLEAN_REPO_HEAD),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events.filter((e) => e.type === "no-required-checks")).toEqual([]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 56. Usefulness: verifies a run that declares PR 42 and gates a different PR is
// refused. Thus the gate cannot read one pull request while the run declares
// another (#302).
test("a run that declares a PR refuses a gate for a different PR", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];

    const result = await runLoop({
      task: "PR work: address issue 56 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 7,
      gh: prGateGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("declares PR 42");
    // The gate for PR 7 is never read. The reviewer status read names the declared
    // PR 42 and makes the gate's reads for it (#320, #349). Thus the assertion is
    // that no call names PR 7.
    expect(calls.filter((key) => /\b7\b/.test(key))).toEqual([]);
    expect(calls.some((key) => key.includes("pr view 42"))).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 57. Usefulness: pins the exact refusal a declared run gives when the gate names
// another PR. It also pins that the gate for that other PR is never read. A prompt
// or a consumer that reads the reason as a gate verdict otherwise expects a gate
// result the runtime never produced (#302).
test("a mismatched-gate refusal names the declaration and reads no gate", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const result = await runLoop({
      task: "PR work: address issue 57 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      // No reviewer turn here, so the status read never runs and no call is made.
      pr: 42,
      requireCi: 7,
      gh: prGateGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(
      "Finish refused: this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run gates PR 7 instead.",
    );
    // Asserted on the gate's own endpoints. Thus the claim "a refused finish reads
    // no GitHub state" is the assertion. It is not a side effect of which other
    // calls the run happens to make (#320 review). The four reads are the source
    // check of the declared PR 42 at start (#1092, #1182). They are the PR view,
    // the repository view, the rulesets, and the protection read that runs beside
    // them. The refused finish adds none.
    expect(gateReads(calls)).toHaveLength(4);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 58. Usefulness: pins the exact refusal for a declared run whose gate matches and
// whose finish breaks the marker condition and a gate condition together. The gate
// has its own conditions, so the marker is not the only broken one. A prompt that
// claims otherwise sends the run after the wrong fix (#302).
test("a matching-gate refusal names the marker and the gate condition together", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };

    const result = await runLoop({
      task: "PR work: address issue 58 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // No reviewer turn ran, so the gate has no reviewed state to read.
      gh: prGateGh(CLEAN_REPO_HEAD),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(
      "Finish refused: unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved; the latest reviewer turn has no reviewed state.",
    );
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 57. Usefulness: verifies the missing-gate prompt tells the orchestrator what
// the run needs, because no turn in the run can add a flag. A prompt that only
// says "finish again" ends the run on exit 1 with no recovery named (#302).
test("the missing-gate refusal prompt names the gate the run needs", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orch = scripted([
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "abort", reason: "no gate" }),
    ]);

    await runLoop({
      task: "PR work: address issue 57 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: { orch, work: scripted([]), rev: scripted([]) },
    });

    const prompt = orch.recorded[1].prompt;
    expect(prompt).toContain("--require-ci 42");
    expect(prompt).toContain("abort");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 58. Usefulness: verifies the marked-finish prompt names a missing gate only when
// the gate is missing. A declared run whose gate matches loses the gate condition
// once the marker is removed. Thus a prompt that names a missing gate there tells
// the orchestrator to abort a run it can finish. A declared run with no gate keeps
// both conditions and the gate is named (#302).
test("the marked-finish prompt names a missing gate only when the gate is missing", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const markerSummary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const markedFinish = JSON.stringify({
      action: "finish",
      summary: markerSummary,
      unresolvedCompare: true,
    });

    // The gate matches the declaration, so removing the marker is the whole
    // recovery and the run reaches exit 0. The reviewer turn comes first, so the
    // gate has the reviewed state it reads and the marker is the only refusal.
    const withGate = scripted([
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      markedFinish,
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const withGateResult = await runLoop({
      task: "PR work: address issue 58 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(CLEAN_REPO_HEAD),
      roles: gateRoles(),
      agents: { orch: withGate, work: scripted([]), rev: scripted([REVIEW_ACCEPT]) },
    });
    const withGatePrompt = withGate.recorded[2].prompt;
    expect(withGatePrompt).toContain("remove unresolvedCompare from the finish");
    expect(withGatePrompt).toContain("needs no child turn");
    expect(withGatePrompt).not.toContain("missing --require-ci 42 gate");
    expect(withGateResult.exitCode).toBe(0);

    // The gate is absent, so removing the marker leaves the missing gate. The
    // prompt must name it rather than send the orchestrator back to finish.
    const noGate = scripted([markedFinish, JSON.stringify({ action: "abort", reason: "no gate" })]);
    await runLoop({
      task: "PR work: address issue 58 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: { orch: noGate, work: scripted([]), rev: scripted([]) },
    });
    const noGatePrompt = noGate.recorded[1].prompt;
    expect(noGatePrompt).toContain("remove unresolvedCompare from the finish");
    expect(noGatePrompt).toContain("missing --require-ci 42 gate");
    expect(noGatePrompt).toContain("abort");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 58. Usefulness: verifies a run that declares no PR keeps the marker-only
// behavior it has today. Thus the new declaration changes nothing for an ungated
// run that is not PR work (#302).
test("a run that declares no PR still records a marked finish", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const events = [];

    const result = await runLoop({
      task: "Task 58",
      cwd: repo,
      maxSteps: 5,
      roles: gateRoles(),
      agents: {
        orch: scripted([JSON.stringify({ action: "finish", summary, unresolvedCompare: true })]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.unresolvedCompare).toBe(true);
    expect(events.some((e) => e.type === "refusal")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
