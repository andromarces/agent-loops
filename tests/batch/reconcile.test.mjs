import { expect, test } from "vite-plus/test";
import { reconcileLoop } from "../../src/batch/reconcile.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BRANCH = "batch/1/7";

const loop = (overrides = {}) => ({
  issue: 7,
  pr: null,
  workTree: {
    path: "C:\\wt",
    canonicalPath: "C:\\wt",
    dev: "1",
    ino: "2",
    branch: BRANCH,
    ...overrides.workTree,
  },
  ...overrides,
});

function gitReplies(map) {
  return async (args) => {
    const reply = map[JSON.stringify(args)];
    if (reply === undefined) {
      return { exitCode: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
    }
    return { exitCode: reply[0], stdout: reply[1] ?? "", stderr: reply[2] ?? "" };
  };
}

const baseGit = (head = HEAD, extra = {}) => ({
  '["rev-parse","--abbrev-ref","HEAD"]': [0, BRANCH],
  '["rev-parse","HEAD"]': [0, head],
  '["status","--porcelain"]': [0, ""],
  '["fetch","origin","batch/1/7"]': [0, ""],
  '["rev-parse","--verify","--quiet","refs/remotes/origin/batch/1/7"]': [0, head],
  ...extra,
});

const ghReplies = ({
  pulls = [],
  issue = "OPEN",
  details = {},
  fail = false,
  references = [],
} = {}) => {
  return async (args) => {
    if (fail) return { status: 1, stdout: "", stderr: "gh failed" };
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(pulls), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view") {
      const value = details[args[2]];
      return value === undefined
        ? { status: 1, stdout: "", stderr: "not found" }
        : { status: 0, stdout: JSON.stringify(value), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({ state: issue, closedByPullRequestsReferences: references }),
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
};

const deps = (gitMap) => ({
  git: gitReplies(gitMap),
  canonicalPath: async (path) => path,
  pathIdentity: async () => ({ dev: "1", ino: "2" }),
});

const openPull = {
  number: 5,
  state: "OPEN",
  headRefOid: HEAD,
  isCrossRepository: false,
  baseRefName: "main",
};
const openDetail = { number: 5, state: "OPEN", headRefOid: HEAD, mergeCommit: null };

// Usefulness: one matching open pull request resumes through its required-check gate.
test("a matching open pull request resumes with --pr and --require-ci", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({ pulls: [openPull], details: { 5: openDetail } }),
    deps: deps(baseGit()),
  });
  expect(result).toEqual({ status: "resume", reason: null, pr: 5, requireCi: 5 });
});

// Usefulness: another head never resumes as an uncertain write.
test("an open pull request with another head stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({ pulls: [openPull], details: { 5: { ...openDetail, headRefOid: OTHER } } }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("another head");
});

// Usefulness: more than one open pull request is ambiguous.
test("two open pull requests stop the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      pulls: [openPull, { ...openPull, number: 6 }],
      details: { 5: openDetail, 6: { ...openDetail, number: 6 } },
    }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("more than one");
});

// Usefulness: a remote branch equal to the local head resumes without a pull request.
test("an equal remote head with no pull request resumes", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies(),
    deps: deps(baseGit()),
  });
  expect(result).toEqual({ status: "resume", reason: null, pr: null, requireCi: null });
});

// Usefulness: a local branch ahead of its remote with no pull request is not an uncertain write.
test("a local branch ahead of its remote resumes", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies(),
    deps: deps(
      baseGit(HEAD, {
        '["rev-parse","--verify","--quiet","refs/remotes/origin/batch/1/7"]': [0, OTHER],
        [`["rev-list","--count","${OTHER}..${HEAD}"]`]: [0, "1"],
        [`["merge-base","--is-ancestor","${OTHER}","${HEAD}"]`]: [0, ""],
      }),
    ),
  });
  expect(result.status).toBe("resume");
});

// Usefulness: a diverged branch stops the loop and is never forced.
test("a diverged branch stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies(),
    deps: deps(
      baseGit(HEAD, {
        '["rev-parse","--verify","--quiet","refs/remotes/origin/batch/1/7"]': [0, OTHER],
        [`["rev-list","--count","${OTHER}..${HEAD}"]`]: [0, "1"],
        [`["merge-base","--is-ancestor","${OTHER}","${HEAD}"]`]: [1, ""],
      }),
    ),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("remote branch head differs");
});

// Usefulness: a closed-unmerged pull request is never reopened or replaced.
test("a closed-unmerged pull request stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      pulls: [{ ...openPull, state: "CLOSED" }],
      details: { 5: { ...openDetail, state: "CLOSED" } },
    }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("closed without a merge");
});

// Usefulness: a missing work tree is never recreated.
test("a missing work tree stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies(),
    deps: { ...deps(baseGit()), pathIdentity: async () => null },
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("missing");
});

// Usefulness: a failed read is never a pass.
test("a failed read stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({ fail: true }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
});

