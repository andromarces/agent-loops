import { inspect } from "node:util";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
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
import { removePath, trackedTempDir } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import {
  endOwnedProcess,
  processExists,
  shimCallRecords,
  withGitHangingAfter,
} from "../process-helpers.mjs";

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
async function createRepoWithLinkedWorkTree() {
  const repo = await createTempRepo();
  dirs.push(repo);
  const parent = await trackedTempDir("agent-loops-shared-git-", dirs);
  const linked = join(parent, "linked");
  await execa("git", ["worktree", "add", "-b", "linked-branch", linked], { cwd: repo });
  return { repo, linked };
}

async function changedBy(cwd, change, options) {
  const before = await readSharedGit(cwd, options);
  await change();
  return diffSharedGit(before, await readSharedGit(cwd, options));
}

// A temporary global config file and the environment that points git at it, with no system config.
async function tempGlobalConfig() {
  const dir = await trackedTempDir("agent-loops-global-git-", dirs);
  const file = join(dir, "config");
  return { file, env: { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1" } };
}

// Usefulness: verifies "a turn that changes none of the shared Git state reports nothing", so the
// envelope field stays absent and a clean turn is never read as a change.
test("an unchanged repository reports no shared Git change", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  expect(await changedBy(linked, async () => {})).toEqual([]);
});

// Usefulness: verifies "a changed core.hooksPath is reported by name from a linked work tree", the
// Husky-migration case of issue #984; it is not covered by the hook-file or remote checks.
test("a changed core.hooksPath is reported by name and never by value", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "core.hooksPath", "secret-hooks-dir"], { cwd: linked }),
  );
  expect(changed).toEqual(["core.hooksPath"]);
  expect(JSON.stringify(await readSharedGit(repo))).not.toContain("secret-hooks-dir");
});

// Usefulness: verifies "an unset core.hooksPath is reported", the other half of the migration.
test("an unset core.hooksPath is reported", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "core.hooksPath", ".husky"], { cwd: repo });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--unset", "core.hooksPath"], { cwd: repo }),
  );
  expect(changed).toEqual(["core.hooksPath"]);
});

// Usefulness: verifies "a core.bare change in the shared config is reported by name from a linked
// work tree" (issue #1387). The main work tree then reads as bare, and no other watched item
// covers it.
test("a core.bare change in the shared config is reported by name from a linked work tree", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "core.bare", "true"], { cwd: linked }),
  );
  expect(changed).toEqual(["core.bare"]);
});

// Usefulness: verifies requirement "a core.bare change in the main work tree's worktree config is
// reported by name" (issue #1392). The linked read sees no other watched item for this change.
test("a core.bare change in the main work tree's worktree config is reported by name", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repo });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--worktree", "core.bare", "true"], { cwd: repo }),
  );
  expect(changed).toEqual(["core.bare"]);
});

// Usefulness: verifies requirement "a global core.hooksPath change is reported by name" (issue
// #1392). The test points `GIT_CONFIG_GLOBAL` at a temporary file, so no user config is read.
test("a global core.hooksPath change is reported by name and never by value", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const { env } = await tempGlobalConfig();
  await writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Global Tester\n");
  const changed = await changedBy(
    linked,
    () =>
      execa("git", ["config", "--global", "core.hooksPath", "global-secret-hooks"], {
        cwd: linked,
        env,
      }),
    { env },
  );
  expect(changed).toEqual(["core.hooksPath"]);
  expect(JSON.stringify(await readSharedGit(linked, { env }))).not.toContain("global-secret-hooks");
});

// Usefulness: verifies requirement "a watched key in the global config is reported by name" (issue
// #1392). The field covers the global scope and names the key only.
test("a watched key change in the global config is reported by name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const { env } = await tempGlobalConfig();
  await writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Global Tester\n");
  const changed = await changedBy(
    linked,
    () =>
      execa("git", ["config", "--global", "extensions.worktreeConfig", "true"], {
        cwd: linked,
        env,
      }),
    { env },
  );
  expect(changed).toEqual(["extensions.worktreeconfig"]);
});

