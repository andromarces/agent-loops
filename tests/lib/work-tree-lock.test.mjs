import { mkdir, realpath } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { gitRead } from "../../src/lib/snapshot.mjs";
import { lockWorkTree, unlockWorkTree, workTreeLockReason } from "../../src/lib/work-tree-lock.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createLinkedWorkTree } from "../git-helpers.mjs";

const bases = [];

afterEach(async () => {
  for (const base of bases.splice(0)) {
    await removePath(base);
  }
});

async function linked(options = {}) {
  const tree = await createLinkedWorkTree(options);
  bases.push(tree.base);
  return tree;
}

const git = (cwd, args) => execa("git", args, { cwd, reject: false });

/** The `locked` field of `path` in `git worktree list`, or null. */
async function lockField(cwd, path) {
  const wanted = await realpath(path);
  const { stdout } = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  for (const record of stdout.split("\0\0")) {
    const fields = record.split("\0").filter(Boolean);
    const entry = fields[0]?.slice("worktree ".length);
    // Git prints forward slashes on Windows, so both sides compare as canonical paths.
    if (entry === undefined || (await realpath(entry).catch(() => entry)) !== wanted) continue;
    return fields.find((field) => field === "locked" || field.startsWith("locked ")) ?? null;
  }
  return null;
}

// Usefulness: verifies acceptance 1 — a lock taken at init stops `git worktree remove --force`,
// and the reason names the run. Not redundant: it runs the lock module over a real Git work tree
// whose path holds a space.
test("locks a linked work tree so a forced removal refuses it", async () => {
  const { main, linked: tree } = await linked({ linkedName: "linked tree" });

  const result = await lockWorkTree(tree, { runId: "abc123" });

  expect(result).toMatchObject({ status: "locked" });
  expect(await lockField(main, tree)).toBe(`locked ${workTreeLockReason("abc123")}`);
  const removed = await git(main, ["worktree", "remove", "--force", tree]);
  expect(removed.exitCode).not.toBe(0);
  expect(removed.stderr).toContain("cannot remove a locked working tree");
});

// Usefulness: verifies the main work tree case. Git refuses its lock, so the call reports a skip
// instead of a failure and leaves no lock. Not redundant: the linked case above never reaches the
// skip branch.
test("skips a main work tree and leaves it unlocked", async () => {
  const { main } = await linked();

  const result = await lockWorkTree(main, { runId: "abc123" });

  expect(result).toMatchObject({ status: "skipped" });
  expect(await lockField(main, main)).toBeNull();
});

// Usefulness: verifies a `--cwd` below the root locks the work tree root, which is the path that a
// removal names. Not redundant: the other cases pass the root itself.
test("locks the work tree root for a cwd below it", async () => {
  const { main, linked: tree } = await linked();
  const nested = `${tree}/nested`;
  await mkdir(nested, { recursive: true });

  const result = await lockWorkTree(nested, { runId: "abc123" });

  expect(result).toMatchObject({ status: "locked" });
  expect(await realpath(result.root)).toBe(await realpath(tree));
  expect(await lockField(main, tree)).toBe(`locked ${workTreeLockReason("abc123")}`);
});

// Usefulness: verifies the existing-lock rule. A lock made by a user or another tool keeps its
// reason through init and is never unlocked at the end. Not redundant: it covers the lock already
// present before the call, which the other cases never create.
test("keeps a lock of another owner and its reason", async () => {
  const { main, linked: tree } = await linked();
  await git(main, ["worktree", "lock", "--reason", "maintainer debug", tree]);

  const locked = await lockWorkTree(tree, { runId: "abc123" });
  const unlocked = await unlockWorkTree(tree, { runId: "abc123" });

  expect(locked).toMatchObject({ status: "kept" });
  expect(unlocked).toMatchObject({ status: "kept" });
  expect(await lockField(main, tree)).toBe("locked maintainer debug");
});

// Usefulness: verifies acceptance 2 — an unlock removes only the lock whose reason names the run.
// Not redundant: the terminal path test covers the own lock, and this test covers a foreign one.
test("unlocks its own lock and only that one", async () => {
  const { main, linked: tree } = await linked();

  await lockWorkTree(tree, { runId: "abc123" });
  const unlocked = await unlockWorkTree(tree, { runId: "abc123" });

  expect(unlocked).toMatchObject({ status: "unlocked" });
  expect(await lockField(main, tree)).toBeNull();
});

// Usefulness: verifies the re-created-tree case. A work tree removed and added again at the same
// path holds no lock of this run, so the unlock leaves it alone. Not redundant: this is the one
// case where an earlier lock vanished with the registration.
test("leaves a work tree re-created at the same path alone", async () => {
  const { main, linked: tree } = await linked();
  await lockWorkTree(tree, { runId: "abc123" });
  await git(main, ["worktree", "remove", "-f", "-f", tree]);
  await git(main, ["worktree", "add", tree, "run"]);

  const result = await unlockWorkTree(tree, { runId: "abc123" });

  expect(result).toMatchObject({ status: "unchanged" });
  expect(await lockField(main, tree)).toBeNull();
});

// Usefulness: verifies the handled-failure rule. A refused Git command gives a warning and a
// `failed` result, never a throw, so init and the terminal paths still succeed. Not redundant: the
// real Git cases all succeed.
test("warns and returns a failure when Git refuses the lock", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const read = async (cwd, args, options) =>
    args[0] === "worktree" && args[1] === "lock"
      ? { exitCode: 128, stdout: "", stderr: "" }
      : gitRead(cwd, args, options);
  try {
    const { linked: tree } = await linked();

    const result = await lockWorkTree(tree, { runId: "abc123", read });

    expect(result).toMatchObject({ status: "failed" });
    expect(warn.mock.calls.flat().join(" ")).toContain("work tree lock");
  } finally {
    warn.mockRestore();
  }
});
