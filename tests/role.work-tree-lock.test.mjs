import { execa } from "execa";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ExecError } from "../src/lib/exec.mjs";
import { cwdHash } from "../src/lib/runstate.mjs";
import { workTreeLockReason } from "../src/lib/work-tree-lock.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  repos,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createLinkedWorkTree } from "./git-helpers.mjs";
import { SUMMARY } from "./run-fixtures.mjs";

afterEach(cleanup);

const git = (cwd, args) => execa("git", args, { cwd, reject: false });

async function linked() {
  const tree = await createLinkedWorkTree();
  repos.push(tree.base);
  return tree;
}

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

const removeForced = (main, tree) => git(main, ["worktree", "remove", "--force", tree]);

const finish = (tree) =>
  executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], tree), {
    stdin: async () => JSON.stringify(SUMMARY),
  });

const abort = (tree, args = ["--reason", "done"]) =>
  executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", ...args], tree), {});

// Usefulness: verifies acceptance 1 and 2. Init makes a forced removal refuse the work tree, and a
// terminal finish makes the documented removal step work again. Not redundant: it runs the role
// commands end to end over one linked work tree.
test("init locks the work tree and a terminal finish unlocks it", async () => {
  const { main, linked: tree } = await linked();

  const init = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());
  expect(init.exitCode).toBe(0);
  expect(await lockField(main, tree)).toContain("agent-loop run ");

  const lockedRemoval = await removeForced(main, tree);
  expect(lockedRemoval.exitCode).not.toBe(0);
  expect(lockedRemoval.stderr).toContain("cannot remove a locked working tree");

  const result = await finish(tree);
  expect(result.exitCode).toBe(0);
  expect(await lockField(main, tree)).toBeNull();
  expect((await removeForced(main, tree)).exitCode).toBe(0);
});

// Usefulness: verifies acceptance 1 for the crash window. A terminal run that still holds its
// own lock releases it through a later finish, so removal works. Not redundant: the other
// terminal cases never leave a lock on a terminal run.
test("a later finish releases the lock of a terminal run", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());
  expect((await finish(tree)).exitCode).toBe(0);
  // The lock that a crash between the state write and the unlock leaves behind.
  await git(main, ["worktree", "lock", "--reason", workTreeLockReason(cwdHash(tree)), tree]);
  expect((await removeForced(main, tree)).exitCode).not.toBe(0);

  const result = await finish(tree);

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("already finished");
  expect(await lockField(main, tree)).toBeNull();
  expect((await removeForced(main, tree)).exitCode).toBe(0);
});

// Usefulness: verifies acceptance 2 on the release path. A lock whose reason names another owner
// stays through a later finish. Not redundant: the own-lock case releases the lock.
test("a later finish keeps a lock that names another owner", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());
  expect((await finish(tree)).exitCode).toBe(0);
  await git(main, ["worktree", "lock", "--reason", "maintainer debug", tree]);

  const result = await finish(tree);

  expect(result.exitCode).toBe(1);
  expect(await lockField(main, tree)).toBe("locked maintainer debug");
  expect((await removeForced(main, tree)).exitCode).not.toBe(0);
});

// Usefulness: verifies the release path needs a terminal run. A lock with no state file stays,
// because no run id can match it. Not redundant: every other release case has a state file.
test("a later finish with no state file keeps the lock", async () => {
  const { main, linked: tree } = await linked();
  const reason = workTreeLockReason(cwdHash(tree));
  await git(main, ["worktree", "lock", "--reason", reason, tree]);

  const result = await finish(tree);

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("No run state");
  expect(await lockField(main, tree)).toBe(`locked ${reason}`);
});

// Usefulness: verifies the abort branch of the release path. A terminal run that still holds its
// own lock releases it through a later abort. Not redundant: the finish path never runs abort.
test("a later abort releases the lock of a terminal run", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());
  expect((await abort(tree)).exitCode).toBe(0);
  await git(main, ["worktree", "lock", "--reason", workTreeLockReason(cwdHash(tree)), tree]);

  const result = await abort(tree);

  expect(result.exitCode).toBe(1);
  expect(await lockField(main, tree)).toBeNull();
  expect((await removeForced(main, tree)).exitCode).toBe(0);
});

