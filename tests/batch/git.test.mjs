import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vite-plus/test";
import { execa } from "execa";
import {
  createPrWorkTree,
  identityEqual,
  pathIdentity,
  removeDirectoryWithoutLinks,
} from "../../src/batch/git.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

// Usefulness: a refusal that discovers a real file changes nothing, including a link beside it.
test("a refused remainder removal keeps every entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-git-"));
  try {
    const target = join(root, "tree");
    await mkdir(join(target, "nested"), { recursive: true });
    await symlink(
      root,
      join(target, "nested", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(join(target, "nested", "real.txt"), "kept\n");
    const identity = await pathIdentity(target);
    const result = await removeDirectoryWithoutLinks(target, identity);
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("real file");
    expect((await pathIdentity(join(target, "nested", "link")))?.dev).toBeDefined();
    expect(await pathIdentity(join(target, "nested", "real.txt"))).not.toBe(null);
  } finally {
    await removePath(root);
  }
});

// Usefulness: device and inode compare as bigint values beyond the safe integer range.
test("device and inode compare without losing precision", () => {
  expect(
    identityEqual(
      { dev: 9007199254740993n, ino: 9007199254740995n },
      { dev: "9007199254740993", ino: "9007199254740995" },
    ),
  ).toBe(true);
  expect(
    identityEqual(
      { dev: 9007199254740993n, ino: 9007199254740995n },
      { dev: "9007199254740992", ino: "9007199254740995" },
    ),
  ).toBe(false);
});

let sharedPrPromise;
const sharedPrDirs = [];

// One shared seed repository and bare remote for the file. Each case copies the seed, so its local
// branches are mutable per test while every commit and every refs/pull/<n>/head stays shared.
async function sharedPr() {
  sharedPrPromise ??= (async () => {
    const seed = await createTempRepo();
    const remote = await mkdtemp(join(tmpdir(), "batch-pr-remote-"));
    sharedPrDirs.push(seed, remote);
    await execa("git", ["init", "--bare"], { cwd: remote });
    await execa("git", ["remote", "add", "origin", remote], { cwd: seed });
    const mainHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    await execa("git", ["push", "-u", "origin", "HEAD:refs/heads/main"], { cwd: seed });
    await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
    await execa("git", ["checkout", "-b", "feature-a"], { cwd: seed });
    await writeFile(join(seed, "feature.txt"), "one\n");
    await execa("git", ["add", "feature.txt"], { cwd: seed });
    await execa("git", ["commit", "-m", "feature one"], { cwd: seed });
    const headA = (await execa("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    await execa("git", ["push", "-u", "origin", "feature-a"], { cwd: seed });
    await execa("git", ["branch", "feature-ff", mainHead], { cwd: seed });
    const other = await mkdtemp(join(tmpdir(), "batch-pr-other-"));
    try {
      await execa("git", ["clone", remote, other]);
      await execa("git", ["config", "user.name", "Tester"], { cwd: other });
      await execa("git", ["config", "user.email", "test@example.com"], { cwd: other });
      await execa("git", ["checkout", "-b", "feature-b"], { cwd: other });
      await writeFile(join(other, "remote-only.txt"), "remote\n");
      await execa("git", ["add", "remote-only.txt"], { cwd: other });
      await execa("git", ["commit", "-m", "remote only"], { cwd: other });
      const headB = (await execa("git", ["rev-parse", "HEAD"], { cwd: other })).stdout.trim();
      await execa("git", ["push", "origin", "feature-b"], { cwd: other });
      for (const [number, sha] of [
        [1, headA],
        [2, headB],
        [3, headA],
        [4, headA],
        [5, headA],
      ]) {
        await execa("git", ["update-ref", `refs/pull/${number}/head`, sha], { cwd: remote });
      }
      return { seed, remote, headA, headB, mainHead };
    } finally {
      await removePath(other);
    }
  })();
  return sharedPrPromise;
}

afterAll(async () => {
  sharedPrPromise = undefined;
  for (const dir of sharedPrDirs.splice(0)) await removePath(dir);
});

async function copySeed(seed) {
  const repo = await mkdtemp(join(tmpdir(), "batch-pr-repo-"));
  await cp(seed, repo, { recursive: true });
  return repo;
}

// Usefulness: a local branch with commits the frozen head lacks is skipped, never reset.
test("a PR work tree refuses a local branch with unpushed commits", async () => {
  const { seed, headA, mainHead } = await sharedPr();
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    await execa("git", ["checkout", "-b", "feature-div", mainHead], { cwd: repo });
    await writeFile(join(repo, "local.txt"), "unpushed\n");
    await execa("git", ["add", "local.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "local only"], { cwd: repo });
    const local = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await execa("git", ["checkout", "feature-a"], { cwd: repo });
    expect(local).not.toBe(headA);
    await expect(
      createPrWorkTree({
        repo,
        workTree: join(root, "pr-1"),
        branch: "feature-div",
        head: headA,
        number: 1,
      }),
    ).rejects.toMatchObject({ code: "pr-branch-diverged" });
    const after = (await execa("git", ["rev-parse", "feature-div"], { cwd: repo })).stdout.trim();
    expect(after).toBe(local);
  } finally {
    await removePath(root);
    await removePath(repo);
  }
});

// Usefulness: a same-repository PR head absent locally is fetched and gets its named branch.
test("a PR work tree fetches the head commit", async () => {
  const { seed, headA, headB } = await sharedPr();
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    await expect(execa("git", ["cat-file", "-e", headB], { cwd: repo })).rejects.toThrow();
    const tree = await createPrWorkTree({
      repo,
      workTree: join(root, "pr-2"),
      branch: "feature-b",
      head: headB,
      number: 2,
    });
    const checkedOut = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: tree.path })
    ).stdout.trim();
    expect(checkedOut).toBe(headB);
    const branchname = (
      await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tree.path })
    ).stdout.trim();
    expect(branchname).toBe("feature-b");
    expect(headA).not.toBe(headB);
  } finally {
    await removePath(root);
    await removePath(repo);
  }
});