// Usefulness: verifies requirement "a turn that changes no watched key in either scope carries no
// field" (issue #1392 acceptance). Both new scopes hold only unwatched keys.
test("unwatched keys in the global config and the main work tree config report nothing", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  const { env } = await tempGlobalConfig();
  await writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Global Tester\n");
  await execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repo, env });
  await execa("git", ["config", "--worktree", "user.email", "main@example.test"], {
    cwd: repo,
    env,
  });
  expect(await changedBy(linked, async () => {}, { env })).toEqual([]);
});

// Usefulness: verifies requirement "a global config file that a turn creates is read" (issue
// #1392). The file is absent before the turn, so the read must not fail.
test("a global config file created by the turn reports its watched key", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const { env } = await tempGlobalConfig();
  const changed = await changedBy(
    linked,
    () =>
      execa("git", ["config", "--global", "core.hooksPath", "new-hooks"], {
        cwd: linked,
        env,
      }),
    { env },
  );
  expect(changed).toEqual(["core.hooksPath"]);
});

// Usefulness: verifies requirement "a config.worktree that Git ignores is not read" (issue #1392
// review). With `extensions.worktreeConfig` off, the main work tree does not use the file.
test("a main work tree worktree config is ignored while extensions.worktreeConfig is off", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  await writeFile(join(repo, ".git", "config.worktree"), "[core]\n\tbare = true\n");
  expect(await changedBy(linked, async () => {})).toEqual([]);
});

// Usefulness: verifies requirement "turning on extensions.worktreeConfig activates the main work
// tree config" (issue #1392 review): the key it activates is named too.
test("turning on extensions.worktreeConfig reports the key it activates", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  await writeFile(join(repo, ".git", "config.worktree"), "[core]\n\tbare = true\n");
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repo }),
  );
  expect(changed).toEqual(["core.bare", "extensions.worktreeconfig"]);
});

// Usefulness: verifies the other minimum key of issue #1387, `core.worktree`, so a change that
// points Git at another work tree is named too.
test("a core.worktree change is reported by name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "core.worktree", "/another/work-tree"], { cwd: linked }),
  );
  expect(changed).toEqual(["core.worktree"]);
});

// Usefulness: verifies an `extensions.*` key of issue #1387 is reported by name.
test("an extensions key change is reported by name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: linked }),
  );
  expect(changed).toEqual(["extensions.worktreeconfig"]);
});

// Usefulness: verifies a watched key that is set and restored in the same turn reports nothing, so
// the envelope keeps no field (issue #1387 acceptance).
test("a watched key set and restored reports nothing", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, async () => {
    await execa("git", ["config", "core.bare", "true"], { cwd: linked });
    await execa("git", ["config", "core.bare", "false"], { cwd: linked });
  });
  expect(changed).toEqual([]);
});

// Usefulness: verifies a name case change alone reports nothing, because Git prints section and
// key names in lower case.
test("a key whose name changes case only reports nothing", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const before = await readSharedGit(linked);
  await execa("git", ["config", "Core.Bare", "false"], { cwd: linked });
  expect(diffSharedGit(before, await readSharedGit(linked))).toEqual([]);
});

// Usefulness: verifies a multi-valued watched key is compared by all its values, not by the
// effective one, so a changed value list is reported.
test("a changed value list of a watched key is reported by key name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--add", "core.bare", "false"], { cwd: linked });
  await execa("git", ["config", "--add", "core.bare", "false"], { cwd: linked });
  const before = await readSharedGit(linked);
  await execa("git", ["config", "--unset-all", "core.bare"], { cwd: linked });
  await execa("git", ["config", "--add", "core.bare", "false"], { cwd: linked });
  expect(diffSharedGit(before, await readSharedGit(linked))).toEqual(["core.bare"]);
});

// Usefulness: verifies requirement "a turn that removes user.name reports user.name" (issue #1442).
// No existing item names an identity key, and its loss changes every later commit.
test("a removed local identity key is reported by name", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "user.name", "Original Name"], { cwd: repo });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--local", "--unset", "user.name"], { cwd: linked }),
  );
  expect(changed).toEqual(["user.name"]);
});

