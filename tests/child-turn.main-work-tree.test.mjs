import { writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for every case (see `cutLinkedReads` below). A case then starts no
// process for the shared Git and lockfile reads of the linked work tree.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      const answer =
        gitDouble.answer && command === "git" ? gitDouble.answer(command, args, options) : null;
      return answer ?? real.execa(command, args, options);
    },
  };
});

import { execa } from "execa";
import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import {
  failedMainWorkTreeChanged,
  failedMainWorkTreeChangedInTurn,
  failedMainWorkTreeFastForward,
  readMainWorkTree,
} from "../src/lib/main-work-tree-change.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { CLEAN_REPO_HEAD, createLinkedWorkTree } from "./git-helpers.mjs";

// The main work tree resolution fails or stalls only in the tests that set these flags.
const resolution = vi.hoisted(() => ({ fail: false, stall: false }));
vi.mock("../src/lib/work-tree-layout.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    mainWorkTreePath: async (...args) => {
      if (resolution.fail) throw new Error("resolution failed");
      if (resolution.stall) return new Promise(() => {});
      // The linked tree's main work tree is known here; every other layout resolves through Git.
      if (tree && args[0] === tree.linked) return tree.mainReal;
      return real.mainWorkTreePath(...args);
    },
  };
});

let tree;
beforeEach(async () => {
  // The linked path is an empty directory: every read there is answered from memory, and no Git
  // work tree is created for it. The main work tree stays real, so its snapshot stays real.
  tree = await createLinkedWorkTree({ linkedWorkTree: false });
  tree.mainReal = await realpath(tree.main);
  gitDouble.answer = cutLinkedReads;
});
afterEach(async () => {
  gitDouble.answer = null;
  resolution.fail = false;
  resolution.stall = false;
  if (tree) await removePath(tree.base);
  tree = undefined;
});

const turn = (
  act,
  cwd = tree.linked,
  onMainWatch = null,
  mainWatchDeadlineMs = 60_000,
  mainWatchMarginMs = null,
) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd,
    ...(onMainWatch ? { onMainWatch } : {}),
    mainWatchDeadlineMs,
    ...(mainWatchMarginMs === null ? {} : { mainWatchMarginMs }),
  });

/** Adds the branch `other` at the template commit and a second commit on the checked-out branch. */
async function seedOtherBranch() {
  await execa("git", ["branch", "other"], { cwd: tree.main });
  await writeFile(join(tree.main, "init.txt"), "second\n");
  await execa("git", ["commit", "-am", "second"], { cwd: tree.main });
}

