import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { identityEqual, pathIdentity, removeDirectoryWithoutLinks } from "../../src/batch/git.mjs";
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