// Usefulness: verifies requirement "identity and signing keys are reported keys" (issue #1442).
// Each name stays visible when one turn removes the whole local group.
test("a turn that removes identity and signing keys names each key", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const keys = ["user.name", "user.email", "user.signingkey", "commit.gpgsign", "gpg.format"];
  for (const key of keys) await execa("git", ["config", "--local", key, "value"], { cwd: linked });
  const changed = await changedBy(linked, async () => {
    for (const key of keys) {
      await execa("git", ["config", "--local", "--unset", key], { cwd: linked });
    }
  });
  expect(changed).toEqual(keys.sort());
});

// Usefulness: verifies requirement "a branch.<name>.* key stays out" (issue #1442). A normal
// `git push -u` writes those keys, so reporting them adds noise to every pushed turn.
test("a local branch key change is not reported", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, async () => {
    await execa("git", ["config", "--local", "branch.linked-branch.remote", "origin"], {
      cwd: linked,
    });
    await execa("git", ["config", "--local", "branch.linked-branch.merge", "refs/heads/main"], {
      cwd: linked,
    });
  });
  expect(changed).toEqual([]);
});

// Usefulness: verifies requirement "a global identity key change stays out of the local report"
// (issue #1442). The field covers the local (shared) scope only.
test("a global identity key change is not reported", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const { env } = await tempGlobalConfig();
  await writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Global Name\n");
  const changed = await changedBy(
    linked,
    () => execa("git", ["config", "--global", "user.name", "Changed Name"], { cwd: linked, env }),
    { env },
  );
  expect(changed).toEqual([]);
});

// Usefulness: verifies requirement "a multi-valued local key that gains a value is reported"
// (issue #1442). The whole value list, not the effective value, is the compared state.
test("a local key that gains a value is reported by name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "--add", "demo.key", "one"], { cwd: linked });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--local", "--add", "demo.key", "two"], { cwd: linked }),
  );
  expect(changed).toEqual(["demo.key"]);
});

// Usefulness: verifies requirement "a multi-valued local key that loses one value is reported"
// (issue #1442). Dropping only the effective value misses a list that still looks set.
test("a local key that loses a value is reported by name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "--add", "demo.key", "one"], { cwd: linked });
  await execa("git", ["config", "--local", "--add", "demo.key", "two"], { cwd: linked });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--local", "--unset", "demo.key", "one"], { cwd: linked }),
  );
  expect(changed).toEqual(["demo.key"]);
});

// Usefulness: verifies requirement "a multi-valued local key whose values reorder is reported"
// (issue #1442). Keeping the same set in one order must still count as a change.
test("a local key whose values reorder is reported by name", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "--add", "demo.key", "one"], { cwd: linked });
  await execa("git", ["config", "--local", "--add", "demo.key", "two"], { cwd: linked });
  const changed = await changedBy(linked, async () => {
    await execa("git", ["config", "--local", "--unset-all", "demo.key"], { cwd: linked });
    await execa("git", ["config", "--local", "--add", "demo.key", "two"], { cwd: linked });
    await execa("git", ["config", "--local", "--add", "demo.key", "one"], { cwd: linked });
  });
  expect(changed).toEqual(["demo.key"]);
});

// Usefulness: verifies requirement "a local section or key name that differs only in case reports
// nothing" (issue #1442). Git prints those names in lower case, so the key is the same.
test("a local section or key name that differs only in case reports nothing", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "Demo.Key", "one"], { cwd: linked });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--local", "demo.key", "one"], { cwd: linked }),
  );
  expect(changed).toEqual([]);
});

// Usefulness: verifies requirement "a local subsection name that differs only in case keeps both
// spellings" (issue #1442). A subsection name is case-sensitive in Git config.
test("a local subsection name that differs only in case names both keys", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "demo.Sub.key", "one"], { cwd: linked });
  const changed = await changedBy(linked, async () => {
    await execa("git", ["config", "--local", "demo.sub.key", "two"], { cwd: linked });
    await execa("git", ["config", "--local", "--unset", "demo.Sub.key"], { cwd: linked });
  });
  expect(changed).toEqual(["demo.Sub.key", "demo.sub.key"]);
});

