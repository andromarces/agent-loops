import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
// Makes every `git config` call exit with `configExit.code` when set; other calls reach real git.
const configExit = vi.hoisted(() => ({ code: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      configExit.code !== null && args[0] === "config"
        ? { exitCode: configExit.code, stdout: "", stderr: "fatal: bad config line 1" }
        : real.execa(command, args, options),
  };
});

import { diffSharedGit, readSharedGit } from "../../src/lib/shared-git.mjs";
import { createTempRepo, removePath } from "../runtime-helpers.mjs";

const dirs = [];

afterEach(async () => {
  configExit.code = null;
  for (const dir of dirs.splice(0)) await removePath(dir);
});

// A repository and a linked work tree of it, so the shared state sits in the common directory.
async function createLinkedWorkTree() {
  const repo = await createTempRepo();
  dirs.push(repo);
  const parent = await mkdtemp(join(tmpdir(), "agent-loops-shared-git-"));
  dirs.push(parent);
  const linked = join(parent, "linked");
  await execa("git", ["worktree", "add", "-b", "linked-branch", linked], { cwd: repo });
  return { repo, linked };
}

async function changedBy(cwd, change) {
  const before = await readSharedGit(cwd);
  await change();
  return diffSharedGit(before, await readSharedGit(cwd));
}

// Usefulness: verifies "a turn that changes none of the shared Git state reports nothing", so the
// envelope field stays absent and a clean turn is never read as a change.
test("an unchanged repository reports no shared Git change", async () => {
  const { linked } = await createLinkedWorkTree();
  expect(await changedBy(linked, async () => {})).toEqual([]);
});

// Usefulness: verifies "a changed core.hooksPath is reported by name from a linked work tree", the
// Husky-migration case of issue #984; it is not covered by the hook-file or remote checks.
test("a changed core.hooksPath is reported by name and never by value", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "core.hooksPath", "secret-hooks-dir"], { cwd: linked }),
  );
  expect(changed).toEqual(["core.hooksPath"]);
  expect(JSON.stringify(await readSharedGit(repo))).not.toContain("secret-hooks-dir");
});

// Usefulness: verifies "an unset core.hooksPath is reported", the other half of the migration.
test("an unset core.hooksPath is reported", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  await execa("git", ["config", "core.hooksPath", ".husky"], { cwd: repo });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--unset", "core.hooksPath"], { cwd: repo }),
  );
  expect(changed).toEqual(["core.hooksPath"]);
});

// Usefulness: verifies "a hook file written, edited, or removed in the common hooks directory is
// reported by its file name".
test("an added, edited, and removed hook file is reported by name", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  const hooks = join(repo, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");

  const changed = await changedBy(linked, async () => {
    await writeFile(join(hooks, "commit-msg"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    await rm(join(hooks, "pre-push"));
  });
  expect(changed).toEqual(["hooks/commit-msg", "hooks/pre-commit", "hooks/pre-push"]);
});

// Usefulness: verifies "the sample hooks that `git init` writes are not active hooks", so a stale
// sample never reads as a change.
test("a sample hook file is not reported", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  const hooks = join(repo, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  const changed = await changedBy(linked, () =>
    writeFile(join(hooks, "pre-push.sample"), "#!/bin/sh\n"),
  );
  expect(changed).toEqual([]);
});

// Usefulness: verifies "an added, retargeted, and removed remote is reported by name and never by
// URL", so a credentialed URL never reaches the envelope.
test("an added, retargeted, and removed remote is reported by name without its URL", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  await execa("git", ["remote", "add", "origin", "https://example.test/a.git"], { cwd: repo });
  await execa("git", ["remote", "add", "gone", "https://example.test/gone.git"], { cwd: repo });

  const before = await readSharedGit(linked);
  await execa("git", ["remote", "add", "extra", "https://user:token-9@example.test/x.git"], {
    cwd: linked,
  });
  await execa("git", ["remote", "set-url", "origin", "https://example.test/b.git"], {
    cwd: linked,
  });
  await execa("git", ["remote", "remove", "gone"], { cwd: linked });
  const after = await readSharedGit(linked);

  expect(diffSharedGit(before, after)).toEqual(["remote.extra", "remote.gone", "remote.origin"]);
  expect(JSON.stringify(after)).not.toContain("token-9");
});

// Usefulness: verifies "a change to the local core.hooksPath is reported even when a worktree
// config overrides it" (issue #984 review): the effective value is the override, so a read of the
// effective value alone hides the change. Both the main and a linked work tree read it.
for (const place of ["main", "linked"]) {
  test(`a local core.hooksPath change under a worktree override is reported from the ${place} work tree`, async () => {
    const { repo, linked } = await createLinkedWorkTree();
    const cwd = place === "main" ? repo : linked;
    await execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repo });
    await execa("git", ["config", "--local", "core.hooksPath", "local-a"], { cwd });
    await execa("git", ["config", "--worktree", "core.hooksPath", "worktree-a"], { cwd });

    const changed = await changedBy(cwd, () =>
      execa("git", ["config", "--local", "core.hooksPath", "local-b"], { cwd }),
    );
    expect(changed).toEqual(["core.hooksPath"]);

    const worktreeChanged = await changedBy(cwd, () =>
      execa("git", ["config", "--worktree", "core.hooksPath", "worktree-b"], { cwd }),
    );
    expect(worktreeChanged).toEqual(["core.hooksPath"]);
  });
}

// Usefulness: verifies "an unexpected `git config` exit is a read failure, not an empty state"
// (issue #984 review): an empty state read before or after a turn would report a false change.
test("a git config read that exits unexpectedly rejects", async () => {
  const { linked } = await createLinkedWorkTree();
  configExit.code = 128;
  await expect(readSharedGit(linked)).rejects.toThrow(/config/);
});

// Usefulness: verifies "exit 1 from `git config` is the documented unset value, not a failure", so
// a repository with no hooksPath and no remote still reads.
test("a git config read that exits 1 for an unset key reads as empty", async () => {
  const { linked } = await createLinkedWorkTree();
  const state = await readSharedGit(linked);
  expect(state.remotes).toEqual({});
});

// Usefulness: verifies "a read from a directory outside a repository fails", so the caller can warn
// and omit the field instead of reporting an empty, unchanged state.
test("reading outside a repository rejects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-shared-git-none-"));
  dirs.push(dir);
  await expect(readSharedGit(dir)).rejects.toThrow();
});
