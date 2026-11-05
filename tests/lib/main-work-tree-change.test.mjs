import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { readMainWorkTree } from "../../src/lib/main-work-tree-change.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createLinkedWorkTree } from "../git-helpers.mjs";

// Arms one remote default ref move between the two reads of the fast-forward check.
const race = vi.hoisted(() => ({ arm: false, calls: 0, ref: null, sha: null }));

vi.mock("../../src/lib/git-read.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    gitRead: async (cwd, args, options) => {
      const readsDefaultRef = args[0] === "symbolic-ref" && args[2] === "refs/remotes/origin/HEAD";
      if (race.arm && readsDefaultRef && ++race.calls === 2) {
        execFileSync("git", ["update-ref", race.ref, race.sha], { cwd });
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
  await removePath(tree.base);
});

const git = async (...args) => (await execa("git", args, { cwd: tree.main })).stdout;

// Usefulness: verifies a remote default ref that moves during the read keeps the path report (issue #1485).
test("a remote default ref that moves during the read keeps the change report", async () => {
  const before = await readMainWorkTree(tree.linked);
  expect(before).not.toBeNull();
  await writeFile(join(tree.main, "init.txt"), "forwarded\n");
  await execa("git", ["commit", "-am", "forwarded"], { cwd: tree.main });
  const head = await git("rev-parse", "HEAD");
  const ref = await git("symbolic-ref", "refs/remotes/origin/HEAD");
  await execa("git", ["update-ref", ref, head], { cwd: tree.main });
  race.ref = ref;
  race.sha = await git("rev-parse", "other");
  race.calls = 0;
  race.arm = true;

  const after = await readMainWorkTree(tree.linked, { since: before });

  expect(after).not.toBeNull();
  expect(after.fastForward).toBeNull();
  expect(after.commitPaths).toEqual(["init.txt"]);
});
