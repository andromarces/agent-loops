import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { execa } from "execa";
import { copyLocalFiles, MAX_WALKED_ENTRIES } from "../../src/lib/local-files.mjs";
import { reviewedState, snapshot } from "../../src/lib/snapshot.mjs";
import { createLinkedWorkTree, removePath } from "../runtime-helpers.mjs";

const SECRET = "TOKEN-VALUE-MUST-NOT-APPEAR";
const created = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await removePath(dir);
  }
});

async function git(cwd, ...args) {
  return execa("git", args, { cwd });
}

async function createLinked(options) {
  const tree = await createLinkedWorkTree(options);
  created.push(tree.base);
  return tree;
}

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

// Usefulness: verifies an untracked, ignored file and a directory of such files reach
// the linked work tree with the source bytes.
// Not redundant: it is the only test that reads the copied bytes and the nested path,
// so a copy that makes empty, wrong, or misplaced files fails only here.
test("copies ignored untracked files and directory contents into the linked work tree", async () => {
  const { main, linked } = await createLinked({ ignore: [".env", "AGENTS.md", ".claude/"] });
  await writeFile(join(main, ".env"), `KEY=${SECRET}\n`);
  await writeFile(join(main, "AGENTS.md"), "local rules\n");
  await mkdir(join(main, ".claude", "sub"), { recursive: true });
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");
  await writeFile(join(main, ".claude", "sub", "deep.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual(
    [".claude/settings.json", ".claude/sub/deep.json", ".env", "AGENTS.md"].sort(),
  );
  expect(report.skipped).toEqual([]);
  expect(await readFile(join(linked, ".env"), "utf8")).toBe(`KEY=${SECRET}\n`);
  expect(await readFile(join(linked, ".claude", "sub", "deep.json"), "utf8")).toBe("{}\n");
});

// Usefulness: verifies an untracked path that no ignore source covers in the linked
// work tree is skipped and named, never copied.
// Not redundant: it is the only test of condition 3 failing, so a copy that skips the
// check-ignore step fails only here.
test("skips an untracked path that is not ignored in the linked work tree and names it", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, "CLAUDE.md"), "not ignored\n");
  await writeFile(join(main, ".env"), "A=1\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".env"]);
  expect(report.skipped).toEqual(["CLAUDE.md"]);
  expect(await exists(join(linked, "CLAUDE.md"))).toBe(false);
});

// Usefulness: verifies the ignore rule is read in the linked work tree, so a
// `.gitignore` of the linked branch alone makes a file copyable.
// Not redundant: the other tests use the shared exclude file, so a check that reads the
// main work tree instead of `--cwd` fails only here.
test("honors a .gitignore of the branch checked out in the linked work tree", async () => {
  const { main, linked } = await createLinked();
  await writeFile(join(linked, ".gitignore"), ".mcp.json\n");
  await git(linked, "add", ".gitignore");
  await git(linked, "commit", "-m", "ignore");
  await writeFile(join(main, ".mcp.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".mcp.json"]);
});

// Usefulness: verifies a partly tracked directory copies only its untracked, ignored
// files and leaves a tracked sibling alone.
// Not redundant: it is the only test with a tracked sibling in one directory, so a copy
// that treats a directory as one unit fails only here.
test("copies only the untracked files of a partly tracked directory", async () => {
  const { main, linked } = await createLinked({
    seed: async (repo) => {
      await writeFile(join(repo, ".gitignore"), ".vscode/*.local.json\n");
      await mkdir(join(repo, ".vscode"));
      await writeFile(join(repo, ".vscode", "settings.json"), "tracked-main\n");
      await git(repo, "add", ".gitignore", ".vscode/settings.json");
      await git(repo, "commit", "-m", "vscode");
    },
  });
  await writeFile(join(main, ".vscode", "a.local.json"), "local\n");
  await writeFile(join(linked, ".vscode", "settings.json"), "edited-in-linked\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".vscode/a.local.json"]);
  expect(await readFile(join(linked, ".vscode", "settings.json"), "utf8")).toBe(
    "edited-in-linked\n",
  );
});

// Usefulness: verifies a file that already exists in the linked work tree is not
// replaced and is reported as skipped.
// Not redundant: it is the only test with the target present before the copy starts;
// the late-target test covers a target that appears during the copy.
test("never overwrites an existing file in the linked work tree", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "from-main\n");
  await writeFile(join(linked, ".env"), "already-here\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([]);
  expect(report.skipped).toEqual([".env"]);
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("already-here\n");
});

// Usefulness: verifies a path that the main work tree tracks is not a local file, so it
// is neither copied nor reported.
// Not redundant: it is the only test with a tracked path in the main work tree, so a
// copy that skips condition 2 fails only here.
test("ignores a tracked path in the main work tree", async () => {
  const { main, linked } = await createLinked();
  await writeFile(join(main, "GEMINI.md"), "tracked\n");
  await git(main, "add", "GEMINI.md");
  await git(main, "commit", "-m", "gemini");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [] });
});