// Usefulness: verifies requirement "a removed local section names each key it held" (issue #1442).
// A section removal drops several keys in one edit, and each name must survive.
test("a removed local section names each key it held", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await execa("git", ["config", "--local", "demo.first", "one"], { cwd: linked });
  await execa("git", ["config", "--local", "demo.second", "two"], { cwd: linked });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--local", "--remove-section", "demo"], { cwd: linked }),
  );
  expect(changed).toEqual(["demo.first", "demo.second"]);
});

// Usefulness: verifies requirement "a boolean local key with no = is reported by name" (issue
// #1442). Git prints such a key with no value, and it must not read as absent.
test("a local key with no value is reported by name", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    appendFile(join(repo, ".git", "config"), "\n[demo]\n\tflag\n"),
  );
  expect(changed).toEqual(["demo.flag"]);
});

// Usefulness: verifies requirement "a local value with a newline still names the key once" (issue
// #1442). A line-based read splits the value and loses the next key.
test("a local value with a newline names the key and never the value", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, async () => {
    await execa("git", ["config", "--local", "demo.key", "first\nsecond"], { cwd: linked });
    await execa("git", ["config", "--local", "demo.other", "third"], { cwd: linked });
  });
  expect(changed).toEqual(["demo.key", "demo.other"]);
  expect(JSON.stringify(await readSharedGit(linked))).not.toContain("first");
});

// Usefulness: verifies requirement "a removed local key with a URL subsection is reported" (issue
// #1442). The key can change which remote URL gains a credential helper.
test("a removed local key with a URL subsection is reported", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
  const key = "includeIf.hasconfig:remote.*.url:https://example.test/**.path";
  await execa("git", ["config", "--local", key, "include-file"], { cwd: repo });
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "--local", "--unset", key], { cwd: linked }),
  );
  expect(changed).toEqual(["includeif.hasconfig:remote.*.url:https://example.test/**.path"]);
});

// Usefulness: verifies requirement "a changed key with userinfo in its subsection is redacted"
// (issue #1442). The userinfo can hold a credential, and the key name stays visible.
test("a changed local key with userinfo in its subsection is redacted", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa(
      "git",
      ["config", "--local", "http.https://user:token-8@example.test/.extraheader", "value"],
      { cwd: linked },
    ),
  );
  expect(changed).toEqual(["http.https://<redacted>@example.test/.extraheader"]);
  expect(JSON.stringify(await readSharedGit(linked))).not.toContain("token-8");
});

// Usefulness: verifies requirement "two keys that differ only in userinfo stay two entries" (issue
// #1442). Their redacted names are equal, and the report keeps both changes.
test("two local keys that differ only in userinfo keep two entries", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, async () => {
    await execa(
      "git",
      ["config", "--local", "http.https://alice:one@example.test/.extraheader", "a"],
      {
        cwd: linked,
      },
    );
    await execa(
      "git",
      ["config", "--local", "http.https://bob:two@example.test/.extraheader", "b"],
      {
        cwd: linked,
      },
    );
  });
  const name = "http.https://<redacted>@example.test/.extraheader";
  expect(changed).toEqual([name, name]);
});

// Usefulness: verifies a config subsection that can hold a URL is reported with redacted userinfo,
// so no credential reaches the envelope.
test("a URL subsection key is reported with redacted userinfo", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "credential.https://user:token-8@example.test.helper", "store"], {
      cwd: linked,
    }),
  );
  expect(changed).toEqual(["credential.https://<redacted>@example.test.helper"]);
  expect(JSON.stringify(await readSharedGit(linked))).not.toContain("token-8");
});

// Usefulness: verifies a config subsection under a watched section is reported with redacted
// userinfo, because every local key counts (issue #1442).
test("an extensions subsection key is reported with redacted userinfo", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const changed = await changedBy(linked, () =>
    execa("git", ["config", "extensions.https://user:token-8@example.test.flag", "true"], {
      cwd: linked,
    }),
  );
  expect(changed).toEqual(["extensions.https://<redacted>@example.test.flag"]);
  expect(JSON.stringify(await readSharedGit(linked))).not.toContain("token-8");
});

