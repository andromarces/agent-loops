import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
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

async function prRepo() {
  const main = await createTempRepo();
  const remote = await mkdtemp(join(tmpdir(), "batch-pr-remote-"));
  await execa("git", ["init", "--bare"], { cwd: remote });
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", "HEAD:refs/heads/main"], { cwd: main });
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  await execa("git", ["checkout", "-b", "feature"], { cwd: main });
  await writeFile(join(main, "feature.txt"), "one\n");
  await execa("git", ["add", "feature.txt"], { cwd: main });
  await execa("git", ["commit", "-m", "feature one"], { cwd: main });
  const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: main })).stdout.trim();
  await execa("git", ["push", "-u", "origin", "feature"], { cwd: main });
  await execa("git", ["update-ref", "refs/pull/1/head", head], { cwd: remote });
  return { main, remote, head };
}

// Usefulness: a PR work tree never resets an existing local branch with unpushed commits.
test("a PR work tree leaves an existing local branch untouched", async () => {
  const { main, remote, head } = await prRepo();
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    await writeFile(join(main, "local.txt"), "unpushed\n");
    await execa("git", ["add", "local.txt"], { cwd: main });
    await execa("git", ["commit", "-m", "local only"], { cwd: main });
    const local = (await execa("git", ["rev-parse", "HEAD"], { cwd: main })).stdout.trim();
    expect(local).not.toBe(head);
    const tree = await createPrWorkTree({
      repo: main,
      workTree: join(root, "pr-1"),
      branch: "feature",
      head,
      number: 1,
    });
    expect(tree.detached).toBe(true);
    const checkedOut = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: tree.path })
    ).stdout.trim();
    expect(checkedOut).toBe(head);
    const after = (await execa("git", ["rev-parse", "feature"], { cwd: main })).stdout.trim();
    expect(after).toBe(local);
  } finally {
    await removePath(root);
    await removePath(remote);
    await removePath(main);
  }
});

// Usefulness: a same-repository PR head absent from the local object store is fetched.
test("a PR work tree fetches the head commit", async () => {
  const { main, remote, head } = await prRepo();
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  const other = await mkdtemp(join(tmpdir(), "batch-pr-other-"));
  try {
    await execa("git", ["clone", remote, other]);
    await execa("git", ["checkout", "feature"], { cwd: other });
    await writeFile(join(other, "remote-only.txt"), "remote\n");
    await execa("git", ["add", "remote-only.txt"], { cwd: other });
    await execa("git", ["commit", "-m", "remote only"], { cwd: other });
    const remoteHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: other })).stdout.trim();
    await execa("git", ["push", "origin", "feature"], { cwd: other });
    await execa("git", ["update-ref", "refs/pull/1/head", remoteHead], { cwd: remote });
    await expect(execa("git", ["cat-file", "-e", remoteHead], { cwd: main })).rejects.toThrow();
    const tree = await createPrWorkTree({
      repo: main,
      workTree: join(root, "pr-1"),
      branch: "feature",
      head: remoteHead,
      number: 1,
    });
    const checkedOut = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: tree.path })
    ).stdout.trim();
    expect(checkedOut).toBe(remoteHead);
    expect(head).not.toBe(remoteHead);
  } finally {
    await removePath(other);
    await removePath(root);
    await removePath(remote);
    await removePath(main);
  }
});

// Usefulness: a head that changed between the freeze and the fetch never reaches a review.
test("a PR work tree refuses a head that moved since the freeze", async () => {
  const { main, remote, head } = await prRepo();
  const root = await mkdtemp(join(tmpdir(), "batch-pr-work-"));
  try {
    const newer = head;
    const older = (await execa("git", ["rev-parse", "HEAD~1"], { cwd: main })).stdout.trim();
    await execa("git", ["update-ref", "refs/pull/1/head", newer], { cwd: remote });
    await expect(
      createPrWorkTree({
        repo: main,
        workTree: join(root, "pr-1"),
        branch: "feature",
        head: older,
        number: 1,
      }),
    ).rejects.toMatchObject({ code: "pr-head-moved" });
  } finally {
    await removePath(root);
    await removePath(remote);
    await removePath(main);
  }
});