// Usefulness: verifies Claude Code's own work tree directory is never copied, though it
// is untracked and ignored.
// Not redundant: it is the only test with a file under the exact `.claude/worktrees`
// path; the case alias test covers other spellings.
test("never copies anything under .claude/worktrees", async () => {
  const { main, linked } = await createLinked({ ignore: [".claude/"] });
  await mkdir(join(main, ".claude", "worktrees", "wt"), { recursive: true });
  await writeFile(join(main, ".claude", "worktrees", "wt", "file.txt"), "x\n");
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".claude/settings.json"]);
  expect(await exists(join(linked, ".claude", "worktrees"))).toBe(false);
});

// Usefulness: verifies a nested work tree whose `.git` file is present is never walked.
// Not redundant: the registered-work-tree test removes the `.git` entry and covers the
// work tree list, so a walk that ignores the `.git` entry fails only here.
test("never copies a directory that holds another work tree", async () => {
  const { main, linked } = await createLinked({ ignore: [".agents/"] });
  const inner = join(main, ".agents", "nested-wt");
  await mkdir(join(main, ".agents"), { recursive: true });
  await git(main, "worktree", "add", inner, "-b", "nested");
  await writeFile(join(main, ".agents", "skill.md"), "s\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".agents/skill.md"]);
  expect(await exists(join(linked, ".agents", "nested-wt"))).toBe(false);
});

// Usefulness: verifies a symlink to a file or a directory outside the main work tree is
// skipped and named, so the secret behind it stays outside.
// Not redundant: it is the only test whose link target lies outside the main work tree;
// the in-tree link tests keep the target inside.
test.skipIf(process.platform === "win32")(
  "does not follow a symlink out of the main work tree",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".env", ".codex/"] });
    const outside = await mkdtemp(join(tmpdir(), "local-files-outside-"));
    created.push(outside);
    await writeFile(join(outside, "secret.txt"), `${SECRET}\n`);
    await symlink(join(outside, "secret.txt"), join(main, ".env"));
    await mkdir(join(outside, "dir"));
    await writeFile(join(outside, "dir", "inner.txt"), `${SECRET}\n`);
    await symlink(join(outside, "dir"), join(main, ".codex"));

    const report = await copyLocalFiles(linked);

    expect(report.copied).toEqual([]);
    expect(report.skipped.sort()).toEqual([".codex", ".env"]);
    expect(await exists(join(linked, ".env"))).toBe(false);
    expect(await exists(join(linked, ".codex"))).toBe(false);
  },
);

