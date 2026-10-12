import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";

const gitCalls = vi.hoisted(() => []);
vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    execBounded: (command, args, options) => {
      gitCalls.push({ args, cwd: options?.cwd });
      return original.execBounded(command, args, options);
    },
  };
});

const { snapshot, withMutationCheck, withWorkTreeRootCache, workTreeRoot } =
  await import("../../src/lib/snapshot.mjs");
const { removePath } = await import("../runtime-helpers.mjs");

const rootCalls = () => gitCalls.filter((call) => call.args[1] === "--show-toplevel");

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-root-cache-"));
  await execa("git", ["init"], { cwd: dir });
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "a.txt"), "a\n");
  return dir;
}

// Usefulness: verifies one run resolves the work tree root once per directory, not once per
// snapshot (#760). Without the run scope the same calls repeat, which is the Windows cost.
test("a run scope resolves the work tree root once for repeated snapshots of one directory", async () => {
  const repo = await createRepo();
  try {
    gitCalls.length = 0;
    await withWorkTreeRootCache(async () => {
      await snapshot(join(repo, "sub"), {});
      await snapshot(join(repo, "sub"), {});
      await withMutationCheck(join(repo, "sub"), "reviewer", async () => {});
      await workTreeRoot(join(repo, "sub"), {});
    });
    expect(rootCalls()).toHaveLength(1);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the cache is keyed by directory, so a second directory resolves its own
// root and never reuses the answer of the first (#760).
test("a run scope resolves the root again for a different directory", async () => {
  const first = await createRepo();
  const second = await createRepo();
  try {
    gitCalls.length = 0;
    await withWorkTreeRootCache(async () => {
      await snapshot(first, {});
      await snapshot(second, {});
      await snapshot(first, {});
    });
    expect(rootCalls()).toHaveLength(2);
  } finally {
    await removePath(first);
    await removePath(second);
  }
});

// Usefulness: verifies a snapshot outside a run scope still resolves the root each time, so a
// library caller that never opens a scope sees no stale root (#760).
test("snapshots outside a run scope resolve the root each time", async () => {
  const repo = await createRepo();
  try {
    gitCalls.length = 0;
    await snapshot(repo, {});
    await snapshot(repo, {});
    expect(rootCalls()).toHaveLength(2);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a failed root lookup is not cached, so a directory that becomes a work tree
// later in the run resolves instead of failing again (#760).
test("a failed root lookup is not cached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-root-cache-none-"));
  try {
    await withWorkTreeRootCache(async () => {
      await expect(workTreeRoot(dir, {})).rejects.toThrow(/Git work tree/);
      await execa("git", ["init"], { cwd: dir });
      await expect(workTreeRoot(dir, {})).resolves.toBeTruthy();
    });
  } finally {
    await removePath(dir);
  }
});

// Usefulness: verifies a cached root is never served after the work tree is removed during a run,
// so the refusal `--cwd must be inside a Git work tree` still fires (#760, review of PR #764).
test("a cached root is not served after the work tree is removed", async () => {
  const repo = await createRepo();
  try {
    await withWorkTreeRootCache(async () => {
      await snapshot(repo, {});
      await rm(repo, { recursive: true, force: true });
      await expect(snapshot(repo, {})).rejects.toThrow(/--cwd must be inside a Git work tree/);
      await expect(workTreeRoot(repo, {})).rejects.toThrow(/--cwd must be inside a Git work tree/);
    });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a cached root is never served after the Git metadata of the work tree is
// lost during a run, so the same refusal fires (#760, review of PR #764).
test("a cached root is not served after the Git metadata is removed", async () => {
  const repo = await createRepo();
  try {
    await withWorkTreeRootCache(async () => {
      await snapshot(join(repo, "sub"), {});
      await rm(join(repo, ".git"), { recursive: true, force: true });
      await expect(snapshot(join(repo, "sub"), {})).rejects.toThrow(
        /--cwd must be inside a Git work tree/,
      );
    });
  } finally {
    await removePath(repo);
  }
});
