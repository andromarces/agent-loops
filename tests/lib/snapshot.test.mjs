import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { execa } from "execa";
import {
  MutationError,
  SnapshotError,
  assertGitWorkTree,
  diffSnapshots,
  sha256File,
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

// Usefulness: verifies diffSnapshots detects when an already-dirty file is modified again.
test("diffSnapshots detects when already-dirty file is modified again", async () => {
  const repo = await createTempRepo();
  try {
    await writeFile(join(repo, "initial.txt"), "first dirty modification\n");
    const s1 = await snapshot(repo);
    await writeFile(join(repo, "initial.txt"), "second dirty modification\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["initial.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies diffSnapshots detects when a renamed dirty file is modified.
test("diffSnapshots detects when renamed dirty file is modified", async () => {
  const repo = await createTempRepo();
  try {
    await execa("git", ["mv", "initial.txt", "renamed.txt"], { cwd: repo });
    const s1 = await snapshot(repo);
    await writeFile(join(repo, "renamed.txt"), "modified renamed file content\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["renamed.txt"]);
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

// Usefulness: verifies snapshot() resolves root-relative paths so a subdirectory cwd still hashes root files.
test("snapshot from subdirectory detects second edit to already-modified root file", async () => {
  const repo = await createTempRepo();
  try {
    const sub = join(repo, "sub");
    await mkdir(sub);
    await writeFile(join(repo, "initial.txt"), "first dirty modification\n");
    const s1 = await snapshot(sub);
    await writeFile(join(repo, "initial.txt"), "second dirty modification\n");
    const s2 = await snapshot(sub);
    expect(diffSnapshots(s1, s2)).toEqual(["initial.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies snapshot() scopes the index hash to the whole repository, not just the cwd subtree.
test("snapshot from subdirectory detects index change outside the subdirectory", async () => {
  const repo = await createTempRepo();
  try {
    const sub = join(repo, "sub");
    await mkdir(sub);
    const s1 = await snapshot(sub);
    await writeFile(join(repo, "outside.txt"), "staged elsewhere\n");
    await execa("git", ["add", "outside.txt"], { cwd: repo });
    const s2 = await snapshot(sub);
    expect(s2.indexHash).not.toBe(s1.indexHash);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies snapshot() fails loudly instead of returning a fake-clean snapshot outside a work tree.
test("snapshot rejects with SnapshotError when cwd is not a Git work tree", async () => {
  const nonRepo = await mkdtemp(join(tmpdir(), "non-git-"));
  try {
    await expect(snapshot(nonRepo)).rejects.toThrow(SnapshotError);
  } finally {
    await rm(nonRepo, { recursive: true, force: true });
  }
});

// Usefulness: verifies snapshot() tolerates a repository with no commits (unborn HEAD is not an error).
test("snapshot succeeds in repository with no commits and reports unborn head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-unborn-"));
  await execa("git", ["init"], { cwd: dir });
  try {
    const s = await snapshot(dir);
    expect(s.head).toBe("unborn");
    expect(s.workTree).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Platform note: Windows ignores POSIX mode bits, so read-denial cannot be simulated there.
const canSimulateReadFailure = process.platform !== "win32";

// Usefulness: verifies sha256File distinguishes unreadable files (error) from absent files (null).
test.skipIf(!canSimulateReadFailure)("sha256File rethrows non-ENOENT read errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-sha256-"));
  try {
    const file = join(dir, "unreadable.txt");
    await writeFile(file, "content\n");
    await chmod(file, 0o000);
    try {
      await expect(sha256File(file)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(file, 0o644);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Usefulness: verifies snapshot() wraps file-hash read failures in SnapshotError so runChild treats them as fatal.
test.skipIf(!canSimulateReadFailure)(
  "snapshot rejects with SnapshotError when a tracked file is unreadable",
  async () => {
    const repo = await createTempRepo();
    try {
      const file = join(repo, "initial.txt");
      await chmod(file, 0o000);
      try {
        await expect(snapshot(repo)).rejects.toMatchObject({ name: "SnapshotError" });
      } finally {
        await chmod(file, 0o644);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

// Usefulness: verifies a failed post-turn snapshot wins over the agent error and attaches the agent error as cause.
test("withMutationCheck throws SnapshotError with agent error as cause when post-turn snapshot fails", async () => {
  const repo = await createTempRepo();
  try {
    const agentError = new Error("agent blew up");
    await expect(
      withMutationCheck(repo, "reviewer", async () => {
        await rm(join(repo, ".git"), { recursive: true, force: true });
        throw agentError;
      }),
    ).rejects.toMatchObject({
      name: "SnapshotError",
      cause: agentError,
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