// Usefulness: verifies acceptance 2 for abort — a terminal abort unlocks the work tree, so the
// documented removal step works. Not redundant: the finish case never runs the abort path.
test("a terminal abort unlocks the work tree", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());

  const result = await abort(tree);

  expect(result.exitCode).toBe(0);
  expect(await lockField(main, tree)).toBeNull();
  expect((await removeForced(main, tree)).exitCode).toBe(0);
});

// Usefulness: verifies acceptance 2 for halt — a reviewer mutation ends the run halted and unlocks
// the work tree. Not redundant: halt is the third terminal lifecycle and has its own path.
test("a halted run unlocks the work tree", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());

  const mutating = recordingAdapter([]);
  mutating.run = async (state) => {
    state.sessionId = "rev-sess";
    await writeFile(join(tree, "mutated.txt"), "mutated\n");
    return "Conclusion: done\nWhy: ok\nBlockers: none";
  };
  const halted = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), tree), {
    agents: { fake1: recordingAdapter([]), fake2: mutating },
    stdin: stdinPrompt,
  });

  expect(halted.exitCode).toBe(1);
  expect((await readRepoState(tree)).lifecycle).toBe("halted");
  expect(await lockField(main, tree)).toBeNull();
  expect((await removeForced(main, tree)).exitCode).toBe(0);
});

// Usefulness: verifies that a refused finish keeps the lock, so a run that is not terminal stays
// protected. Not redundant: the accepted cases all reach a terminal state.
test("a refused finish keeps the lock", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());

  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], tree), {
    stdin: async () => "not json",
  });

  expect(result.exitCode).toBe(1);
  expect(await lockField(main, tree)).toContain("agent-loop run ");
});

// Usefulness: verifies that a refused abort keeps the lock. Not redundant: the refused finish
// covers a different command and refusal.
test("a refused abort keeps the lock", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());

  const result = await abort(tree, []);

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("abort requires --reason");
  expect(await lockField(main, tree)).toContain("agent-loop run ");
});

// Usefulness: verifies that an interrupted run keeps the lock, because only a terminal lifecycle
// unlocks. Not redundant: the terminal cases never reach the interrupted lifecycle.
test("an interrupted run keeps the lock", async () => {
  const { main, linked: tree } = await linked();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());

  const agents = basicDeps().agents;
  agents.fake1.run = async () => {
    throw new ExecError("canceled", { isCanceled: true });
  };
  const canceled = await executeRoleCommand(withRepo(dispatchArgv(), tree), {
    agents,
    stdin: stdinPrompt,
  });

  expect(canceled.exitCode).toBe(130);
  expect((await readRepoState(tree)).lifecycle).toBe("interrupted");
  expect(await lockField(main, tree)).toContain("agent-loop run ");
});

// Usefulness: verifies the main work tree case. Init succeeds with no lock and a log line,
// because Git refuses to lock the main work tree. Not redundant: the linked cases take a lock.
test("init in the main work tree succeeds with no lock and a log line", async () => {
  const repo = await newRunRepo();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await executeRoleCommand(
      withRepo(dispatchArgv(INIT_OVERRIDES), repo),
      basicDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(await lockField(repo, repo)).toBeNull();
    expect(log.mock.calls.flat().join(" ")).toContain("main work tree");
  } finally {
    log.mockRestore();
  }
});

// Usefulness: verifies the existing-lock rule end to end — a lock of another owner keeps its
// reason through init and a terminal finish. Not redundant: the lib test never runs role commands.
test("a lock of another owner keeps its reason through init and finish", async () => {
  const { main, linked: tree } = await linked();
  await git(main, ["worktree", "lock", "--reason", "maintainer debug", tree]);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), tree), basicDeps());
  const result = await finish(tree);

  expect(result.exitCode).toBe(0);
  expect(await lockField(main, tree)).toBe("locked maintainer debug");
  expect((await removeForced(main, tree)).exitCode).not.toBe(0);
});
