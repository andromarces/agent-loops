import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { failedMainWorkTreeChanged, readMainWorkTree } from "../src/lib/main-work-tree-change.mjs";
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
  tree = await createLinkedWorkTree();
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
// (issue #1448). A deleted path has no content hash, so a hash-only compare would miss it.
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
// (issue #1448). A compare against a clean baseline alone would miss it.
test("a worker turn that changes an already dirty main work tree file reports it", async () => {
  await writeFile(join(tree.main, "init.txt"), "dirty\n");
  const result = await turn(async () => {
    await writeFile(join(tree.main, "init.txt"), "dirty again\n");
  });
  expect(result.mainWorkTreeChanged).toEqual(["init.txt"]);
});

// Usefulness: verifies requirement "a dirty file left unchanged is not reported" (issue #1448).
// A compare that reports every dirty path would name this one.
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

// Usefulness: verifies requirement "a main work tree read that fails logs a warning and carries no
// field" (issue #1448), so an absent field is never a false claim of no change.
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