// Usefulness: verifies a file over 1 MiB is skipped and named, so a large cache is not
// duplicated into every run.
// Not redundant: it is the only test with a file over the cap, so removing both size
// guards fails only here.
test("skips a file over the size cap", async () => {
  const { main, linked } = await createLinked({ ignore: [".codex/"] });
  await mkdir(join(main, ".codex"));
  await writeFile(join(main, ".codex", "big.bin"), Buffer.alloc(1024 * 1024 + 1));
  await writeFile(join(main, ".codex", "config.toml"), "a=1\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".codex/config.toml"]);
  expect(report.skipped).toEqual([".codex/big.bin"]);
});

// Usefulness: verifies the main work tree as `--cwd` copies nothing and reports
// nothing.
// Not redundant: it is the only lib test that passes the main work tree itself, so a
// copy that skips the main-tree check fails only here.
test("returns null and changes nothing when cwd is the main work tree", async () => {
  const { main } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "A=1\n");

  expect(await copyLocalFiles(main)).toBeNull();
});

// Usefulness: verifies a repository with no main work tree copies nothing.
// Not redundant: it is the only test with a bare repository, where the first listed
// work tree is not a work tree.
test("returns null for a linked work tree of a bare repository", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-files-bare-"));
  created.push(base);
  const seed = join(base, "seed");
  await mkdir(seed);
  await git(seed, "init");
  await git(seed, "config", "user.name", "Tester");
  await git(seed, "config", "user.email", "test@example.com");
  await writeFile(join(seed, "a.txt"), "a\n");
  await git(seed, "add", "a.txt");
  await git(seed, "commit", "-m", "a");
  const bare = join(base, "bare.git");
  await execa("git", ["clone", "--bare", seed, bare]);
  const linked = join(base, "linked");
  await git(bare, "worktree", "add", linked, "-b", "run");

  expect(await copyLocalFiles(linked)).toBeNull();
});

// Usefulness: verifies copied files leave the `clean` flag and the snapshot digest
// unchanged, because a copied path is ignored.
// Not redundant: it covers a plain copy of two files, while the control-file and
// ignore-source tests cover the ways a copy could change ignore rules.
test("a copied path leaves the snapshot digest and clean flag unchanged", async () => {
  const { main, linked } = await createLinked({ ignore: [".env", ".claude/"] });
  await writeFile(join(main, ".env"), "A=1\n");
  await mkdir(join(main, ".claude"));
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");
  const before = reviewedState(await snapshot(linked));

  const report = await copyLocalFiles(linked);

  expect(report.copied.length).toBe(2);
  expect(reviewedState(await snapshot(linked))).toEqual(before);
  expect(before.clean).toBe(true);
});

// Usefulness: verifies the report holds path names only, so no file content reaches the
// envelope, the transcript, or the log.
// Not redundant: the other tests assert the lists, so a content string that enters the
// report fails only here.
test("the report carries path names only, never content", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), `KEY=${SECRET}\n`);

  const report = await copyLocalFiles(linked);

  expect(JSON.stringify(report)).not.toContain(SECRET);
});

// Usefulness: verifies a `.gitignore` or `.gitattributes` held by a listed directory is
// skipped, because a copied one could un-ignore a copied sibling and change the
// snapshot.
// Not redundant: the digest test copies no rule file, so a copy of one fails only here.
test("never copies a .gitignore or .gitattributes, so the snapshot stays unchanged", async () => {
  const { main, linked } = await createLinked({
    ignore: [".vscode/*.local.json", ".vscode/.gitignore", ".vscode/.gitattributes"],
  });
  await mkdir(join(main, ".vscode"));
  await writeFile(join(main, ".vscode", "a.local.json"), "{}\n");
  await writeFile(join(main, ".vscode", ".gitignore"), "!a.local.json\n");
  await writeFile(join(main, ".vscode", ".gitattributes"), "*.json -text\n");
  const before = reviewedState(await snapshot(linked));

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".vscode/a.local.json"]);
  expect(report.skipped).toEqual([".vscode/.gitattributes", ".vscode/.gitignore"]);
  expect(reviewedState(await snapshot(linked))).toEqual(before);
});