/** Adds the `origin` remote and the remote-tracking default ref that a clone sets up. */
async function seedUpstream() {
  const branch = (await execa("git", ["symbolic-ref", "--short", "HEAD"], { cwd: tree.main }))
    .stdout;
  const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: tree.main })).stdout;
  await execa("git", ["remote", "add", "origin", "."], { cwd: tree.main });
  await execa("git", ["update-ref", `refs/remotes/origin/${branch}`, head], { cwd: tree.main });
  await execa(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`],
    {
      cwd: tree.main,
    },
  );
}

/**
 * Answers each work tree root, and the linked path's shared Git reads, lockfile list, and clean
 * snapshot, from memory. Every call not answered here runs real `git`, so the main work tree state
 * reads stay real. The linked path reads the same clean state before and after, so it reports no
 * change. The caller sets it in `beforeEach`.
 */
function cutLinkedReads(command, args, options) {
  const cwd = options?.cwd;
  if (cwd !== tree.linked && cwd !== tree.main && cwd !== tree.mainReal) return undefined;
  const answer = (stdout) => ({
    exitCode: 0,
    stdout: options?.stripFinalNewline === false ? stdout : stdout.replace(/\r?\n$/, ""),
    stderr: "",
  });
  switch (JSON.stringify(args)) {
    case '["rev-parse","--show-toplevel"]':
      return answer(`${cwd}\n`);
    case '["rev-parse","--git-common-dir"]':
      return cwd === tree.linked ? answer(".git\n") : undefined;
    case '["config","-z","--list","--show-scope"]':
    case '["ls-files","-z","--cached","--others","--exclude-standard"]':
      return cwd === tree.linked ? answer("") : undefined;
    case '["status","--porcelain=v1","-z","--untracked-files=all"]':
    case '["ls-files","--stage","-z"]':
      return cwd === tree.linked ? answer("") : undefined;
    case '["rev-parse","--verify","-q","HEAD"]':
      return cwd === tree.linked ? answer(`${CLEAN_REPO_HEAD}\n`) : undefined;
    default:
      return undefined;
  }
}

/** The full ref name that `refs/remotes/origin/HEAD` names, such as `refs/remotes/origin/main`. */
const remoteHeadRef = async () =>
  (await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: tree.main })).stdout;

/** Fast-forwards the main work tree by one commit and moves the remote default ref to its head. */
const fastForwardMain = async (content) => {
  await writeFile(join(tree.main, "init.txt"), content);
  await execa("git", ["commit", "-am", content.trim()], { cwd: tree.main });
  const after = (await execa("git", ["rev-parse", "HEAD"], { cwd: tree.main })).stdout;
  await execa("git", ["update-ref", await remoteHeadRef(), after], { cwd: tree.main });
  return after;
};

// Usefulness: verifies requirement "a worker turn that writes a tracked file of the main work tree
// reports that path" (issue #1448). The linked work tree stays clean, so no other field shows it.
test("a worker turn that writes a tracked main work tree file reports its path", async () => {
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "changed\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies the whole pre-turn main read, layout lookup included, ends at its bound.
// Not redundant: no other test stalls the layout through a turn.
test("a stalled main work tree layout ends the turn at its bound", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  resolution.stall = true;
  const started = Date.now();

  const result = await runChild({
    agents: { fake: scripted([async () => {}]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: tree.linked,
    mainReadDeadlineMs: 50,
  });

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree"))).toBe(true);
});

// Usefulness: verifies a setup that did not finish leaves the cleanup without a TypeError. A
// timed-out hook then reports one failure and not a teardown error.
test("a setup that did not finish leaves the cleanup without a TypeError", async () => {
  const created = tree;
  tree = undefined;
  await removePath(created.base);
});

// Usefulness: verifies requirement "a turn that leaves the main work tree unchanged carries no
// field" (issue #1448). A clean main work tree must not report its baseline state.
test("a worker turn that leaves the main work tree unchanged carries no field", async () => {
  const result = await turn(async () => {});
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies requirement "a deletion of a tracked main work tree file is reported"
// (issue #1448). A deleted path has no content hash, so a hash-only compare misses it.
test("a worker turn that deletes a tracked main work tree file reports its path", async () => {
  const result = await turn(async () => {
    await execa("git", ["rm", "init.txt"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a new untracked file in the main work tree is reported"
// (issue #1448). The field covers untracked files that Git does not ignore.
test("a worker turn that adds an untracked main work tree file reports its path", async () => {
  const result = await turn(async () => {
    await writeFile(join(tree.main, "notes.txt"), "new\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["notes.txt"]);
});

// Usefulness: verifies requirement "a rename in the main work tree is reported" (issue #1448).
// Git reports the new path only, so the field names that path.
test("a worker turn that renames a tracked main work tree file reports its path", async () => {
  const result = await turn(async () => {
    await execa("git", ["mv", "init.txt", "moved.txt"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["moved.txt"]);
});

// Usefulness: verifies requirement "a file that was already dirty and changes again is reported"
// (issue #1448). A compare against a clean baseline alone misses it.
test("a worker turn that changes an already dirty main work tree file reports it", async () => {
  await writeFile(join(tree.main, "init.txt"), "dirty\n");
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "dirty again\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a dirty file left unchanged is not reported" (issue #1448).
// A compare that reports every dirty path names this one.
test("a worker turn that leaves an already dirty main work tree file unchanged reports nothing", async () => {
  await writeFile(join(tree.main, "init.txt"), "dirty\n");
  const result = await turn(async () => {});
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies requirement "only a linked --cwd reads the main work tree" (issue #1448).
// A turn in the main work tree itself must not report its own change as a main work tree change.
test("a worker turn in the main work tree carries no field", async () => {
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "changed\n");
  }, tree.main);
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies requirement "a canceled worker turn carries the main work tree change"
// (issue #1448), as sharedGitChanged does. The dispatcher builds the interrupted envelope from the
// error, so a lost field leaves the change with no trace.
test("a canceled worker turn carries the main work tree change", async () => {
  const error = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "changed\n");
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedMainWorkTreeChanged(error)).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a commit of a tracked main work tree file is reported"
// (issue #1448). The work tree is clean after the commit, so the dirty compare alone misses it.
test("a worker turn that commits a tracked main work tree file reports its path", async () => {
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "committed\n");
    await execa("git", ["commit", "-am", "change"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "an amend of a main work tree commit is reported" (issue
// #1448). The amended commit has a new head, so the commit range names the changed file.
test("a worker turn that amends a main work tree commit reports its path", async () => {
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "amended\n");
    await execa("git", ["commit", "--amend", "--no-edit", "-a"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a reset to another main work tree commit is reported" (issue
// #1448). A reset leaves a clean work tree, so only the commit range shows the change.
test("a worker turn that resets the main work tree to another commit reports its path", async () => {
  await seedOtherBranch();
  const result = await turn(async () => {
    await execa("git", ["reset", "--hard", "other"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a branch switch in the main work tree is reported" (issue
// #1448). The checked-out branch and the head commit change, and the commit range names the file.
test("a worker turn that switches the main work tree branch reports its path", async () => {
  await seedOtherBranch();
  const result = await turn(async () => {
    await execa("git", ["checkout", "other"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies a clean fast-forward reports both heads apart from a worker edit (issue #1485).
test("a clean fast-forward of the main work tree reports the old and new head", async () => {
  await seedUpstream();
  const before = (await execa("git", ["rev-parse", "HEAD"], { cwd: tree.main })).stdout;
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
  });
  const after = (await execa("git", ["rev-parse", "HEAD"], { cwd: tree.main })).stdout;
  expect(result.mainWorkTreeFastForward).toEqual({ before, after });
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies a fast-forward with an untracked file keeps the path report (issue #1485).
test("a fast-forward with an untracked file keeps the full main work tree change report", async () => {
  await seedUpstream();
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
    await writeFile(join(tree.main, "notes.txt"), "new\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt", "notes.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeFastForward");
});

// Usefulness: verifies a local commit on top of a fast-forward keeps the path report (issue #1485).
test("a local commit on top of a fast-forward keeps the main work tree change report", async () => {
  await seedUpstream();
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
    await writeFile(join(tree.main, "init.txt"), "local\n");
    await execa("git", ["commit", "-am", "local"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeFastForward");
});

// Usefulness: verifies a remote default ref away from the new head keeps the path report (issue #1485).
test("a remote default ref that moves away keeps the main work tree change report", async () => {
  await seedOtherBranch();
  await seedUpstream();
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
    const other = (await execa("git", ["rev-parse", "other"], { cwd: tree.main })).stdout;
    await execa("git", ["update-ref", await remoteHeadRef(), other], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeFastForward");
});

// Usefulness: verifies a main work tree on another branch keeps the path report (issue #1485).
test("a main work tree on another branch keeps the main work tree change report", async () => {
  await seedOtherBranch();
  await seedUpstream();
  await execa("git", ["checkout", "other"], { cwd: tree.main });
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeFastForward");
});

// Usefulness: verifies a failed worker turn carries the clean fast-forward (issue #1485).
test("a failed worker turn carries the clean fast-forward", async () => {
  await seedUpstream();
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
    throw new Error("adapter failed");
  });
  expect(result).toMatchObject({ status: "error" });
  expect(result.mainWorkTreeFastForward).toMatchObject({ before: expect.any(String) });
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies a canceled worker turn carries the clean fast-forward (issue #1485).
test("a canceled worker turn carries the clean fast-forward", async () => {
  await seedUpstream();
  const error = await turn(async () => {
    await fastForwardMain("forwarded\n");
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedMainWorkTreeFastForward(error)).toMatchObject({ before: expect.any(String) });
});

// Usefulness: verifies requirement "a failed worker turn carries the main work tree change"
// (issue #1448), as sharedGitChanged does. The handled error result is the turn's only record.
test("a failed worker turn carries the main work tree change", async () => {
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "changed\n");
    throw new Error("adapter failed");
  });
  expect(result).toMatchObject({ status: "error" });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "the field names at most 20 main work tree paths" (issue
// #1448). A turn that adds a directory of files must not grow the envelope without a bound.
test("the field names at most 20 main work tree paths", async () => {
  const result = await turn(async () => {
    for (let index = 0; index < 25; index++) {
      await writeFile(join(tree.main, `new-${index}.txt`), "new\n");
    }
  });
  expect(result.mainWorkTreeChanged).toHaveLength(20);
});

// Usefulness: verifies requirement "a failed commit diff warns and carries no state" (issue #1448
// review). A missing commit must not read as an unchanged main work tree.
test("a failed main work tree commit diff warns and returns no state", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const state = await readMainWorkTree(tree.linked, {
    since: { head: "0".repeat(40), branch: "main" },
  });
  expect(state).toBeNull();
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree"))).toBe(true);
});

// Usefulness: verifies requirement "a main work tree read that fails logs a warning and carries no
// field" (issue #1448). An absent field is never a false claim of no change.
test("a worker turn whose main work tree read fails warns and carries no field", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  resolution.fail = true;
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "changed\n");
  });
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree"))).toBe(true);
});

// Usefulness: verifies requirement "a main work tree read that passes its deadline logs a warning
// and returns no state" (issue #1448). A stalled resolution must end the read, not hold the turn.
test("a stalled main work tree read ends at the bound with a warning", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  resolution.stall = true;
  const started = Date.now();
  const state = await readMainWorkTree(tree.linked, { deadlineMs: 50 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(state).toBeNull();
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree"))).toBe(true);
});

// Usefulness: verifies requirement "the main work tree read never writes its index" (issue #1448).
// Git status refreshes the index unless optional locks are off, so an old index mtime must survive.
test("the main work tree read leaves the index file unchanged", async () => {
  const indexPath = join(tree.main, ".git", "index");
  const old = new Date("2001-01-01T00:00:00Z");
  let before;
  const result = await turn(async () => {
    await utimes(indexPath, old, old);
    before = (await stat(indexPath)).mtimeMs;
  });
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
  expect((await stat(indexPath)).mtimeMs).toBe(before);
});

/**
 * Writes `content` to `path` until the turn watch reports the path. A late watch stream then cannot
 * drop the only write of the turn, and the write stays inside the turn window.
 */
async function writeUntilSeen(handle, path, content) {
  await vi.waitFor(
    async () => {
      await writeFile(path, content);
      expect(handle.seenFileCount()).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
}

/**
 * Starts a turn that writes `path` in the main work tree, then holds until the test releases it.
 * A `restore` value writes the first content back before the turn ends.
 */
function heldWrite({ path = "init.txt", written = "changed\n", restore = null, onMainWatch } = {}) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let observed;
  const seen = new Promise((resolve) => {
    observed = resolve;
  });
  let watchHandle;
  const run = turn(
    async () => {
      await writeUntilSeen(watchHandle, join(tree.main, path), written);
      observed();
      await held;
      if (restore !== null) await writeFile(join(tree.main, path), restore);
    },
    tree.linked,
    (handle) => {
      watchHandle = handle;
      onMainWatch?.(handle);
    },
  );
  return { run, seen, release };
}

// Usefulness: verifies that a worker turn reports a tracked main work tree file that it writes and
// restores (issue #1556). The end-of-turn read cannot see the restored file, so only the in-window
// watch names it.
test("a worker turn that restores a tracked main work tree file reports it in the turn", async () => {
  let watchHandle;
  const hold = heldWrite({
    restore: "hello\n",
    onMainWatch: (handle) => {
      watchHandle = handle;
    },
  });
  await hold.seen;
  await vi.waitFor(() => expect(watchHandle.seenFileCount()).toBeGreaterThan(0));
  hold.release();
  const result = await hold.run;
  expect(result.mainWorkTreeChangedInTurn).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: acceptance #1583: a write and its restore that both land before the watch reads the
// path must still appear in the in-turn field. The restored state is not the baseline, because the
// write inside the window moved the modification time (issue #1583).
test("a worker turn that restores a file before the watch reads it reports it in the turn", async () => {
  const file = join(tree.main, "init.txt");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(file, old, old);
  let watchHandle;
  const result = await turn(
    async () => {
      // Synchronous writes complete before the watch callback can read the path, so its first
      // in-window read sees the restored state. The pair repeats until the watch reports the path,
      // so a late watch stream cannot drop the only delivery.
      await vi.waitFor(
        () => {
          writeFileSync(file, "changed\n");
          writeFileSync(file, "hello\n");
          expect(watchHandle.seenFileCount()).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
    },
    tree.linked,
    (handle) => {
      watchHandle = handle;
    },
  );
  expect(result.mainWorkTreeChangedInTurn).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies that a directory-only change carries no in-turn field (issue #1556). Only
// tracked files and untracked files that Git does not ignore are in scope.
test("a directory-only change in the main work tree reports no path", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let observed;
  const seen = new Promise((resolve) => {
    observed = resolve;
  });
  let watchHandle;
  const run = turn(
    async () => {
      await mkdir(join(tree.main, "made-dir"));
      await writeUntilSeen(watchHandle, join(tree.main, "init.txt"), "changed\n");
      observed();
      await held;
      await rm(join(tree.main, "made-dir"), { recursive: true, force: true });
      await writeFile(join(tree.main, "init.txt"), "hello\n");
    },
    tree.linked,
    (handle) => {
      watchHandle = handle;
    },
  );
  await seen;
  await vi.waitFor(() => expect(watchHandle.seenFileCount()).toBeGreaterThan(0));
  release();
  const result = await run;
  expect(result.mainWorkTreeChangedInTurn).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies that a turn changing no main work tree file carries no field (issue #1556).
// A clean main work tree then never reports an in-window change.
test("a worker turn that writes nothing carries no in-turn field", async () => {
  const result = await turn(async () => {});
  expect(result).not.toHaveProperty("mainWorkTreeChangedInTurn");
});

// Usefulness: verifies acceptance "On Windows, a read of a main work tree file inside a turn
// window does not appear in mainWorkTreeChangedInTurn" (issue #1583). A read changes no state,
// size, modification time, or change time, so the envelope must carry no in-turn field. Each file
// gets an old access time before the turn, so a read inside the turn moves only that time.
test("a worker turn that only reads a main work tree file carries no in-turn field", async () => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const files = [];
  for (let index = 0; index < 5; index++) {
    const file = join(tree.main, `read-${index}.txt`);
    await writeFile(file, "read\n");
    await utimes(file, old, old);
    files.push(file);
  }
  let watchHandle;
  let next = 0;
  const result = await turn(
    async () => {
      await vi.waitFor(
        async () => {
          await readFile(files[Math.min(next++, files.length - 1)]);
          expect(watchHandle.seenFileCount()).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
    },
    tree.linked,
    (handle) => {
      watchHandle = handle;
    },
    60_000,
    0,
  );
  expect(result).not.toHaveProperty("mainWorkTreeChangedInTurn");
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies requirement "a file that still differs at the end stays in
// mainWorkTreeChanged only" (issue #1556). The in-window field names a restored change only.
test("a worker turn that leaves the main work tree file changed reports it only at the end", async () => {
  const hold = heldWrite();
  await hold.seen;
  hold.release();
  const result = await hold.run;
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeChangedInTurn");
});

// Usefulness: verifies requirement "scope leaves out ignored paths" (issue #1556). An install or a
// secret write in an ignored path must not flood the field.
test("a worker turn that restores an ignored main work tree file reports nothing", async () => {
  await writeFile(join(tree.main, ".git", "info", "exclude"), "ignored.txt\n");
  await writeFile(join(tree.main, "ignored.txt"), "hello\n");
  let watchHandle;
  const hold = heldWrite({
    path: "ignored.txt",
    restore: "hello\n",
    onMainWatch: (handle) => {
      watchHandle = handle;
    },
  });
  await hold.seen;
  await vi.waitFor(() => expect(watchHandle.seenFileCount()).toBeGreaterThan(0), {
    timeout: 5_000,
  });
  hold.release();
  const result = await hold.run;
  expect(result).not.toHaveProperty("mainWorkTreeChangedInTurn");
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies requirement "a failed worker turn carries the in-turn change" (issue #1556).
// The handled error result is the turn's only record, so a lost field leaves the edit with no trace.
test("a failed worker turn carries the in-turn main work tree change", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let observed;
  const seen = new Promise((resolve) => {
    observed = resolve;
  });
  let watchHandle;
  const run = turn(
    async () => {
      await writeUntilSeen(watchHandle, join(tree.main, "init.txt"), "changed\n");
      observed();
      await held;
      await writeFile(join(tree.main, "init.txt"), "hello\n");
      throw new Error("adapter failed");
    },
    tree.linked,
    (handle) => {
      watchHandle = handle;
    },
  );
  await seen;
  await vi.waitFor(() => expect(watchHandle.seenFileCount()).toBeGreaterThan(0));
  release();
  const result = await run;
  expect(result).toMatchObject({ status: "error" });
  expect(result.mainWorkTreeChangedInTurn).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeChanged");
});

// Usefulness: verifies requirement "a canceled worker turn carries the in-window change" (issue
// #1556). The dispatcher builds the interrupted envelope from the error, so a lost field leaves
// the restored edit with no trace.
test("a canceled worker turn carries the in-turn main work tree change", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let observed;
  const seen = new Promise((resolve) => {
    observed = resolve;
  });
  let watchHandle;
  const run = turn(
    async () => {
      await writeUntilSeen(watchHandle, join(tree.main, "init.txt"), "changed\n");
      observed();
      await held;
      await writeFile(join(tree.main, "init.txt"), "hello\n");
      throw new ExecError("canceled", { isCanceled: true });
    },
    tree.linked,
    (handle) => {
      watchHandle = handle;
    },
  ).catch((err) => err);
  await seen;
  await vi.waitFor(() => expect(watchHandle.seenFileCount()).toBeGreaterThan(0));
  release();
  const error = await run;
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedMainWorkTreeChangedInTurn(error)).toEqual(["init.txt"]);
});
