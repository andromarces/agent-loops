import { inspect } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
// Makes the named `node:fs/promises` function throw an error whose message and path carry
// `FS_MARKER`, as a Node file system error carries the path, while `fsFailure.operation` is set.
const FS_MARKER = "secret-hook-marker-7731";
// `fsFailure.requests` records every request on a file named `hook-*`, and `fsFailure.lstatDelayMs`
// delays each `lstat` of one, as a slow file system does.
const fsFailure = vi.hoisted(() => ({
  operation: null,
  stallReaddir: false,
  lstatDelayMs: 0,
  requests: [],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  const failing =
    (operation) =>
    async (path, ...rest) => {
      if (String(path).includes("hook-")) fsFailure.requests.push(operation);
      if (operation === "lstat" && fsFailure.lstatDelayMs > 0 && String(path).includes("hook-")) {
        await new Promise((resolve) => setTimeout(resolve, fsFailure.lstatDelayMs));
      }
      if (fsFailure.operation === operation) {
        const failedPath = `/${"secret-hook-marker-7731"}/${operation}`;
        throw Object.assign(new Error(`EACCES: permission denied, ${operation} '${failedPath}'`), {
          code: "EACCES",
          path: failedPath,
          syscall: operation,
        });
      }
      return real[operation](path, ...rest);
    };
  return {
    ...real,
    readdir: (...args) =>
      fsFailure.stallReaddir ? new Promise(() => {}) : failing("readdir")(...args),
    // A symlink needs a privilege on Windows, so a `readlink` failure reports every entry as one.
    lstat: (...args) =>
      fsFailure.operation === "readlink"
        ? { isSymbolicLink: () => true }
        : failing("lstat")(...args),
    readFile: failing("readFile"),
    readlink: failing("readlink"),
  };
});
// Makes every `git config` call exit with `configExit.code` when set; other calls reach real git.
const configExit = vi.hoisted(() => ({ code: null, signals: [] }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      if (options?.cancelSignal) configExit.signals.push(options.cancelSignal);
      return configExit.code !== null && args[0] === "config"
        ? { exitCode: configExit.code, stdout: "", stderr: "fatal: bad config line 1" }
        : real.execa(command, args, options);
    },
  };
});

import { firstErrorLine, readableErrorText } from "../../src/lib/error-message.mjs";
import { diffSharedGit, readSharedGit } from "../../src/lib/shared-git.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

const dirs = [];