// Usefulness: verifies the snapshot identity is the same before and after the copy
// under each ignore source the issue names: the linked branch `.gitignore`, the shared
// `.git/info/exclude`, and `core.excludesFile`.
// Not redundant: the plain digest test uses one source, so a copy that holds up under
// only one source fails only here.
test("the snapshot is unchanged for each ignore source", async () => {
  const { base, main, linked } = await createLinked({ ignore: [".env"] });
  const global = join(base, "global-ignore");
  await writeFile(global, ".envrc\n");
  await git(main, "config", "core.excludesFile", global);
  await writeFile(join(linked, ".gitignore"), ".mcp.json\n");
  await git(linked, "add", ".gitignore");
  await git(linked, "commit", "-m", "ignore");
  for (const name of [".env", ".envrc", ".mcp.json"]) {
    await writeFile(join(main, name), "A=1\n");
  }
  const before = reviewedState(await snapshot(linked));

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".env", ".envrc", ".mcp.json"]);
  expect(reviewedState(await snapshot(linked))).toEqual(before);
});

// Usefulness: verifies a symlink into `.git` is skipped and named, so repository state
// is never read through a link.
// Not redundant: the in-tree link test targets an ordinary file, so a policy that
// follows links into the tree except `.git` would fail only here.
test.skipIf(process.platform === "win32")("skips a symlink that resolves into .git", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await symlink(join(".git", "config"), join(main, ".env"));

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [".env"] });
  expect(await exists(join(linked, ".env"))).toBe(false);
});

// Usefulness: verifies a symlink into a work tree nested in the main work tree is
// skipped and named.
// Not redundant: the other link tests target ordinary files, so a policy that follows
// links inside the main work tree fails only here.
test.skipIf(process.platform === "win32")(
  "skips a symlink that resolves into another work tree",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".env", "nested-wt/"] });
    await git(main, "worktree", "add", join(main, "nested-wt"), "-b", "nested");
    await symlink(join("nested-wt", "init.txt"), join(main, ".env"));

    const report = await copyLocalFiles(linked);

    expect(report).toEqual({ copied: [], skipped: [".env"] });
    expect(await exists(join(linked, ".env"))).toBe(false);
  },
);

// Usefulness: verifies a symlink whose target stays inside the main work tree is
// skipped and named, and nothing is created in its place, because no symlink is
// followed (issue #423: the copy must not follow a symlink out of the main work tree).
// Not redundant: the outside-link test targets a path outside, so a policy that follows
// in-tree links fails only here.
test.skipIf(process.platform === "win32")(
  "skips a symlink that resolves inside the main work tree",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".envrc"] });
    await mkdir(join(main, "notes"));
    await writeFile(join(main, "notes", "envrc.src"), "export A=1\n");
    await symlink(join("notes", "envrc.src"), join(main, ".envrc"));

    const report = await copyLocalFiles(linked);

    expect(report).toEqual({ copied: [], skipped: [".envrc"] });
    expect(await exists(join(linked, ".envrc"))).toBe(false);
  },
);

// Usefulness: verifies a directory symlink is skipped by name and not walked, so no
// file is copied through it, and a link back to an ancestor cannot loop.
// Not redundant: it is the only test of a directory link.
test.skipIf(process.platform === "win32")(
  "skips a directory symlink without walking it",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".codex/", ".agents/"] });
    await mkdir(join(main, "shared"));
    await writeFile(join(main, "shared", "a.toml"), "a=1\n");
    await symlink("shared", join(main, ".codex"));
    await mkdir(join(main, ".agents"));
    await writeFile(join(main, ".agents", "skill.md"), "s\n");
    await symlink(".", join(main, ".agents", "self"));

    const report = await copyLocalFiles(linked);

    expect(report.copied).toEqual([".agents/skill.md"]);
    expect(report.skipped).toEqual([".agents/self", ".codex"]);
    expect(await exists(join(linked, ".codex"))).toBe(false);
  },
);

