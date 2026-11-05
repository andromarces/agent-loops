import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import {
  failedMainWorkTreeChanged,
  failedMainWorkTreeFastForward,
  readMainWorkTree,
} from "../src/lib/main-work-tree-change.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createLinkedWorkTree } from "./git-helpers.mjs";

// The main work tree resolution fails or stalls only in the tests that set these flags.
const resolution = vi.hoisted(() => ({ fail: false, stall: false }));
vi.mock("../src/lib/local-files.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    mainWorkTreePath: async (...args) => {
      if (resolution.fail) throw new Error("resolution failed");
      if (resolution.stall) return new Promise(() => {});
      return real.mainWorkTreePath(...args);
    },
  };
});

let tree;
beforeEach(async () => {
  tree = await createLinkedWorkTree({
    seed: async (main) => {
      await writeFile(join(main, "init.txt"), "second\n");
      await execa("git", ["commit", "-am", "second"], { cwd: main });
      await execa("git", ["branch", "other"], { cwd: main });
      await execa("git", ["reset", "--hard", "HEAD~1"], { cwd: main });
      // A remote-tracking ref of the default branch, as a clone sets up. No remote runs.
      const branch = (await execa("git", ["symbolic-ref", "--short", "HEAD"], { cwd: main }))
        .stdout;
      const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: main })).stdout;
      await execa("git", ["remote", "add", "origin", "."], { cwd: main });
      await execa("git", ["update-ref", `refs/remotes/origin/${branch}`, head], { cwd: main });
      await execa(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`],
        {
          cwd: main,
        },
      );
    },
  });
});
afterEach(async () => {
  resolution.fail = false;
  resolution.stall = false;
  await removePath(tree.base);
});

const turn = (act, cwd = tree.linked) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd,
  });

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
  const result = await turn(async () => {
    await execa("git", ["reset", "--hard", "other"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a branch switch in the main work tree is reported" (issue
// #1448). The checked-out branch and the head commit change, and the commit range names the file.
test("a worker turn that switches the main work tree branch reports its path", async () => {
  const result = await turn(async () => {
    await execa("git", ["checkout", "other"], { cwd: tree.main });
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies a clean fast-forward reports both heads apart from a worker edit (issue #1485).
test("a clean fast-forward of the main work tree reports the old and new head", async () => {
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
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
    await writeFile(join(tree.main, "notes.txt"), "new\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt", "notes.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeFastForward");
});

// Usefulness: verifies a local commit on top of a fast-forward keeps the path report (issue #1485).
test("a local commit on top of a fast-forward keeps the main work tree change report", async () => {
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
  await execa("git", ["checkout", "other"], { cwd: tree.main });
  const result = await turn(async () => {
    await fastForwardMain("forwarded\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
  expect(result).not.toHaveProperty("mainWorkTreeFastForward");
});

// Usefulness: verifies a failed worker turn carries the clean fast-forward (issue #1485).
test("a failed worker turn carries the clean fast-forward", async () => {
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