// Usefulness: verifies "a hook file written, edited, or removed in the common hooks directory is
// reported by its file name".
test("an added, edited, and removed hook file is reported by name", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
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
  const { repo, linked } = await createRepoWithLinkedWorkTree();
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
  const { repo, linked } = await createRepoWithLinkedWorkTree();
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
    const { repo, linked } = await createRepoWithLinkedWorkTree();
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
  const { linked } = await createRepoWithLinkedWorkTree();
  fsFailure.stallReaddir = true;
  const started = Date.now();
  await expect(readSharedGit(linked, { deadlineMs: 500 })).rejects.toThrow(/500 ms/);
  expect(Date.now() - started).toBeLessThan(5_000);
});

// Usefulness: verifies requirement "the deadline aborts with the default abort reason" (#1269): the
// helper shared by three reads must not give the shared Git read a named error as its reason.
test("the deadline aborts the git calls with the default abort reason", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
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

// Usefulness: verifies requirement "every git process of the read has ended when it rejects at its
// deadline" (issue #1315). A deadline that stops waiting without ending the git processes leaves
// them running past the end of a canceled turn.
test("every git process of the read has ended when the read rejects at its deadline", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  await withGitHangingAfter(1, async ({ shimDir }) => {
    // Warm the shim so the read's two hung calls start before the short deadline (issue #1465).
    await execa("git", ["--version"]);
    // The case waits out this 200 ms deadline because the deadline ending the hang is what it tests.
    const failure = await readSharedGit(linked, { deadlineMs: 200 }).catch((err) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/200 ms/);
    const records = (await shimCallRecords(shimDir)).filter(({ number }) => number > 0);
    expect(records).toHaveLength(2);
    try {
      // `readWithin` awaits both git reads before it throws (`src/lib/shared-git.mjs` line 50), so
      // the check needs no wait. An error other than ESRCH reads as alive and fails the test.
      for (const { pid } of records) expect(processExists(pid)).toBe(false);
    } finally {
      if (process.platform !== "win32") {
        for (const { pid } of records) await endOwnedProcess(pid, shimDir);
      }
    }
  });
}, 20_000);

// Usefulness: verifies requirement "the read stops at the deadline" (issue #1224): a hook `lstat`
// that ends after the deadline must not be followed by a `readFile` or by the next hook, because the
// dispatch has reported its result and a late file system request would run past the end of the turn.
test("no hook file system request starts after the deadline", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
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
  const { linked } = await createRepoWithLinkedWorkTree();
  const controller = new AbortController();
  controller.abort();
  await expect(
    readSharedGit(linked, { deadlineMs: 60_000, signal: controller.signal }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies "an unexpected `git config` exit is a read failure, not an empty state"
// (issue #984 review): an empty state read before or after a turn would report a false change.
test("a git config read that exits unexpectedly rejects", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  configExit.code = 128;
  await expect(readSharedGit(linked)).rejects.toThrow(/config/);
});

// Usefulness: verifies "a Git without `--show-scope` fails the read", so the caller warns and
// reports no change instead of a false one (issue #1387).
test("a git without --show-scope rejects the read", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  configExit.code = 129;
  await expect(readSharedGit(linked)).rejects.toThrow(/config/);
});

// Usefulness: verifies "exit 1 from `git config` is the documented unset value, not a failure", so
// a repository with no hooksPath and no remote still reads.
test("a git config read that exits 1 for an unset key reads as empty", async () => {
  const { linked } = await createRepoWithLinkedWorkTree();
  const state = await readSharedGit(linked);
  expect(state.remotes).toEqual({});
});

// Usefulness: verifies "a failed shared Git read names only the failed operation and an exit code"
// (issue #984 review): git's stderr can carry a config value, here the path of an include.path
// entry, and the error reaches the warning log.
test("a failed read never carries git stderr or a config value", async () => {
  const { repo, linked } = await createRepoWithLinkedWorkTree();
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
  const { repo, linked } = await createRepoWithLinkedWorkTree();
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
    const { repo, linked } = await createRepoWithLinkedWorkTree();
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
  const dir = await trackedTempDir("agent-loops-shared-git-none-", dirs);
  await expect(readSharedGit(dir)).rejects.toThrow();
});
