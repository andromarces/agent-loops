import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { createReviewerScratch, removeReviewerScratch } from "../../src/lib/reviewer-scratch.mjs";
import {
  createLinkedWorkTree,
  createTempRepo,
  exists,
  removePath,
  symlinkOrSkip,
} from "../runtime-helpers.mjs";

const untracked = async (cwd) =>
  (await execa("git", ["status", "--porcelain", "--untracked-files=all"], { cwd })).stdout;

// Usefulness: verifies the scratch folder is writable, sits in the work tree, and never shows as an
// unignored untracked file, so the mutation check cannot flag the reviewer for using it (#920).
test("a created scratch folder is writable and invisible to git status", async () => {
  const repo = await createTempRepo();
  try {
    const dir = await createReviewerScratch(repo);
    expect(dir.startsWith(join(await realpath(repo), ".agent-loop"))).toBe(true);
    await mkdir(join(dir, "cache"));
    await writeFile(join(dir, "cache", "out.txt"), "probe\n");
    expect(await untracked(repo)).toBe("");
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the folder stays ignored in a linked work tree, where `.git` is a file, with
// no ignore rule in the target repository, because the folder carries its own ignore rule (#920).
test("a created scratch folder is invisible to git status in a linked work tree", async () => {
  const { base, linked } = await createLinkedWorkTree();
  try {
    expect((await lstat(join(linked, ".git"))).isFile()).toBe(true);
    const dir = await createReviewerScratch(linked);
    await writeFile(join(dir, "out.txt"), "probe\n");
    expect(await untracked(linked)).toBe("");
  } finally {
    await removePath(base);
  }
});

// Usefulness: verifies the folder is created from a subdirectory at the work tree root, so the
// path does not depend on the directory the run started in (#920).
test("a scratch folder from a subdirectory lands under the work tree root", async () => {
  const repo = await createTempRepo();
  try {
    await mkdir(join(repo, "sub"));
    const dir = await createReviewerScratch(join(repo, "sub"));
    expect(dir.startsWith(join(await realpath(repo), ".agent-loop"))).toBe(true);
    expect(await exists(dir)).toBe(true);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies removal deletes the folder with its contents and leaves no empty parent
// folder behind in the work tree (#920).
test("removing a scratch folder deletes it and its empty parents", async () => {
  const repo = await createTempRepo();
  try {
    const dir = await createReviewerScratch(repo);
    await mkdir(join(dir, "cache"));
    await writeFile(join(dir, "cache", "out.txt"), "probe\n");
    await removeReviewerScratch(dir);
    expect(await exists(dir)).toBe(false);
    expect((await readdir(repo)).includes(".agent-loop")).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies removal never follows a symbolic link or a junction inside the folder, so
// pnpm junctions are unlinked and the target content outside the folder survives (#920).
test("removing a scratch folder does not follow a link inside it", async (ctx) => {
  const repo = await createTempRepo();
  const outside = await mkdtemp(join(tmpdir(), "scratch-outside-"));
  try {
    await writeFile(join(outside, "keep.txt"), "keep\n");
    const dir = await createReviewerScratch(repo);
    await symlinkOrSkip(ctx, outside, join(dir, "link"), "junction");
    await removeReviewerScratch(dir);
    expect(await exists(dir)).toBe(false);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  } finally {
    await removePath(repo);
    await removePath(outside);
  }
});

// Usefulness: verifies removal unlinks the folder when the folder itself became a link, without
// deleting the link target (#920).
test("removing a scratch folder that became a link keeps the link target", async (ctx) => {
  const repo = await createTempRepo();
  const outside = await mkdtemp(join(tmpdir(), "scratch-outside-"));
  try {
    await writeFile(join(outside, "keep.txt"), "keep\n");
    const dir = await createReviewerScratch(repo);
    await removePath(dir);
    await symlinkOrSkip(ctx, outside, dir, "junction");
    await removeReviewerScratch(dir);
    expect(await exists(join(outside, "keep.txt"))).toBe(true);
  } finally {
    await removePath(repo);
    await removePath(outside);
  }
});

// Usefulness: verifies a failed removal warns and does not throw, so a refused delete never fails
// or halts the run (#920).
test.skipIf(process.platform === "win32")("a failed removal warns and does not throw", async () => {
  const repo = await createTempRepo();
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  let dir;
  try {
    dir = await createReviewerScratch(repo);
    await writeFile(join(dir, "out.txt"), "probe\n");
    await chmod(dir, 0o500);
    await expect(removeReviewerScratch(dir)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join("\n")).toContain("scratch");
  } finally {
    warn.mockRestore();
    if (dir) await chmod(dir, 0o700);
    await removePath(repo);
  }
});

// Usefulness: verifies a failed creation returns null with a warning instead of throwing, so the
// turn runs without a scratch folder (#920).
test("a failed creation returns null", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const notRepo = await mkdtemp(join(tmpdir(), "scratch-not-repo-"));
    try {
      expect(await createReviewerScratch(notRepo)).toBeNull();
    } finally {
      await removePath(notRepo);
    }
  } finally {
    warn.mockRestore();
  }
});

// Usefulness: verifies removal refuses, with a warning and no deletion, when `.agent-loop` or
// `.agent-loop/rev` was replaced by a link or junction to an outside folder, so a reviewer cannot
// steer the removal onto content outside the scratch folder (acceptance #920).
for (const parent of [".agent-loop", join(".agent-loop", "rev")]) {
  test(`removal refuses when ${parent} became a link`, async (ctx) => {
    const repo = await createTempRepo();
    const outside = await mkdtemp(join(tmpdir(), "scratch-outside-"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const dir = await createReviewerScratch(repo);
      const real = await realpath(repo);
      const id = basename(dir);
      // The outside folder mirrors the layout below the replaced parent, so a removal that
      // follows the link deletes the sentinel.
      const mirrored = join(outside, ...dir.slice(join(real, parent).length + 1).split(sep));
      await mkdir(mirrored, { recursive: true });
      await writeFile(join(mirrored, "sentinel.txt"), "keep\n");
      await removePath(join(real, parent));
      await symlinkOrSkip(ctx, outside, join(real, parent), "junction");
      expect(id).toBe(basename(mirrored));
      await expect(removeReviewerScratch(dir)).resolves.toBeUndefined();
      expect(await readFile(join(mirrored, "sentinel.txt"), "utf8")).toBe("keep\n");
      expect(await exists(outside)).toBe(true);
      expect(warn.mock.calls.flat().join("\n")).toContain("link");
    } finally {
      warn.mockRestore();
      await removePath(repo);
      await removePath(outside);
    }
  });
}
