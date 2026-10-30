import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { sha256 } from "../../src/lib/hash.mjs";
import { cancelOnSigInt } from "../../src/lib/sigint.mjs";
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
import {
  ABORT_KILL_TEST_TIMEOUT_MS,
  BOUND_KILL_TEST_TIMEOUT_MS,
  expectAbortKillsShim,
  createTempRepo,
  expectBoundKillsShim,
  removePath,
  withGitHangingAfter,
} from "../runtime-helpers.mjs";

// Runs `onFirstChunk` once, after the consumer takes the first chunk of the next streamed file
// read, so a test can change the file or cancel the read while the read is in progress.
const readHook = vi.hoisted(() => ({ onFirstChunk: null, stream: null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createReadStream: (...args) => {
      const stream = actual.createReadStream(...args);
      return (async function* () {
        readHook.stream = stream;
        for await (const chunk of stream) {
          yield chunk;
          const hook = readHook.onFirstChunk;
          readHook.onFirstChunk = null;
          hook?.();
        }
      })();
    },
  };
});

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
test(
  "assertGitWorkTree refuses a probe that outlasts its bound",
  async () => {
    // Termination only: the bound value is proved in spawn-bounds.test.mjs, so the
    // waits here are ceilings that load cannot reach (issue #373).
    await expectBoundKillsShim("git", (timeoutMs) =>
      expect(assertGitWorkTree(tmpdir(), { timeoutMs })).rejects.toThrow(
        /validation did not complete within its bound/,
      ),
    );
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies a cancel ends a hung work-tree probe and marks the refusal as a cancel, so
// `role dispatch` and the headless run keep exit 130 instead of exit 1 (#729).
test(
  "assertGitWorkTree ends a hung probe on cancel and reports a cancel",
  async () => {
    const error = await expectAbortKillsShim("git", (signal) =>
      assertGitWorkTree(tmpdir(), { signal }).catch((err) => err),
    );
    expect(error).toBeInstanceOf(SnapshotError);
    expect(error.isCanceled).toBe(true);
  },
  ABORT_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies a hung `git` read in the snapshot ends at its bound with a SnapshotError, so
// a stuck child cannot hang the turn (#729).
test(
  "snapshot refuses a git read that outlasts its bound",
  async () => {
    const error = await expectBoundKillsShim("git", (timeoutMs) =>
      snapshot(tmpdir(), { timeoutMs }).catch((err) => err),
    );
    expect(error).toBeInstanceOf(SnapshotError);
    expect(error.message).toMatch(/timed out/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies a cancel ends a hung `git` read in the snapshot and marks the error as a
// cancel, which the caller maps to exit 130 (#729).
test(
  "snapshot ends a hung git read on cancel and reports a cancel",
  async () => {
    const error = await expectAbortKillsShim("git", (signal) =>
      snapshot(tmpdir(), { signal }).catch((err) => err),
    );
    expect(error).toBeInstanceOf(SnapshotError);
    expect(error.isCanceled).toBe(true);
  },
  ABORT_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies the post-turn snapshot ignores a cancel, so a turn that was canceled after it
// wrote a file still reports the changed path (#729).
test("withMutationCheck keeps the changed-path evidence after a cancel", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  try {
    await expect(
      withMutationCheck(
        repo,
        "worker",
        async () => {
          await writeFile(join(repo, "written.txt"), "x\n");
          controller.abort();
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "MutationError", paths: ["written.txt"] });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a second cancel ends a hung evidence snapshot at once and reports the
// evidence as not captured, never as unchanged, while the first cancel alone leaves it running (#729).
test.skipIf(process.platform === "win32")(
  "a second cancel ends a hung evidence snapshot and reports it as not captured",
  async () => {
    const repo = await createTempRepo();
    try {
      await withGitHangingAfter(4, async ({ hungPid }) => {
        const first = new AbortController();
        const second = new AbortController();
        const pending = withMutationCheck(
          repo,
          "worker",
          async () => {
            first.abort();
          },
          { signal: first.signal, forceSignal: second.signal },
        ).catch((err) => err);
        const pid = await hungPid();
        // The first cancel alone does not end the evidence snapshot.
        const early = await Promise.race([pending, new Promise((r) => setTimeout(r, 700, "open"))]);
        expect(early).toBe("open");
        second.abort();
        const error = await Promise.race([
          pending,
          new Promise((_, reject) =>
            setTimeout(reject, 10_000, new Error("the evidence snapshot did not end")),
          ),
        ]);
        expect(error).toBeInstanceOf(SnapshotError);
        expect(error.isCanceled).toBe(true);
        expect(error.message).toMatch(/not captured/);
        expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      await removePath(repo);
    }
  },
  60_000,
);

// Usefulness: verifies the second SIGINT ends the evidence snapshot without exiting the process, so
// the canceled "not captured" result reaches the caller to write, and the exit with code 130 follows
// when the run releases its SIGINT handler (#729).
test.skipIf(process.platform === "win32")(
  "the second SIGINT ends the evidence snapshot and delays the exit until the run is done",
  async () => {
    const repo = await createTempRepo();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const controller = new AbortController();
    const remove = cancelOnSigInt(controller);
    try {
      await withGitHangingAfter(4, async ({ hungPid }) => {
        const pending = withMutationCheck(
          repo,
          "worker",
          async () => {
            process.emit("SIGINT");
          },
          { signal: controller.signal },
        ).catch((err) => err);
        await hungPid();
        process.emit("SIGINT");
        const error = await Promise.race([
          pending,
          new Promise((_, reject) =>
            setTimeout(reject, 10_000, new Error("the evidence snapshot did not end")),
          ),
        ]);
        expect(error).toBeInstanceOf(SnapshotError);
        expect(error.isCanceled).toBe(true);
        expect(error.message).toMatch(/not captured/);
        expect(exit).not.toHaveBeenCalled();
        remove();
        expect(exit).toHaveBeenCalledWith(130);
      });
    } finally {
      remove();
      exit.mockRestore();
      await removePath(repo);
    }
  },
  60_000,
);

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
    await writeFile(join(repo, "init.txt"), "modified content\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["init.txt"]);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies diffSnapshots detects when an already-dirty file is modified again.
test("diffSnapshots detects when already-dirty file is modified again", async () => {
  const repo = await createTempRepo();
  try {
    await writeFile(join(repo, "init.txt"), "first dirty modification\n");
    const s1 = await snapshot(repo);
    await writeFile(join(repo, "init.txt"), "second dirty modification\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["init.txt"]);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies diffSnapshots detects when a renamed dirty file is modified.
test("diffSnapshots detects when renamed dirty file is modified", async () => {
  const repo = await createTempRepo();
  try {
    await execa("git", ["mv", "init.txt", "renamed.txt"], { cwd: repo });
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

// Usefulness: verifies acceptance #885 — a write to an ignored path inside the repository is no
// mutation, so a reviewer can keep probe output under `node_modules/.cache/<name>`.
test("diffSnapshots reports no change for a write to an ignored path", async () => {
  const repo = await createTempRepo();
  try {
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await execa("git", ["add", ".gitignore"], { cwd: repo });
    await execa("git", ["commit", "-m", "ignore node_modules"], { cwd: repo });
    const s1 = await snapshot(repo);
    await mkdir(join(repo, "node_modules", ".cache", "probe"), { recursive: true });
    await writeFile(join(repo, "node_modules", ".cache", "probe", "out.txt"), "probe\n");
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual([]);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies diffSnapshots detects deleted file.
test("diffSnapshots detects file deletion", async () => {
  const repo = await createTempRepo();
  try {
    const s1 = await snapshot(repo);
    await rm(join(repo, "init.txt"));
    const s2 = await snapshot(repo);
    expect(diffSnapshots(s1, s2)).toEqual(["init.txt"]);
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
    await execa("git", ["update-index", "--cacheinfo", "100644", hash.trim(), "init.txt"], {
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

// Usefulness: verifies a falsy thrown value is rethrown, so a turn that throws null or undefined never returns as a success.
test.each([null, undefined, 0, ""])(
  "withMutationCheck rethrows falsy thrown value %j",
  async (thrown) => {
    const repo = await createTempRepo();
    try {
      await expect(
        withMutationCheck(repo, "orchestrator", async () => {
          throw thrown;
        }),
      ).rejects.toBe(thrown);
    } finally {
      await removePath(repo);
    }
  },
);

// Usefulness: verifies a detected mutation still wins over a falsy thrown value.
test("withMutationCheck prioritizes MutationError when inner function throws a falsy value", async () => {
  const repo = await createTempRepo();
  try {
    await expect(
      withMutationCheck(repo, "reviewer", async () => {
        await writeFile(join(repo, "dirty.txt"), "leaked\n");
        throw null;
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
    await writeFile(join(repo, "init.txt"), "first dirty modification\n");
    const s1 = await snapshot(sub);
    await writeFile(join(repo, "init.txt"), "second dirty modification\n");
    const s2 = await snapshot(sub);
    expect(diffSnapshots(s1, s2)).toEqual(["init.txt"]);
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

// Usefulness: verifies a staged gitlink makes the snapshot inexact. Needs real
// `git`: only `git status` decides whether a gitlink is reported at all, so an
// in-memory answer cannot show that the status call hides submodule changes. The
// directory has no content hash, so the review gate must refuse it (issue #218,
// issue #272, issue #448).
test("snapshot reports a staged gitlink as an entry with no hash, so it is inexact", async () => {
  const repo = await createTempRepo();
  try {
    const before = await snapshot(repo);
    expect(reviewedState(before).exact).toBe(true);

    await mkdir(join(repo, "sub"));
    await execa("git", ["update-index", "--add", "--cacheinfo", "160000", before.head, "sub"], {
      cwd: repo,
    });
    const after = await snapshot(repo);

    expect(after.workTree).toEqual([{ path: "sub", status: "A ", hash: null }]);
    expect(reviewedState(after).exact).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a change to a file inside a new untracked directory is
// detected. Needs real `git`: only `git status` decides whether a new directory is
// reported as one entry or as each file in it, so an in-memory answer cannot show
// that the status call lists the files (issue #460).
test("snapshot lists each file inside a new untracked directory, so a change to one is detected", async () => {
  const repo = await createTempRepo();
  try {
    await mkdir(join(repo, "newdir"));
    await writeFile(join(repo, "newdir", "a.txt"), "one\n");
    const before = await snapshot(repo);

    expect(before.workTree.map((e) => e.path)).toEqual(["newdir/a.txt"]);

    await writeFile(join(repo, "newdir", "a.txt"), "two\n");
    const after = await snapshot(repo);

    expect(diffSnapshots(before, after)).toEqual(["newdir/a.txt"]);
  } finally {
    await removePath(repo);
  }
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

// Usefulness: verifies requirement "an aborted signal stops a read before it starts" (issue #1225):
// the call rejects with an abort error instead of hashing. It shows no handle release for a read
// already in flight.
test("sha256File rejects with an abort error when its signal is already aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-sha256-"));
  try {
    const file = join(dir, "file.txt");
    await writeFile(file, "content\n");
    await expect(sha256File(file, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
  } finally {
    await removePath(dir);
  }
});

// Usefulness: verifies requirement "digests stay byte-identical" (issue #1241): a file that spans
// several read chunks hashes to the whole-content digest, so recorded snapshot digests still match.
test("sha256File hashes a multi-chunk file to the whole-content digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-sha256-"));
  try {
    const file = join(dir, "large.bin");
    const content = Buffer.alloc(512 * 1024, "abcdefghij");
    await writeFile(file, content);
    await expect(sha256File(file)).resolves.toBe(sha256(content));
  } finally {
    await removePath(dir);
  }
});

// Usefulness: verifies requirement "a file that grows during the read keeps the digest of its
// initial bytes" (issue #1241), as the whole-file read did, so a concurrent append never changes
// a recorded digest.
test("sha256File digests only the initial bytes of a file that grows during the read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-sha256-"));
  try {
    const file = join(dir, "growing.bin");
    const content = Buffer.alloc(1024 * 1024, "abcdefghij");
    await writeFile(file, content);
    readHook.onFirstChunk = () => appendFileSync(file, "late");
    await expect(sha256File(file)).resolves.toBe(sha256(content));
  } finally {
    readHook.onFirstChunk = null;
    await removePath(dir);
  }
});

// Usefulness: verifies requirement "an abort during the read ends the stream and rejects" (issue
// #1241): the abort lands while the stream is reading, so the call rejects instead of returning a
// digest and the stream closes.
test("sha256File ends the stream and rejects when its signal aborts during the read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-sha256-"));
  try {
    const file = join(dir, "large.bin");
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024, "x"));
    const controller = new AbortController();
    readHook.onFirstChunk = () => controller.abort();
    await expect(sha256File(file, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(readHook.stream.destroyed).toBe(true);
  } finally {
    readHook.onFirstChunk = null;
    await removePath(dir);
  }
});

// Usefulness: verifies snapshot() wraps file-hash read failures in SnapshotError so runChild treats them as fatal.
test.skipIf(!canSimulateReadFailure)(
  "snapshot rejects with SnapshotError when a tracked file is unreadable",
  async () => {
    const repo = await createTempRepo();
    try {
      const file = join(repo, "init.txt");
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
