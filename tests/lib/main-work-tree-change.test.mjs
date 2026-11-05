import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { readMainWorkTree } from "../../src/lib/main-work-tree-change.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createLinkedWorkTree } from "../git-helpers.mjs";

// Arms one remote default ref move or one classification fault.
const race = vi.hoisted(() => ({
  arm: false,
  calls: 0,
  ref: null,
  sha: null,
  fault: null,
}));

// Releases the slow cancellation of a stalled read.
const hold = vi.hoisted(() => {
  let release;
  let gate;
  const open = () => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
  };
  open();
  return {
    wait: () => gate,
    release: () => release(),
    reset: open,
  };
});

vi.mock("../../src/lib/git-read.mjs", async (importOriginal) => {
  const real = await importOriginal();
  const readsDefaultRef = (args) =>
    args[0] === "symbolic-ref" && args[2] === "refs/remotes/origin/HEAD";
  return {
    ...real,
    gitRead: async (cwd, args, options) => {
      if (race.arm && readsDefaultRef(args) && ++race.calls === 2) {
        execFileSync("git", ["update-ref", race.ref, race.sha], { cwd });
      }
      if (race.fault === "throw" && readsDefaultRef(args)) {
        throw new Error("read failed");
      }
      if (race.fault === "slow-cancel" && args[0] === "merge-base") {
        return new Promise((_, reject) => {
          const finish = () => reject(options.signal.reason ?? new Error("aborted"));
          if (options.signal?.aborted) hold.wait().then(finish);
          else
            options.signal?.addEventListener("abort", () => hold.wait().then(finish), {
              once: true,
            });
        });
      }
      if (race.fault === "malformed" && readsDefaultRef(args)) {
        return { exitCode: 0, stdout: "not-a-ref\n", stderr: "" };
      }
      return real.gitRead(cwd, args, options);
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
  race.arm = false;
  race.calls = 0;
  race.fault = null;
  hold.release();
  hold.reset();
  await removePath(tree.base);
});

const git = async (...args) => (await execa("git", args, { cwd: tree.main })).stdout;

/** Fast-forwards the main work tree and moves the remote default ref to its new head. */
const forwardMain = async () => {
  await writeFile(join(tree.main, "init.txt"), "forwarded\n");
  await execa("git", ["commit", "-am", "forwarded"], { cwd: tree.main });
  const head = await git("rev-parse", "HEAD");
  const ref = await git("symbolic-ref", "refs/remotes/origin/HEAD");
  await execa("git", ["update-ref", ref, head], { cwd: tree.main });
  return head;
};

// Usefulness: verifies a remote default ref that moves during the read keeps the path report (issue #1485).
test("a remote default ref that moves during the read keeps the change report", async () => {
  const before = await readMainWorkTree(tree.linked);
  expect(before).not.toBeNull();
  await forwardMain();
  race.ref = await git("symbolic-ref", "refs/remotes/origin/HEAD");
  race.sha = await git("rev-parse", "other");
  race.calls = 0;
  race.arm = true;

  const after = await readMainWorkTree(tree.linked, { since: before });

  expect(after).not.toBeNull();
  expect(after.fastForward).toBeNull();
  expect(after.commitPaths).toEqual(["init.txt"]);
});

// Usefulness: verifies a timed-out check returns at its bound without awaiting slow cleanup (issue #1485).
test("a timed-out fast-forward check returns before its slow cleanup settles", async () => {
  const before = await readMainWorkTree(tree.linked);
  expect(before).not.toBeNull();
  await forwardMain();
  race.fault = "slow-cancel";

  const started = performance.now();
  let after;
  try {
    after = await Promise.race([
      readMainWorkTree(tree.linked, { since: before, deadlineMs: 2_000 }),
      new Promise((resolve) => setTimeout(() => resolve("late"), 3_000)),
    ]);
  } finally {
    hold.release();
  }
  const elapsed = performance.now() - started;

  expect(after).not.toBe("late");
  expect(elapsed).toBeLessThan(3_000);
  expect(after).not.toBeNull();
  expect(after.fastForward).toBeNull();
  expect(after.commitPaths).toEqual(["init.txt"]);
});

// Usefulness: verifies a thrown classification read keeps the completed path report (issue #1485).
test("a fast-forward read that throws keeps the change report", async () => {
  const before = await readMainWorkTree(tree.linked);
  expect(before).not.toBeNull();
  await forwardMain();
  race.fault = "throw";

  const after = await readMainWorkTree(tree.linked, { since: before });

  expect(after).not.toBeNull();
  expect(after.fastForward).toBeNull();
  expect(after.commitPaths).toEqual(["init.txt"]);
});

// Usefulness: verifies a malformed remote ref keeps the completed path report (issue #1485).
test("a malformed remote default ref keeps the change report", async () => {
  const before = await readMainWorkTree(tree.linked);
  expect(before).not.toBeNull();
  await forwardMain();
  race.fault = "malformed";

  const after = await readMainWorkTree(tree.linked, { since: before });

  expect(after).not.toBeNull();
  expect(after.fastForward).toBeNull();
  expect(after.commitPaths).toEqual(["init.txt"]);
});
