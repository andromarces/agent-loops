import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { execa } from "execa";
import {
  MutationError,
  SnapshotError,
  assertGitWorkTree,
  diffSnapshots,
  reviewedState,
  sha256File,
  snapshot,
  withMutationCheck,
} from "../../src/lib/snapshot.mjs";
import { expectBoundKillsShim, removePath } from "../runtime-helpers.mjs";

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
    await removePath(repo);
    await removePath(nonRepo);
  }
});

// Usefulness: verifies the work-tree probe is bounded and terminates its child
// when the bound expires, on Windows and on macOS. A real process is the only way
// to check that a slow `git` cannot add its own time to a caller's total limit,
// because every other test uses a real fast `git` (issue #329).
test("assertGitWorkTree refuses a probe that outlasts its bound", async () => {
  // The verdict rests on the child's recorded pid, so a shim that starts late
  // under load cannot slip past a fixed wait (issue #373). The timeout covers the
  // three bounds the helper may try in turn.
  await expectBoundKillsShim("git", (timeoutMs) =>
    expect(assertGitWorkTree(tmpdir(), { timeoutMs })).rejects.toThrow(
      /validation did not complete within its bound/,
    ),
  );
}, 30_000);

// Usefulness: verifies diffSnapshots detects when nothing changes.
test("diffSnapshots returns empty list when no change occurred", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual([]);
  } finally {
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
  }
});

// Usefulness: verifies snapshot() fails loudly instead of returning a fake-clean snapshot outside a work tree.
test("snapshot rejects with SnapshotError when cwd is not a Git work tree", async () => {
  const nonRepo = await mkdtemp(join(tmpdir(), "non-git-"));
  try {
    await expect(snapshot(nonRepo)).rejects.toThrow(SnapshotError);
  } finally {
    await removePath(nonRepo);
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
    await removePath(dir);
  }
});

// Usefulness: verifies reviewedState reports clean only for a work tree with no
// entries (issue #217).
test("reviewedState reports clean only for an empty work tree", () => {
  expect(reviewedState({ head: "abc", indexHash: "idx", workTree: [] })).toMatchObject({
    clean: true,
    exact: true,
  });
  const dirty = reviewedState({
    head: "abc",
    indexHash: "idx",
    workTree: [{ path: "a.txt", status: " M", hash: "h" }],
  });
  expect(dirty.clean).toBe(false);
});

// Usefulness: verifies a deletion keeps exact true while another null-hash
// entry, such as a submodule, makes exact false, so the parent knows when the
// digest is exhaustive (issue #217).
test("reviewedState treats a deletion as exact and any other null hash as inexact", () => {
  const base = { head: "abc", indexHash: "idx" };
  const deletion = reviewedState({
    ...base,
    workTree: [{ path: "gone.txt", status: " D", hash: null }],
  });
  expect(deletion.exact).toBe(true);
  const submodule = reviewedState({
    ...base,
    workTree: [{ path: "sub", status: " M", hash: null }],
  });
  expect(submodule.exact).toBe(false);
});

// Usefulness: verifies the digest separates two different uncommitted states at
// the same head and repeats for the same state (issue #217).
test("reviewedState digest separates different states and repeats for the same state", () => {
  const snap = (hash) => ({
    head: "abc",
    indexHash: "idx",
    workTree: [{ path: "a.txt", status: " M", hash }],
  });
  const first = reviewedState(snap("h1"));
  expect(reviewedState(snap("h1")).digest).toBe(first.digest);
  expect(reviewedState(snap("h2")).digest).not.toBe(first.digest);
});

// Platform note: Windows refuses symlink creation without developer mode or an
// elevated token, so the symlink cases are skipped on Windows.
const canCreateSymlink = process.platform !== "win32";

// Usefulness: verifies two dangling symlinks with different targets produce
// different digests, where the old content-following hash collapsed both to
// null (issue #217).
test.skipIf(!canCreateSymlink)(
  "two dangling symlink targets produce different digests",
  async () => {
    const repo = await createTempRepo();
    try {
      const link = join(repo, "link");
      await symlink("missing-a", link);
      const a = reviewedState(await snapshot(repo));
      await rm(link);
      await symlink("missing-b", link);
      const b = reviewedState(await snapshot(repo));
      expect(a.exact).toBe(true);
      expect(b.exact).toBe(true);
      expect(a.digest).not.toBe(b.digest);
    } finally {
      await removePath(repo);
    }
  },
);

// Usefulness: verifies two symlinks with different target text produce
// different digests even when the targets hold identical content, so the link
// itself has a content identity (issue #217).
test.skipIf(!canCreateSymlink)(
  "symlinks with different targets and equal content differ",
  async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(join(repo, "target-a.txt"), "same\n");
      await writeFile(join(repo, "target-b.txt"), "same\n");
      const link = join(repo, "link");
      await symlink("target-a.txt", link);
      const a = reviewedState(await snapshot(repo));
      await rm(link);
      await symlink("target-b.txt", link);
      const b = reviewedState(await snapshot(repo));
      expect(a.digest).not.toBe(b.digest);
    } finally {
      await removePath(repo);
    }
  },
);

// Usefulness: verifies a symlink and a regular file holding the same bytes do
// not share a digest, closing the collision that untagged link text created
// (issue #217).
test.skipIf(!canCreateSymlink)(
  "a symlink and a regular file with the same bytes differ",
  async () => {
    const repo = await createTempRepo();
    try {
      const path = join(repo, "x");
      await symlink("foo", path);
      const linkState = reviewedState(await snapshot(repo));
      await rm(path);
      await writeFile(path, "foo");
      const fileState = reviewedState(await snapshot(repo));
      expect(linkState.digest).not.toBe(fileState.digest);
    } finally {
      await removePath(repo);
    }
  },
);

// Usefulness: verifies the reviewer mutation check detects a changed symlink
// target, the case the old content-following hash missed for dangling links
// (issue #217).
test.skipIf(!canCreateSymlink)(
  "withMutationCheck fails when a symlink target changes",
  async () => {
    const repo = await createTempRepo();
    try {
      const link = join(repo, "link");
      await symlink("missing-a", link);
      await expect(
        withMutationCheck(repo, "reviewer", async () => {
          await rm(link);
          await symlink("missing-b", link);
          return "done";
        }),
      ).rejects.toThrow(MutationError);
    } finally {
      await removePath(repo);
    }
  },
);

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
    await removePath(dir);
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
      await removePath(repo);
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
    await removePath(repo);
  }
});