afterEach(async () => {
  configExit.code = null;
  configExit.signals.length = 0;
  fsFailure.operation = null;
  fsFailure.stallReaddir = false;
  fsFailure.lstatDelayMs = 0;
  fsFailure.requests.length = 0;
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

// Usefulness: verifies requirement "a stalled hooks directory read ends at the deadline" (issue
// #1224): the deadline covers the whole read, not the `git` processes alone, so a canceled worker
// turn that reads the shared Git state after the cancel reports within the bound.
test("a stalled hooks directory read rejects at the deadline", async () => {
  const { linked } = await createLinkedWorkTree();
  fsFailure.stallReaddir = true;
  const started = Date.now();
  await expect(readSharedGit(linked, { deadlineMs: 500 })).rejects.toThrow(/500 ms/);
  expect(Date.now() - started).toBeLessThan(5_000);
});

// Usefulness: verifies requirement "the deadline aborts with the default abort reason" (#1269): the
// helper shared by three reads must not give the shared Git read a named error as its reason.
test("the deadline aborts the git calls with the default abort reason", async () => {
  const { linked } = await createLinkedWorkTree();
  fsFailure.stallReaddir = true;
  await expect(readSharedGit(linked, { deadlineMs: 500 })).rejects.toThrow(/500 ms/);
  expect(configExit.signals.length).toBeGreaterThan(0);
  for (const signal of configExit.signals) {
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({
      name: "AbortError",
      message: "This operation was aborted",
    });
  }
});

// Usefulness: verifies requirement "the read stops at the deadline" (issue #1224): a hook `lstat`
// that ends after the deadline must not be followed by a `readFile` or by the next hook, because the
// dispatch has reported its result and a late file system request would run past the end of the turn.
test("no hook file system request starts after the deadline", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  for (let i = 0; i < 8; i += 1) await writeFile(join(repo, ".git", "hooks", `hook-${i}`), `#${i}`);
  fsFailure.lstatDelayMs = 800;
  await expect(readSharedGit(linked, { deadlineMs: 2_000 })).rejects.toThrow(/2000 ms/);
  const atDeadline = [...fsFailure.requests];
  expect(atDeadline).toContain("lstat");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(fsFailure.requests).toEqual(atDeadline);
}, 20_000);

// Usefulness: verifies requirement "a turn signal and a deadline both stop the read" (issue #1224):
// passing both must not drop the turn signal.
test("a canceled turn signal stops a read that also has a deadline", async () => {
  const { linked } = await createLinkedWorkTree();
  const controller = new AbortController();
  controller.abort();
  await expect(
    readSharedGit(linked, { deadlineMs: 60_000, signal: controller.signal }),
  ).rejects.toMatchObject({ isCanceled: true });
});

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

// Usefulness: verifies "a failed shared Git read names only the failed operation and an exit code"
// (issue #984 review): git's stderr can carry a config value, here the path of an include.path
// entry, and the error reaches the warning log.
test("a failed read never carries git stderr or a config value", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  const include = join(repo, "secret-include-4821");
  await mkdir(include);
  await execa("git", ["config", "include.path", include], { cwd: repo });

  const failure = await readSharedGit(linked).catch((err) => err);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toMatch(/exit 128/);
  expect(failure.message).not.toMatch(/secret-include-4821|fatal|warning/);
});

// Usefulness: verifies "a swapped order of two URLs of one remote is reported" (issue #984 review):
// the first URL is the one `git remote get-url` returns, so the order is part of the state.
test("a reordered value list of one remote key is reported by remote name", async () => {
  const { repo, linked } = await createLinkedWorkTree();
  await execa("git", ["remote", "add", "origin", "https://example.test/a.git"], { cwd: repo });
  await execa("git", ["remote", "set-url", "--add", "origin", "https://example.test/b.git"], {
    cwd: repo,
  });

  const changed = await changedBy(linked, async () => {
    await execa("git", ["config", "--unset-all", "remote.origin.url"], { cwd: repo });
    await execa("git", ["config", "--add", "remote.origin.url", "https://example.test/b.git"], {
      cwd: repo,
    });
    await execa("git", ["config", "--add", "remote.origin.url", "https://example.test/a.git"], {
      cwd: repo,
    });
  });
  expect(changed).toEqual(["remote.origin"]);
});

// Usefulness: verifies "a failed hook read names only the operation and the error code" (issue #984
// review): a Node file system error carries the path, and a hook path or a symlink target can carry
// a secret. The marker must stay out of the thrown error, its cause chain, and the text that the
// worker-turn warning is built from.
test.each(["readdir", "lstat", "readFile", "readlink"])(
  "a failed %s of the hooks directory never exposes the path",
  async (operation) => {
    const { repo, linked } = await createLinkedWorkTree();
    const hooks = join(repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");
    fsFailure.operation = operation;

    const failure = await readSharedGit(linked).catch((err) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(new RegExp(`EACCES`));
    const exposed = [
      inspect(failure, { depth: null, showHidden: true }),
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
      firstErrorLine(readableErrorText(failure)),
      String(failure.cause ?? ""),
    ].join("\n");
    expect(exposed).not.toContain(FS_MARKER);
    expect(failure.cause).toBeUndefined();
  },
);

// Usefulness: verifies "a read from a directory outside a repository fails", so the caller can warn
// and omit the field instead of reporting an empty, unchanged state.
test("reading outside a repository rejects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-shared-git-none-"));
  dirs.push(dir);
  await expect(readSharedGit(dir)).rejects.toThrow();
});