// Usefulness: verifies a listed path under a symlinked directory of the main work tree
// is skipped by name, because the read would pass through the link.
// Not redundant: every other source test has the link at the leaf, so a check of the
// leaf alone fails only here.
test.skipIf(process.platform === "win32")(
  "skips a listed path under a symlinked directory of the main work tree",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".github/"] });
    const outside = join(base, "outside-gh");
    await mkdir(outside);
    await writeFile(join(outside, "copilot-instructions.md"), `${SECRET}\n`);
    await symlink(outside, join(main, ".github"));

    const report = await copyLocalFiles(linked);

    expect(report).toEqual({ copied: [], skipped: [".github/copilot-instructions.md"] });
    expect(await exists(join(linked, ".github"))).toBe(false);
  },
);

// Usefulness: verifies a case or Windows alias of a Git control file (`.GITIGNORE`,
// `.GitAttributes`, `.gitignore.`, a stream suffix) is skipped like the plain name.
// Not redundant: the control-file test uses the exact lower-case names, so a
// case-sensitive comparison fails only here.
test("skips a case or name alias of a Git control file", async () => {
  const { main, linked } = await createLinked({ ignore: [".vscode/"] });
  await mkdir(join(main, ".vscode"));
  await writeFile(join(main, ".vscode", "tasks.json"), "{}\n");
  const aliases = [".GITIGNORE", ".GitAttributes"];
  if (process.platform !== "win32") {
    aliases.push(".gitignore.", ".gitignore ", ".gitattributes:stream");
  }
  for (const name of aliases) {
    await writeFile(join(main, ".vscode", name), "!tasks.json\n");
  }

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".vscode/tasks.json"]);
  expect(report.skipped).toEqual(aliases.map((name) => `.vscode/${name}`).sort());
});

// Usefulness: verifies a case or trailing-dot alias of `.git` and a case alias of
// `.claude/worktrees` are dropped like the plain names.
// Not redundant: the worktrees test uses the exact path and the nested work tree test
// uses a real `.git` entry, so an exact-name comparison fails only here.
test("drops a case alias of .git and of .claude/worktrees", async () => {
  const { main, linked } = await createLinked({ ignore: [".claude/"] });
  await mkdir(join(main, ".claude", "Worktrees", "wt"), { recursive: true });
  await writeFile(join(main, ".claude", "Worktrees", "wt", "f.txt"), "x\n");
  const gitAliases = [".GIT"];
  if (process.platform !== "win32") {
    gitAliases.push(".git.", ".git ");
  }
  // One parent per alias: a parent that holds an entry equal to `.git` on this
  // file system is dropped whole by the nested-repository rule, which would hide
  // the alias rule under test.
  for (const [index, name] of gitAliases.entries()) {
    await mkdir(join(main, ".claude", `sub${index}`, name), { recursive: true });
    await writeFile(join(main, ".claude", `sub${index}`, name, "config"), "x\n");
  }
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [".claude/settings.json"], skipped: [] });
});

// Usefulness: verifies a source file swapped for a symlink to a secret after the walk
// and before the open is not copied.
// Not redundant: the link policy tests set the link up before the walk, so a copy that
// trusts the walk fails only here.
test.skipIf(process.platform === "win32")(
  "does not copy a source that is swapped for a symlink before it is opened",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".env"] });
    const secret = join(base, "secret.txt");
    await writeFile(secret, `${SECRET}\n`);
    await writeFile(join(main, ".env"), "A=1\n");

    const report = await copyLocalFiles(linked, {
      beforeSourceOpen: async () => {
        await rm(join(main, ".env"));
        await symlink(secret, join(main, ".env"));
      },
    });

    expect(report).toEqual({ copied: [], skipped: [".env"] });
    expect(await exists(join(linked, ".env"))).toBe(false);
  },
);