// Usefulness: a head that changed between the freeze and the fetch never reaches a review.
test("a PR work tree refuses a head that moved since the freeze", async () => {
  const { seed, mainHead } = await sharedPr();
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    await expect(
      createPrWorkTree({
        repo,
        workTree: join(root, "pr-3"),
        branch: "feature-a",
        head: mainHead,
        number: 3,
      }),
    ).rejects.toMatchObject({ code: "pr-head-moved" });
  } finally {
    await removePath(root);
    await removePath(repo);
  }
});

// Usefulness: the named PR branch fast-forwards to the frozen head without a reset.
test("a PR work tree fast-forwards a branch behind the frozen head", async () => {
  const { seed, headA } = await sharedPr();
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    const tree = await createPrWorkTree({
      repo,
      workTree: join(root, "pr-5"),
      branch: "feature-ff",
      head: headA,
      number: 5,
    });
    const checkedOut = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: tree.path })
    ).stdout.trim();
    expect(checkedOut).toBe(headA);
  } finally {
    await removePath(root);
    await removePath(repo);
  }
});

// Usefulness: a branch checked out in another work tree is skipped, not stolen.
test("a PR work tree refuses a branch checked out elsewhere", async () => {
  const { seed, headA } = await sharedPr();
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    await expect(
      createPrWorkTree({
        repo,
        workTree: join(root, "pr-1"),
        branch: "feature-a",
        head: headA,
        number: 1,
      }),
    ).rejects.toMatchObject({ code: "pr-branch-checked-out" });
  } finally {
    await removePath(root);
    await removePath(repo);
  }
});

// Usefulness: the worker's documented named push reaches the PR head branch.
test("a PR work tree pushes a correction with the named push", async () => {
  const { seed, remote, headA } = await sharedPr();
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    const tree = await createPrWorkTree({
      repo,
      workTree: join(root, "pr-4"),
      branch: "feature-push",
      head: headA,
      number: 4,
    });
    await writeFile(join(tree.path, "correction.txt"), "corrected\n");
    await execa("git", ["add", "correction.txt"], { cwd: tree.path });
    await execa("git", ["commit", "-m", "correction"], { cwd: tree.path });
    const corrected = (await execa("git", ["rev-parse", "HEAD"], { cwd: tree.path })).stdout.trim();
    await execa("git", ["push", "-u", "origin", "feature-push"], { cwd: tree.path });
    const remoteHead = (
      await execa("git", ["rev-parse", "refs/heads/feature-push"], { cwd: remote })
    ).stdout.trim();
    expect(remoteHead).toBe(corrected);
    expect(corrected).not.toBe(headA);
  } finally {
    await removePath(root);
    await removePath(repo);
  }
});
