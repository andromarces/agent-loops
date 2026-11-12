import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { cleanupLoop } from "../../src/batch/cleanup.mjs";
import { createLoopWorkTree, git } from "../../src/batch/git.mjs";
import { acquireClaim, releaseClaim } from "../../src/batch/store.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const REPO_KEY = "abcabcabcabc";

const roots = [];
const repositories = [];
let shared;
const trees = {};
let merged;
let mergedUndeclared;

async function createRepo() {
  const main = await createTempRepo();
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  const remote = await mkdtemp(join(tmpdir(), "batch-remote-"));
  await execa("git", ["init", "--bare"], { cwd: remote });
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`], {
    cwd: main,
  });
  await execa("git", ["config", "user.name", "Tester"], { cwd: main });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: main });
  const repo = { main, remote, base };
  repositories.push(repo);
  return repo;
}

async function makeTree(repo, { name, push = true, dirty = false, lock = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `batch-root-${name}-`));
  roots.push(root);
  const workTree = join(root, "issue-7");
  const branch = `batch/b1/${name}`;
  const recorded = await createLoopWorkTree({
    repo: repo.main,
    base: repo.base,
    workTree,
    branch,
  });
  await execa("git", ["commit", "--allow-empty", "-m", "work on the issue"], { cwd: workTree });
  if (push) await execa("git", ["push", "-u", "origin", branch], { cwd: workTree });
  if (dirty) await writeFile(join(workTree, "dirty.txt"), "uncommitted" + String.fromCharCode(10));
  if (lock) await execa("git", ["worktree", "lock", workTree], { cwd: repo.main });
  return { repo, root, workTree, branch, recorded };
}

// Every work tree of the file is built once here; each case gets its own tree and runs root, so
// the cases stay independent without a Git setup or teardown process per case.
beforeAll(async () => {
  shared = await createRepo();
  trees.pushed = await makeTree(shared, { name: "pushed" });
  trees.unpushed = await makeTree(shared, { name: "unpushed", push: false });
  trees.dirty = await makeTree(shared, { name: "dirty", dirty: true });
  trees.replaced = await makeTree(shared, { name: "replaced" });
  trees.locked = await makeTree(shared, { name: "locked", lock: true });

  // Process-level exception: this case merges into the base branch and deletes a remote branch,
  // a state change that cannot be reset for another case. It uses its own repository.
  const repo = await createRepo();
  const tree = await makeTree(repo, { name: "merged" });
  const head = (await git(["rev-parse", "HEAD"], tree.workTree)).stdout;
  await execa("git", ["merge", "--no-ff", "-m", "merge", tree.branch], { cwd: repo.main });
  const mergeCommit = (await git(["rev-parse", "HEAD"], repo.main)).stdout;
  await execa("git", ["push", "origin", repo.base], { cwd: repo.main });
  await execa("git", ["push", "origin", "--delete", tree.branch], { cwd: tree.workTree });
  merged = { ...tree, head, mergeCommit };

  // A second merged tree keeps the undeclared proof case independent of the declared one.
  const undeclaredRepo = await createRepo();
  const undeclaredTree = await makeTree(undeclaredRepo, { name: "merged-undeclared" });
  const undeclaredHead = (await git(["rev-parse", "HEAD"], undeclaredTree.workTree)).stdout;
  await execa("git", ["merge", "--no-ff", "-m", "merge", undeclaredTree.branch], {
    cwd: undeclaredRepo.main,
  });
  const undeclaredMergeCommit = (await git(["rev-parse", "HEAD"], undeclaredRepo.main)).stdout;
  await execa("git", ["push", "origin", undeclaredRepo.base], { cwd: undeclaredRepo.main });
  await execa("git", ["push", "origin", "--delete", undeclaredTree.branch], {
    cwd: undeclaredTree.workTree,
  });
  mergedUndeclared = {
    ...undeclaredTree,
    head: undeclaredHead,
    mergeCommit: undeclaredMergeCommit,
  };
}, 60_000);

afterAll(async () => {
  for (const root of roots.splice(0)) await removePath(root);
  for (const repo of repositories.splice(0)) {
    await removePath(repo.remote);
    await removePath(repo.main);
  }
});

async function fixtureFor(tree, { status = "succeeded", pr = null } = {}) {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-runs-"));
  roots.push(runsRoot);
  await acquireClaim(runsRoot, REPO_KEY, 7, {
    batchId: "b1",
    repo: tree.repo.main,
    workTree: tree.workTree,
    pid: process.pid,
    startTime: null,
  });
  const manifest = {
    id: "b1",
    repo: tree.repo.main,
    repoKey: REPO_KEY,
    base: tree.repo.base,
    workTreeRoot: tree.root,
    issues: [7],
    settings: { loops: 1, maxSteps: 10 },
  };
  const loop = {
    issue: 7,
    status,
    pr,
    workTree: tree.recorded,
    branch: tree.branch,
  };
  return {
    ...tree,
    runsRoot,
    manifest,
    loop,
    cleanup: async (overrides = {}) =>
      cleanupLoop({
        manifest: { ...manifest, ...overrides.manifest },
        loop: { ...loop, ...overrides.loop },
        runsRoot,
        gh: overrides.gh,
      }),
  };
}

// Usefulness: a pushed successful work tree is removed after every identity and reachability check.
test("a pushed successful work tree is removed", async () => {
  const fixture = await fixtureFor(trees.pushed);
  const result = await fixture.cleanup();
  expect(result).toEqual({ removed: true, reason: null });
  await expect(stat(fixture.workTree)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await releaseClaim(fixture.runsRoot, REPO_KEY, 7, { batchId: "b1" })).toBe(false);
});

// Usefulness: an unpushed commit keeps the work tree for the owner.
test("an unpushed work tree is kept", async () => {
  const fixture = await fixtureFor(trees.unpushed);
  const result = await fixture.cleanup();
  expect(result.removed).toBe(false);
  expect(result.reason).toContain("unpushed");
  expect((await stat(fixture.workTree)).isDirectory()).toBe(true);
});

// Usefulness: a dirty work tree is never removed.
test("a dirty work tree is kept", async () => {
  const fixture = await fixtureFor(trees.dirty);
  const result = await fixture.cleanup();
  expect(result.removed).toBe(false);
  expect(result.reason).toContain("not clean");
});

// Usefulness: a failed, interrupted, or needs-owner loop keeps its work tree. These cases return
// before any Git or file system read, so they need no repository fixture.
for (const status of ["failed", "interrupted", "needs-owner"]) {
  test(`a ${status} work tree is kept`, async () => {
    const result = await cleanupLoop({
      manifest: { id: "b1", repo: "unused", repoKey: REPO_KEY, workTreeRoot: "unused" },
      loop: { issue: 7, status, workTree: null },
      runsRoot: "unused",
    });
    expect(result.removed).toBe(false);
    expect(result.reason).toContain(status);
  });
}

// Usefulness: a directory whose device or inode no longer matches is never removed. The recorded
// identity is changed instead of relying on the file system to allocate a different inode, which
// an ext4 reuse can defeat.
test("a replaced directory is kept", async () => {
  const fixture = await fixtureFor(trees.replaced);
  const result = await fixture.cleanup({
    loop: { workTree: { ...fixture.loop.workTree, dev: "0", ino: "0" } },
  });
  expect(result.removed).toBe(false);
  expect(result.reason).toContain("identity");
  expect((await stat(fixture.workTree)).isDirectory()).toBe(true);
});

// Usefulness: a live work tree lock keeps the tree.
test("a locked work tree is kept", async () => {
  const fixture = await fixtureFor(trees.locked);
  const result = await fixture.cleanup();
  expect(result.removed).toBe(false);
  expect(result.reason).toContain("lock");
});

// Usefulness: the main work tree and an outside path are never touched.
test("the main work tree is never removed", async () => {
  const fixture = await fixtureFor(trees.pushed);
  const result = await fixture.cleanup({
    loop: {
      workTree: {
        ...fixture.loop.workTree,
        path: fixture.repo.main,
        canonicalPath: fixture.repo.main,
      },
    },
  });
  expect(result.removed).toBe(false);
  expect((await stat(fixture.repo.main)).isDirectory()).toBe(true);
});

// Usefulness: a merged undeclared pull request proves the push when no declaration exists.
test("a merged undeclared pull request proves a deleted remote branch", async () => {
  const fixture = await fixtureFor(mergedUndeclared, { pr: null });
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          state: "MERGED",
          headRefOid: mergedUndeclared.head,
          mergeCommit: { oid: mergedUndeclared.mergeCommit },
        }),
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const result = await fixture.cleanup({ loop: { pr: null, prUndeclared: 5 }, gh });
  expect(result).toEqual({ removed: true, reason: null });
});

// Usefulness: a merged pull request proves the push when the remote branch was deleted.
test("a merged pull request proves a deleted remote branch", async () => {
  const fixture = await fixtureFor(merged, { pr: 5 });
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          state: "MERGED",
          headRefOid: merged.head,
          mergeCommit: { oid: merged.mergeCommit },
        }),
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const result = await fixture.cleanup({ gh });
  expect(result.removed).toBe(true);
});