// Usefulness: verifies a source whose directory is swapped for a symlink after the walk
// is not copied, which the no-follow flag on the last path component does not stop.
// Not redundant: the file-swap test is stopped by that flag, so a copy that does not
// check the opened file against its resolved path fails only here.
test.skipIf(process.platform === "win32")(
  "does not copy a source whose directory is swapped for a symlink before it is opened",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".codex/"] });
    const outside = join(base, "outside-codex");
    await mkdir(outside);
    await writeFile(join(outside, "config.toml"), `${SECRET}\n`);
    await mkdir(join(main, ".codex"));
    await writeFile(join(main, ".codex", "config.toml"), "a=1\n");

    const report = await copyLocalFiles(linked, {
      beforeSourceOpen: async () => {
        await rename(join(main, ".codex"), join(base, "moved-codex"));
        await symlink(outside, join(main, ".codex"));
      },
    });

    expect(report).toEqual({ copied: [], skipped: [".codex/config.toml"] });
    expect(await exists(join(linked, ".codex"))).toBe(false);
  },
);

// Usefulness: verifies a target directory that becomes a symlink after the existence
// check and before the directories are created is refused.
// Not redundant: the swap tests fire after the directories exist, so an existing
// directory that is not checked to be a real one fails only here, once the later target
// check is also removed.
test.skipIf(process.platform === "win32")(
  "refuses a target directory that becomes a symlink before the directories are created",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
    const outside = join(base, "outside-claude-early");
    await mkdir(outside);
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "settings.json"), `${SECRET}\n`);

    const report = await copyLocalFiles(linked, {
      beforeSourceOpen: async () => {
        await symlink(outside, join(linked, ".claude"));
      },
    });

    expect(report).toEqual({ copied: [], skipped: [".claude/settings.json"] });
    expect(await exists(join(outside, "settings.json"))).toBe(false);
  },
);

// Usefulness: verifies a target under a symlinked directory of the linked work tree is
// skipped, so nothing is written outside it.
// Not redundant: every other target test has real directories, so a copy that writes
// through a link that already exists fails only here.
test.skipIf(process.platform === "win32")(
  "does not write through a symlinked directory of the linked work tree",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(linked, ".claude"));
    await git(linked, "add", ".claude");
    await git(linked, "commit", "-m", "link");
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "settings.json"), "{}\n");

    const report = await copyLocalFiles(linked);

    expect(report).toEqual({ copied: [], skipped: [".claude/settings.json"] });
    expect(await exists(join(outside, "settings.json"))).toBe(false);
  },
);

// Usefulness: verifies a listed directory that holds more than 2000 entries, counted
// with nested ones, is skipped as one name with none of its files copied, and it does
// not use up the bound of the next listed path.
// Not redundant: it is the only test over the bound, so a shared bound, a kept partial
// result, or a missing limit fails only here.
test("skips a listed directory past the entry bound as one name, per directory", async () => {
  const { main, linked } = await createLinked({ ignore: [".codex/", ".vscode/"] });
  await mkdir(join(main, ".codex", "sub"), { recursive: true });
  await writeFile(join(main, ".codex", "first.toml"), "a=1\n");
  await Promise.all(
    Array.from({ length: MAX_WALKED_ENTRIES }, (_, i) =>
      writeFile(join(main, ".codex", "sub", `f${i}`), ""),
    ),
  );
  await mkdir(join(main, ".vscode"));
  await writeFile(join(main, ".vscode", "tasks.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".vscode/tasks.json"]);
  expect(report.skipped).toEqual([".codex"]);
  expect(await exists(join(linked, ".codex"))).toBe(false);
});

// Usefulness: verifies a listed directory with exactly 2000 entries is still copied, so
// the bound means more than 2000.
// Not redundant: it fails when the limit is off by one, which the over-bound test
// cannot detect.
test("copies a listed directory that holds exactly the entry bound", async () => {
  const { main, linked } = await createLinked({ ignore: [".codex/"] });
  await mkdir(join(main, ".codex"));
  await Promise.all(
    Array.from({ length: MAX_WALKED_ENTRIES }, (_, i) =>
      writeFile(join(main, ".codex", `f${i}`), ""),
    ),
  );

  const report = await copyLocalFiles(linked);

  expect(report.copied.length).toBe(MAX_WALKED_ENTRIES);
  expect(report.skipped).toEqual([]);
});

const TEMP_SUFFIX = ".agent-loop-copy";

// Names that the copy leaves in `dir` besides the files a test put there.
const tempNames = async (dir) => (await readdir(dir)).filter((name) => name.endsWith(TEMP_SUFFIX));

// Usefulness: verifies a work tree that Git still lists but whose `.git` entry is gone
// is never read from.
// Not redundant: the nested work tree test keeps the `.git` file, so a walk that does
// not consult the registered work tree list fails only here.
test("never copies from a registered work tree whose .git entry is absent", async () => {
  const { main, linked } = await createLinked({ ignore: [".agents/"] });
  await mkdir(join(main, ".agents"));
  await git(main, "worktree", "add", join(main, ".agents", "wt"), "-b", "nested");
  await rm(join(main, ".agents", "wt", ".git"));
  await writeFile(join(main, ".agents", "wt", "inner.md"), "x\n");
  await writeFile(join(main, ".agents", "skill.md"), "s\n");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [".agents/skill.md"], skipped: [] });
  expect(await exists(join(linked, ".agents", "wt"))).toBe(false);
});

