import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
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

const scenarioDirs = [];
const scenarios = {};

async function copySeed(seed) {
  const repo = await mkdtemp(join(tmpdir(), "batch-pr-repo-"));
  scenarioDirs.push(repo);
  await cp(seed, repo, { recursive: true });
  return repo;
}

async function scenarioRepo(seed, run) {
  const repo = await copySeed(seed);
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  scenarioDirs.push(root);
  return run(repo, root);
}

async function codeOf(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err?.code ?? err?.message ?? String(err);
  }
}

// One shared setup builds the seed repository and runs every Git scenario once. Each scenario has
// its own copy and branch, and the tests below only assert on the recorded result.
beforeAll(async () => {
  const seed = await createTempRepo();
  const remote = await mkdtemp(join(tmpdir(), "batch-pr-remote-"));
  scenarioDirs.push(seed, remote);
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
  scenarioDirs.push(other);
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

  scenarios.diverged = await scenarioRepo(seed, async (repo, root) => {
    await execa("git", ["checkout", "-b", "feature-div", mainHead], { cwd: repo });
    await writeFile(join(repo, "local.txt"), "unpushed\n");
    await execa("git", ["add", "local.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "local only"], { cwd: repo });
    const local = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await execa("git", ["checkout", "feature-a"], { cwd: repo });
    const code = await codeOf(() =>
      createPrWorkTree({
        repo,
        workTree: join(root, "pr-1"),
        branch: "feature-div",
        head: headA,
        number: 1,
      }),
    );
    const after = (await execa("git", ["rev-parse", "feature-div"], { cwd: repo })).stdout.trim();
    return { code, local, after };
  });

  scenarios.fetched = await scenarioRepo(seed, async (repo, root) => {
    const present = await execa("git", ["cat-file", "-e", headB], { cwd: repo }).then(
      () => true,
      () => false,
    );
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
    const branch = (
      await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tree.path })
    ).stdout.trim();
    return { present, checkedOut, branch, head: headB };
  });

  scenarios.moved = await scenarioRepo(seed, async (repo, root) => ({
    code: await codeOf(() =>
      createPrWorkTree({
        repo,
        workTree: join(root, "pr-3"),
        branch: "feature-a",
        head: mainHead,
        number: 3,
      }),
    ),
  }));

  scenarios.fastForward = await scenarioRepo(seed, async (repo, root) => {
    const tree = await createPrWorkTree({
      repo,
      workTree: join(root, "pr-5"),
      branch: "feature-ff",
      head: headA,
      number: 5,
    });
    return {
      head: (await execa("git", ["rev-parse", "HEAD"], { cwd: tree.path })).stdout.trim(),
      expected: headA,
    };
  });

  scenarios.checkedOut = await scenarioRepo(seed, async (repo, root) => ({
    code: await codeOf(() =>
      createPrWorkTree({
        repo,
        workTree: join(root, "pr-1"),
        branch: "feature-a",
        head: headA,
        number: 1,
      }),
    ),
  }));

  scenarios.pushed = await scenarioRepo(seed, async (repo, root) => {
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
    return { corrected, remoteHead };
  });
}, 120_000);

afterAll(async () => {
  for (const dir of scenarioDirs.splice(0)) await removePath(dir);
});

// Usefulness: a local branch with commits the frozen head lacks is skipped, never reset.
test("a PR work tree refuses a local branch with unpushed commits", () => {
  expect(scenarios.diverged.code).toBe("pr-branch-diverged");
  expect(scenarios.diverged.after).toBe(scenarios.diverged.local);
});

// Usefulness: a same-repository PR head absent locally is fetched and gets its named branch.
test("a PR work tree fetches the head commit", () => {
  expect(scenarios.fetched.present).toBe(false);
  expect(scenarios.fetched.branch).toBe("feature-b");
  expect(scenarios.fetched.checkedOut).toBe(scenarios.fetched.head);
});

// Usefulness: a head that changed between the freeze and the fetch never reaches a review.
test("a PR work tree refuses a head that moved since the freeze", () => {
  expect(scenarios.moved.code).toBe("pr-head-moved");
});

// Usefulness: the named PR branch fast-forwards to the frozen head without a reset.
test("a PR work tree fast-forwards a branch behind the frozen head", () => {
  expect(scenarios.fastForward.head).toBe(scenarios.fastForward.expected);
});

// Usefulness: a branch checked out in another work tree is skipped, not stolen.
test("a PR work tree refuses a branch checked out elsewhere", () => {
  expect(scenarios.checkedOut.code).toBe("pr-branch-checked-out");
});

// Usefulness: the worker's documented named push reaches the PR head branch.
test("a PR work tree pushes a correction with the named push", () => {
  expect(scenarios.pushed.remoteHead).toBe(scenarios.pushed.corrected);
});