// Usefulness: a merged pull request that holds the local head is a delivered success.
test("a merged pull request with no local work beyond its head succeeds", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      issue: "CLOSED",
      pulls: [{ ...openPull, state: "MERGED" }],
      details: { 5: { ...openDetail, state: "MERGED", mergeCommit: { oid: "c".repeat(40) } } },
    }),
    deps: deps(
      baseGit(HEAD, {
        [`["rev-list","--count","${HEAD}..${BRANCH}"]`]: [0, "0"],
      }),
    ),
  });
  expect(result).toEqual({ status: "succeeded", reason: null, pr: 5, requireCi: null });
});

// Usefulness: a merged pull request with extra local work is not a success.
test("a merged pull request with extra local work stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      issue: "CLOSED",
      pulls: [{ ...openPull, state: "MERGED" }],
      details: { 5: { ...openDetail, state: "MERGED", mergeCommit: { oid: "c".repeat(40) } } },
    }),
    deps: deps(
      baseGit(HEAD, {
        [`["rev-list","--count","${HEAD}..${BRANCH}"]`]: [0, "2"],
      }),
    ),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("lacks a local commit");
});

// Usefulness: a closed issue with no merged pull request is not this loop's delivery.
test("a closed issue with no merged pull request stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({ issue: "CLOSED", pulls: [openPull], details: { 5: openDetail } }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("no pull request of this branch is merged");
});

// Usefulness: a declared pull request that the read does not find is ambiguous.
test("a declared pull request that the read does not find stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop({ pr: 9 }),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({ pulls: [openPull], details: { 5: openDetail } }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("declares pull request 9");
});

// Usefulness: an open pull request on a dirty tree is not resumed.
test("a dirty work tree with an open pull request stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({ pulls: [openPull], details: { 5: openDetail } }),
    deps: deps(baseGit(HEAD, { '["status","--porcelain"]': [0, " M file.txt"] })),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("not clean");
});

// Usefulness: a failed remote-branch fetch is a read failure, never an absent branch.
test("a failed fetch stops the loop as needs-owner", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies(),
    deps: deps(baseGit(HEAD, { '["fetch","origin","batch/1/7"]': [1, "", "network down"] })),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("remote branch");
});

// Usefulness: a pull request of another branch that closes the issue is not this loop's delivery.
test("a pull request from another branch that closes the issue stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      issue: "CLOSED",
      pulls: [openPull],
      details: { 5: openDetail },
      references: [{ number: 9 }],
    }),
    deps: deps(baseGit()),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("9");
});

// Usefulness: a successful fetch followed by a failed ref read is still a failed read.
test("a failed remote-ref read stops the loop", async () => {
  const result = await reconcileLoop({
    loop: loop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies(),
    deps: deps(
      baseGit(HEAD, {
        '["rev-parse","--verify","--quiet","refs/remotes/origin/batch/1/7"]': [
          1,
          "",
          "reference is broken",
        ],
      }),
    ),
  });
  expect(result).toMatchObject({ status: "needs-owner" });
  expect(result.reason).toContain("remote branch");
});

const NEW = "c".repeat(40);
const prLoop = (overrides = {}) => ({
  issue: "pr-5",
  kind: "pr",
  mode: "review-first",
  pr: 5,
  branch: "feature",
  head: HEAD,
  workTree: {
    path: "C:\\wt",
    canonicalPath: "C:\\wt",
    dev: "1",
    ino: "2",
    branch: "feature",
    ...overrides.workTree,
  },
  ...overrides,
});

// Usefulness: a PR head that moved only through this loop's own push resumes.
test("a pull request head moved by the loop's own push resumes", async () => {
  const result = await reconcileLoop({
    loop: prLoop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      details: { 5: { state: "OPEN", headRefOid: NEW, mergeCommit: null } },
    }),
    deps: deps({
      '["rev-parse","--abbrev-ref","HEAD"]': [0, "feature"],
      '["rev-parse","HEAD"]': [0, NEW],
      '["status","--porcelain"]': [0, ""],
      '["fetch","origin","feature"]': [0, ""],
      '["rev-parse","--verify","--quiet","refs/remotes/origin/feature"]': [0, NEW],
      [`["merge-base","--is-ancestor","${HEAD}","${NEW}"]`]: [0, ""],
    }),
  });
  expect(result).toMatchObject({ status: "resume", pr: 5, requireCi: 5 });
});

// Usefulness: a PR head moved outside the loop still stops as needs-owner.
test("a pull request head moved outside the loop is refused", async () => {
  const result = await reconcileLoop({
    loop: prLoop(),
    repo: "C:\\repo",
    base: "main",
    gh: ghReplies({
      details: { 5: { state: "OPEN", headRefOid: NEW, mergeCommit: null } },
    }),
    deps: deps({
      '["rev-parse","--abbrev-ref","HEAD"]': [0, "feature"],
      '["rev-parse","HEAD"]': [0, HEAD],
      '["status","--porcelain"]': [0, ""],
    }),
  });
  expect(result.status).toBe("needs-owner");
  expect(result.reason).toContain("head moved");
});