// Usefulness: verifies a nested repository that is not a registered work tree is
// never read from, because its directory holds a `.git` entry.
// Not redundant: the nested work tree test is also a registered work tree, so a walk
// that ignores the `.git` entry fails only here.
test("never copies from a nested repository", async () => {
  const { main, linked } = await createLinked({ ignore: [".agents/"] });
  await mkdir(join(main, ".agents", "repo"), { recursive: true });
  await git(join(main, ".agents", "repo"), "init");
  await writeFile(join(main, ".agents", "repo", "inner.md"), "x\n");
  await writeFile(join(main, ".agents", "skill.md"), "s\n");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [".agents/skill.md"], skipped: [] });
});

// Usefulness: verifies no file is written inside a work tree that Git lists under the
// linked work tree, even when its `.git` entry is gone.
// Not redundant: the `.git` file test has a `.git` entry and no registration, so a
// destination check that skips the registered work tree list fails only here.
test("never writes inside a registered work tree nested in the linked work tree", async () => {
  const { main, linked } = await createLinked({ ignore: [".agents/"] });
  await mkdir(join(main, ".agents", "sub"), { recursive: true });
  await writeFile(join(main, ".agents", "sub", "f.md"), "x\n");
  await mkdir(join(linked, ".agents"));
  await git(linked, "worktree", "add", join(linked, ".agents", "sub"), "-b", "inner");
  await rm(join(linked, ".agents", "sub", ".git"));

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [".agents/sub/f.md"] });
  expect(await exists(join(linked, ".agents", "sub", "f.md"))).toBe(false);
});

// Usefulness: verifies no file is written into a directory of the linked work tree that
// holds a `.git` entry, a file here, even when no work tree is registered there.
// Not redundant: the registered work tree test has a registered path, so a destination
// check that skips the `.git` entry fails only here.
test("never writes into a directory of the linked work tree that holds a .git file", async () => {
  const { main, linked } = await createLinked({ ignore: [".vscode/"] });
  await mkdir(join(main, ".vscode"));
  await writeFile(join(main, ".vscode", "tasks.json"), "{}\n");
  await mkdir(join(linked, ".vscode"));
  await writeFile(join(linked, ".vscode", ".git"), "gitdir: /nowhere\n");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [".vscode/tasks.json"] });
  expect(await exists(join(linked, ".vscode", "tasks.json"))).toBe(false);
});

// Usefulness: verifies a copy that fails after its temporary file is written leaves no
// target and no temporary file, and the file is reported as skipped, so a partial copy
// is never reported as copied.
// Not redundant: no other test makes the final step fail, so a success reported before
// the target is in place fails only here.
test("a copy that fails before the target exists is skipped and leaves nothing", async () => {
  const { main, linked } = await createLinked({ ignore: [".claude/"] });
  await mkdir(join(main, ".claude"));
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");

  const report = await copyLocalFiles(linked, {
    beforeLink: async () => {
      for (const name of await tempNames(join(linked, ".claude"))) {
        await rm(join(linked, ".claude", name));
      }
    },
  });

  expect(report).toEqual({ copied: [], skipped: [".claude/settings.json"] });
  expect(await readdir(join(linked, ".claude"))).toEqual([]);
});

