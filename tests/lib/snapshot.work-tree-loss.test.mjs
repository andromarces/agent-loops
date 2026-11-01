import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { snapshot, withMutationCheck } from "../../src/lib/snapshot.mjs";
import { removePath } from "../fs-helpers.mjs";

const REFUSAL = /--cwd must be inside a Git work tree/;

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-loss-"));
  await execa("git", ["init"], { cwd: dir });
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "a.txt"), "a\n");
  return dir;
}

// Usefulness: verifies a work tree removed between two snapshots of one run is refused, so a
// resolved root is never carried from one snapshot to the next (#760).
test("a snapshot refuses a work tree that was removed since the last snapshot", async () => {
  const repo = await createRepo();
  try {
    await snapshot(repo, {});
    await rm(repo, { recursive: true, force: true });
    await expect(snapshot(repo, {})).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a --cwd below the root that is removed since the last snapshot is refused
// although its root survives (#760).
test("a snapshot refuses a subdirectory cwd that was removed while its root survives", async () => {
  const repo = await createRepo();
  try {
    await snapshot(join(repo, "sub"), {});
    await rm(join(repo, "sub"), { recursive: true });
    await expect(snapshot(join(repo, "sub"), {})).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a --cwd that is replaced by a file is refused (#760).
test("a snapshot refuses a cwd that became a file", async () => {
  const repo = await createRepo();
  try {
    await snapshot(join(repo, "sub"), {});
    await rm(join(repo, "sub"), { recursive: true });
    await writeFile(join(repo, "sub"), "file\n");
    await expect(snapshot(join(repo, "sub"), {})).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a work tree that lost its `.git` directory since the last snapshot is
// refused (#760).
test("a snapshot refuses a work tree that lost its .git directory", async () => {
  const repo = await createRepo();
  try {
    await snapshot(join(repo, "sub"), {});
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await expect(snapshot(join(repo, "sub"), {})).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a surviving `.git` directory without HEAD is refused (#760).
test("a snapshot refuses a .git directory that lost HEAD", async () => {
  const repo = await createRepo();
  try {
    await snapshot(join(repo, "sub"), {});
    await rm(join(repo, ".git", "HEAD"));
    await expect(snapshot(join(repo, "sub"), {})).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a linked work tree whose gitdir target is removed is refused (#760).
test("a snapshot refuses a linked work tree whose gitdir was removed", async () => {
  const repo = await createRepo();
  const linked = `${repo}-linked`;
  try {
    const git = (...args) =>
      execa("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
    await git("add", ".");
    await git("commit", "-m", "initial");
    await git("worktree", "add", linked);
    await snapshot(linked, {});
    const admin = join(repo, ".git", "worktrees");
    for (const name of await readdir(admin)) {
      await rm(join(admin, name), { recursive: true, force: true });
    }
    await expect(snapshot(linked, {})).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(linked);
    await removePath(repo);
  }
});

// Usefulness: verifies a root that changes between two snapshots is read again. A subdirectory
// that becomes its own work tree is covered from its new root, so a root is never carried over (#760).
test("a snapshot covers the new root after the cwd becomes its own work tree", async () => {
  const repo = await createRepo();
  try {
    const first = await snapshot(join(repo, "sub"), {});
    expect(first.workTree.map((entry) => entry.path)).toContain("sub/a.txt");
    await execa("git", ["init"], { cwd: join(repo, "sub") });
    const second = await snapshot(join(repo, "sub"), {});
    expect(second.workTree.map((entry) => entry.path)).toEqual(["a.txt"]);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a genuine Git failure of a snapshot surfaces with its own error, not the
// refusal, because the work tree is still a work tree (#760).
test("a snapshot keeps the original error of a genuine Git failure", async () => {
  const repo = await createRepo();
  try {
    await snapshot(repo, {});
    await writeFile(join(repo, ".git", "index"), "not an index");
    await expect(snapshot(repo, {})).rejects.toThrow(/git status failed \(exit 128\)/);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the mutation check reports the path that a turn changed (#760).
test("withMutationCheck reports the path that a turn changed", async () => {
  const repo = await createRepo();
  try {
    await expect(
      withMutationCheck(repo, "reviewer", () => writeFile(join(repo, "sub", "a.txt"), "b\n")),
    ).rejects.toMatchObject({ name: "MutationError", paths: ["sub/a.txt"] });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a --cwd subdirectory that is removed during a mutation-checked turn while
// its repository survives is refused, so sharing one root between the two snapshots of a turn
// never weakens the check of the original --cwd (#760, #1268).
test("withMutationCheck refuses a subdirectory cwd that was removed during the turn", async () => {
  const repo = await createRepo();
  try {
    await expect(
      withMutationCheck(join(repo, "sub"), "reviewer", () =>
        rm(join(repo, "sub"), { recursive: true }),
      ),
    ).rejects.toThrow(REFUSAL);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies an ancestor of --cwd that is replaced by a link into a subdirectory of another repository
// during a mutation-checked turn is refused, as the repository change it is, even though the
// ignored ancestor leaves the old repository unchanged (#760, #1268). A junction is the link on
// Windows. The test skips where the system refuses to create the link.
test("withMutationCheck refuses a cwd whose ancestor became a link into another repository", async (ctx) => {
  const repo = await createRepo();
  const other = await createRepo();
  try {
    await writeFile(join(repo, ".gitignore"), "pivot/\n");
    await mkdir(join(repo, "pivot", "sub"), { recursive: true });
    await writeFile(join(repo, "pivot", "sub", "a.txt"), "a\n");
    await mkdir(join(other, "inner", "sub"), { recursive: true });
    await writeFile(join(other, "inner", "sub", "a.txt"), "b\n");
    const swap = async () => {
      await rm(join(repo, "pivot"), { recursive: true });
      try {
        await symlink(join(other, "inner"), join(repo, "pivot"), "junction");
      } catch (err) {
        if (err.code === "EPERM" || err.code === "EACCES") return false;
        throw err;
      }
      return true;
    };
    let linked = true;
    const outcome = await withMutationCheck(join(repo, "pivot", "sub"), "reviewer", async () => {
      linked = await swap();
    }).then(
      () => null,
      (err) => err,
    );
    if (!linked) ctx.skip();
    expect(outcome).toMatchObject({ name: "MutationError" });
  } finally {
    await removePath(repo);
    await removePath(other);
  }
});
