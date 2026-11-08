import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { cleanupLoop } from "../../src/batch/cleanup.mjs";
import { createLoopWorkTree, git } from "../../src/batch/git.mjs";
import { acquireClaim, releaseClaim } from "../../src/batch/store.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const REPO_KEY = "abcabcabcabc";

let sharedFixture;
let branchCounter = 0;

async function createRepo() {
  const main = await createTempRepo();
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  const remote = await mkdtemp(join(tmpdir(), "batch-remote-"));
  await execa("git", ["init", "--bare"], { cwd: remote });
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`], {
    cwd: main,
  });
  return { main, remote, base };
}

// One repository and bare remote for the file, reset per case by removing that case's work tree,
// branch, remote branch, runs root, and root directory. A case that changes the main branch gets
// its own repository (`isolated`: a process-level state change that cannot be reset cheaply).
async function setup({
  status = "succeeded",
  push = true,
  dirty = false,
  lock = false,
  isolated = false,
} = {}) {
  const repo = isolated ? await createRepo() : (sharedFixture ??= await createRepo());
  const { main, remote, base } = repo;
  const root = await mkdtemp(join(tmpdir(), "batch-root-"));
  const workTree = join(root, "issue-7");
  const branch = `batch/b1/7-${branchCounter++}`;
  const recorded = await createLoopWorkTree({ repo: main, base, workTree, branch });
  await execa("git", ["config", "user.name", "Tester"], { cwd: workTree });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: workTree });
  await execa("git", ["commit", "--allow-empty", "-m", "work on the issue"], { cwd: workTree });
  if (push) await execa("git", ["push", "-u", "origin", branch], { cwd: workTree });
  if (dirty) await writeFile(join(workTree, "dirty.txt"), "uncommitted" + String.fromCharCode(10));
  if (lock) await execa("git", ["worktree", "lock", workTree], { cwd: main });
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-runs-"));
  await acquireClaim(runsRoot, REPO_KEY, 7, {
    batchId: "b1",
    repo: main,
    workTree,
    pid: process.pid,
    startTime: null,
  });
  const manifest = {
    id: "b1",
    repo: main,
    repoKey: REPO_KEY,
    base,
    workTreeRoot: root,
    issues: [7],
    settings: { loops: 1, maxSteps: 10 },
  };
  const loop = {
    issue: 7,
    status,
    pr: null,
    workTree: recorded,
    branch,
  };
  const cleanup = async (overrides = {}) =>
    cleanupLoop({
      manifest: { ...manifest, ...overrides.manifest },
      loop: { ...loop, ...overrides.loop },
      runsRoot,
      gh: overrides.gh,
      deps: overrides.deps,
    });
  const clean = async () => {
    await execa("git", ["worktree", "unlock", workTree], { cwd: main }).catch(() => {});
    await execa("git", ["worktree", "remove", "--force", workTree], { cwd: main }).catch(() => {});
    await execa("git", ["branch", "-D", branch], { cwd: main }).catch(() => {});
    await execa("git", ["push", "origin", "--delete", branch], { cwd: main }).catch(() => {});
    await removePath(root);
    await removePath(runsRoot);
    if (isolated) {
      await removePath(remote);
      await removePath(main);
    }
  };
  return { main, remote, root, workTree, branch, runsRoot, manifest, loop, cleanup, clean };
}

// Usefulness: a pushed successful work tree is removed after every identity and reachability check.
test("a pushed successful work tree is removed", async () => {
  const fixture = await setup();
  try {
    const result = await fixture.cleanup();
    expect(result).toEqual({ removed: true, reason: null });
    await expect(stat(fixture.workTree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await releaseClaim(fixture.runsRoot, REPO_KEY, 7, { batchId: "b1" })).toBe(false);
  } finally {
    await fixture.clean();
  }
});

// Usefulness: an unpushed commit keeps the work tree for the owner.
test("an unpushed work tree is kept", async () => {
  const fixture = await setup({ push: false });
  try {
    const result = await fixture.cleanup();
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("unpushed");
    expect((await stat(fixture.workTree)).isDirectory()).toBe(true);
  } finally {
    await fixture.clean();
  }
});

// Usefulness: a dirty work tree is never removed.
test("a dirty work tree is kept", async () => {
  const fixture = await setup({ dirty: true });
  try {
    const result = await fixture.cleanup();
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("not clean");
  } finally {
    await fixture.clean();
  }
});

// Usefulness: a failed, interrupted, or needs-owner loop keeps its work tree. These cases return
// before any Git or file system read, so they need no repository fixture.
for (const status of ["failed", "interrupted", "needs-owner"]) {
  test(`a ${status} work tree is kept`, async () => {
    const result = await cleanupLoop({
      manifest: { id: "b1", repo: "unused", repoKey: REPO_KEY, workTreeRoot: "unused" },
      loop: { issue: 7, status, workTree: null },
      runsRoot: "unused",
    });
    expect(result.removed).toBe(false);
    expect(result.reason).toContain(status);
  });
}

// Usefulness: a directory whose device or inode no longer matches is never removed. The recorded
// identity is changed instead of relying on the file system to allocate a different inode, which
// an ext4 reuse can defeat.
test("a replaced directory is kept", async () => {
  const fixture = await setup();
  try {
    const result = await fixture.cleanup({
      loop: { workTree: { ...fixture.loop.workTree, dev: "0", ino: "0" } },
    });
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("identity");
    expect((await stat(fixture.workTree)).isDirectory()).toBe(true);
  } finally {
    await fixture.clean();
  }
});

// Usefulness: a live work tree lock keeps the tree.
test("a locked work tree is kept", async () => {
  const fixture = await setup({ lock: true });
  try {
    const result = await fixture.cleanup();
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("lock");
  } finally {
    await fixture.clean();
  }
});

// Usefulness: the main work tree and an outside path are never touched.
test("the main work tree is never removed", async () => {
  const fixture = await setup();
  try {
    const result = await fixture.cleanup({
      loop: {
        workTree: {
          ...fixture.loop.workTree,
          path: fixture.main,
          canonicalPath: fixture.main,
        },
      },
    });
    expect(result.removed).toBe(false);
    expect((await stat(fixture.main)).isDirectory()).toBe(true);
  } finally {
    await fixture.clean();
  }
});

// Usefulness: a merged pull request proves the push when the remote branch was deleted.
test("a merged pull request proves a deleted remote branch", async () => {
  const fixture = await setup({ isolated: true });
  try {
    const head = (await git(["rev-parse", "HEAD"], fixture.workTree)).stdout;
    await execa("git", ["merge", "--no-ff", "-m", "merge", fixture.branch], { cwd: fixture.main });
    const merge = (await git(["rev-parse", "HEAD"], fixture.main)).stdout;
    await execa("git", ["push", "origin", fixture.branch === "" ? "HEAD" : fixture.manifest.base], {
      cwd: fixture.main,
    });
    await execa("git", ["push", "origin", "--delete", fixture.branch], { cwd: fixture.workTree });
    const gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "MERGED",
            headRefOid: head,
            mergeCommit: { oid: merge },
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
    const result = await fixture.cleanup({ loop: { pr: 5 }, gh });
    expect(result.removed).toBe(true);
  } finally {
    await fixture.clean();
  }
});
