import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { execa } from "execa";
import {
  MutationError,
  assertGitWorkTree,
  diffSnapshots,
  snapshot,
  withMutationCheck,
} from "../../src/lib/snapshot.mjs";

async function createTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-snap-test-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.name", "Tester"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(join(dir, "initial.txt"), "hello world\n");
  await execa("git", ["add", "initial.txt"], { cwd: dir });
  await execa("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

// Usefulness: verifies assertGitWorkTree passes inside a git repository and rejects a non-git directory.
test("assertGitWorkTree validates git directory", async () => {
  const repo = await createTempRepo();
  const nonRepo = await mkdtemp(join(tmpdir(), "non-git-"));
  try {
    await expect(assertGitWorkTree(repo)).resolves.toBeUndefined();
    await expect(assertGitWorkTree(nonRepo)).rejects.toThrow();
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(nonRepo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects when nothing changes.
test("diffSnapshots returns empty list when no change occurred", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual([]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects modified tracked file.
test("diffSnapshots detects modified tracked file", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    await writeFile(join(repo, "initial.txt"), "modified content\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["initial.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects untracked file addition.
test("diffSnapshots detects untracked file addition", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    await writeFile(join(repo, "newfile.txt"), "new file\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["newfile.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects deleted file.
test("diffSnapshots detects file deletion", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    await rm(join(repo, "initial.txt"));
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["initial.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects index change via update-index.
test("diffSnapshots detects index modification via update-index", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    const { stdout: hash } = await execa("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "staged blob content\n",
    });
    await execa("git", ["update-index", "--cacheinfo", "100644", hash.trim(), "initial.txt"], {
      cwd: repo,
    });
    const s2 = await snapshot(repo);
    const diff = diffSnapshots(s1, s2);
    expect(diff).toContain("<index>");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects HEAD change on commit.
test("diffSnapshots detects commit HEAD change", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    await writeFile(join(repo, "file2.txt"), "data\n");
    await execa("git", ["add", "file2.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "second commit"], { cwd: repo });
    const s2 = await snapshot(repo);
    const diff = diffSnapshots(s1, s2);
    expect(diff).toContain("<HEAD>");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies withMutationCheck executes callback and throws MutationError on modification without reverting files.
test("withMutationCheck detects mutation and throws MutationError", async () => {
  const repo = await createTempRepo();
  try {
    await expect(
      withMutationCheck(repo, "reviewer", async () => {
        await writeFile(join(repo, "dirty.txt"), "leaked\n");
        return "result";
      }),
    ).rejects.toThrow(MutationError);

    // Verify file still exists (no revert rule)
    const s = await snapshot(repo);
    expect(s.workTree.some((e) => e.path === "dirty.txt")).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies withMutationCheck retains MutationError even if inner function throws.
test("withMutationCheck prioritizes MutationError when inner function throws", async () => {
  const repo = await createTempRepo();
  try {
    await expect(
      withMutationCheck(repo, "reviewer", async () => {
        await writeFile(join(repo, "dirty.txt"), "leaked\n");
        throw new Error("inner failure");
      }),
    ).rejects.toThrow(MutationError);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