// Usefulness: verifies a file of the maximum size arrives complete, byte for byte, so a
// short write is not reported as a copy.
// Not redundant: the other content checks use tiny files, so a write that stops short
// of the file size fails only here.
test("copies a file of the maximum size completely", async () => {
  const { main, linked } = await createLinked({ ignore: [".codex/"] });
  await mkdir(join(main, ".codex"));
  const data = Buffer.alloc(1024 * 1024, "abcdefgh");
  await writeFile(join(main, ".codex", "big.toml"), data);

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".codex/big.toml"]);
  expect(Buffer.compare(await readFile(join(linked, ".codex", "big.toml")), data)).toBe(0);
});

// Usefulness: verifies a file that another process puts at the target while the copy
// runs is neither replaced nor deleted by the copy or its cleanup, and no temporary
// file stays.
// Not redundant: the existing-file test sets the file up before the copy starts, so a
// final step or a cleanup that touches a later file fails only here.
test("a file put at the target during the copy is left untouched", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "from-main\n");

  const report = await copyLocalFiles(linked, {
    beforeLink: async () => {
      await writeFile(join(linked, ".env"), "already-here\n");
    },
  });

  expect(report).toEqual({ copied: [], skipped: [".env"] });
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("already-here\n");
  expect(await tempNames(linked)).toEqual([]);
});

// Usefulness: verifies a target directory swapped for a symlink before the temporary
// file is created fails the init with a message that names the file, and leaves no file
// outside.
// Not redundant: the early-swap test is caught before any file exists, so the check
// that follows the creation of the temporary file fails only here.
test.skipIf(process.platform === "win32")(
  "fails closed when the target directory is swapped for a symlink after the directories exist",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
    const outside = join(base, "outside-claude");
    await mkdir(outside);
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "settings.json"), `${SECRET}\n`);

    await expect(
      copyLocalFiles(linked, {
        beforeTargetCreate: async () => {
          await rm(join(linked, ".claude"), { recursive: true });
          await symlink(outside, join(linked, ".claude"));
        },
      }),
    ).rejects.toThrow("changed during the copy of .claude/settings.json");

    expect(await readdir(outside)).toEqual([]);
  },
);

// Usefulness: verifies a target directory swapped for a symlink after the temporary
// file is written places nothing outside, and the file is skipped.
// Not redundant: it is the only test that swaps between the write and the link, which
// is the one path-based step.
test.skipIf(process.platform === "win32")(
  "places nothing outside when the target directory is swapped before the link step",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
    const outside = join(base, "outside-claude-late");
    await mkdir(outside);
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "settings.json"), `${SECRET}\n`);

    const report = await copyLocalFiles(linked, {
      beforeLink: async () => {
        await rename(join(linked, ".claude"), join(base, "moved-claude"));
        await symlink(outside, join(linked, ".claude"));
      },
    });

    expect(report).toEqual({ copied: [], skipped: [".claude/settings.json"] });
    expect(await readdir(outside)).toEqual([]);
  },
);

// Usefulness: verifies a link that lands outside the expected path, because the
// target directory was swapped for a symlink to the directory that holds the
// temporary file, is detected after the link and fails the init closed.
// Not redundant: the other late swap makes the link fail, so a missing check of
// the finished target fails only here.
test.skipIf(process.platform === "win32")(
  "fails closed when a swap redirects the link to another directory",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "settings.json"), `${SECRET}\n`);

    await expect(
      copyLocalFiles(linked, {
        beforeLink: async () => {
          await rename(join(linked, ".claude"), join(base, "moved-claude"));
          await symlink(join(base, "moved-claude"), join(linked, ".claude"));
        },
      }),
    ).rejects.toThrow("changed during the copy of .claude/settings.json");
  },
);
