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
import { afterEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { copyLocalFiles, MAX_WALKED_ENTRIES } from "../../src/lib/local-files.mjs";
import { reviewedState, snapshot } from "../../src/lib/snapshot.mjs";
import { createLinkedWorkTree, removePath } from "../runtime-helpers.mjs";

const SECRET = "TOKEN-VALUE-MUST-NOT-APPEAR";
const created = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
// Not redundant: it is the broad positive case: a root file, a directory, and a nested
// directory, with the content read back.
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
// Not redundant: it is the test with an untracked file that no ignore rule covers and
// that must be skipped and named. The other copy tests give their files an ignore rule.
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
// `.gitignore` committed on the linked branch makes a file copyable.
// Not redundant: it uses a rule that only the linked branch has. The ignore-source test
// mixes three sources in one run.
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
// Not redundant: it puts a tracked file and an untracked file in one directory and
// edits the tracked file in the linked work tree.
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
// Not redundant: the file exists before the copy starts. The test for a destination
// that appears during the copy covers a file that arrives after that check.
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
// Not redundant: it tracks a whole file in the main work tree with no untracked file
// beside it, which the partly tracked test does not.
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
// Not redundant: it uses the exact lower-case path. The alias test uses other spellings
// of it.
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
// Not redundant: the nested work tree here is registered and has its `.git` file. The
// next tests remove the `.git` entry, or use a repository that is not registered.
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
// skipped and named, so the data behind it stays outside.
// Not redundant: its link targets lie outside the main work tree. The other link tests
// keep the target inside it.
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
// Not redundant: it has a file one byte over the cap beside a small one. The maximum
// size test covers a file exactly at the cap.
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
// Not redundant: it passes the main work tree itself to the copy, which the linked-tree
// tests never do.
test("returns null and changes nothing when cwd is the main work tree", async () => {
  const { main } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "A=1\n");

  expect(await copyLocalFiles(main)).toBeNull();
});

// A repository `seed` with one commit, under `base`.
async function createSeed(base) {
  const seed = join(base, "seed");
  await mkdir(seed);
  await git(seed, "init");
  await git(seed, "config", "user.name", "Tester");
  await git(seed, "config", "user.email", "test@example.com");
  await writeFile(join(seed, "a.txt"), "a\n");
  await git(seed, "add", "a.txt");
  await git(seed, "commit", "-m", "a");
  return seed;
}

// Usefulness: verifies a bare repository has no main work tree: nothing is copied and
// the run says so, because Git marks its first worktree entry `bare`.
// Not redundant: it is the plain bare layout. The next test gives the bare repository
// the name `.git`.
test("copies nothing and reports it for a bare repository", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-files-bare-"));
  created.push(base);
  const bare = join(base, "bare.git");
  await execa("git", ["clone", "--bare", await createSeed(base), bare]);
  const linked = join(base, "linked");
  await git(bare, "worktree", "add", linked, "-b", "run");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  expect(await copyLocalFiles(linked)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
});

// Usefulness: verifies a bare repository named `.git` copies nothing, though the parent
// of a Git directory named `.git` looks like a main checkout.
// Not redundant: it is the only bare repository whose name would make a lookup by
// directory name find a checkout, and the `bare` marker in the entry refuses it.
test("copies nothing and reports it for a bare repository named .git", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-files-bare-dotgit-"));
  created.push(base);
  const project = join(base, "project");
  await mkdir(project);
  await mkdir(join(project, ".codex"));
  await writeFile(join(project, ".codex", "config.toml"), "a=1\n");
  const bare = join(project, ".git");
  await execa("git", ["clone", "--bare", await createSeed(base), bare]);
  const linked = join(base, "linked");
  await git(bare, "worktree", "add", linked, "-b", "run");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  expect(await copyLocalFiles(linked)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
  expect(await exists(join(linked, ".codex"))).toBe(false);
});

// Usefulness: verifies a submodule has no main work tree for this copy: Git lists the
// submodule's Git directory, inside the superproject's `.git`, first.
// Not redundant: it is the only test with a Git directory that lies inside another
// repository's `.git`.
test("copies nothing and reports it for a submodule", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-files-submodule-"));
  created.push(base);
  const library = join(base, "library");
  await mkdir(library);
  await git(library, "init");
  await git(
    library,
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "l",
  );
  const superproject = join(base, "super");
  await mkdir(superproject);
  await git(superproject, "init");
  await git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", library, "lib");
  const submodule = join(superproject, "lib");
  await git(submodule, "config", "user.name", "Tester");
  await git(submodule, "config", "user.email", "test@example.com");
  const linked = join(base, "linked");
  await git(submodule, "worktree", "add", linked, "-b", "run");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  expect(await copyLocalFiles(linked)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
});

// Usefulness: verifies an ordinary clone still has a main work tree: files are copied
// from the checkout that Git lists first.
// Not redundant: every other positive test builds its repository with `git init`. This
// one clones, as a user's main work tree usually comes from.
test("copies from the main work tree of a clone", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-files-clone-"));
  created.push(base);
  const clone = join(base, "clone");
  await execa("git", ["clone", await createSeed(base), clone]);
  await writeFile(join(clone, ".git", "info", "exclude"), ".env\n");
  await writeFile(join(clone, ".env"), "A=1\n");
  const linked = join(base, "linked");
  await git(clone, "worktree", "add", linked, "-b", "run");

  expect(await copyLocalFiles(linked)).toEqual({ copied: [".env"], skipped: [] });
});

// Usefulness: verifies copied files leave the `clean` flag and the snapshot digest
// unchanged, because a copied path is ignored.
// Not redundant: it copies two files with ordinary content. The control-file and
// ignore-source tests set up rule files and rule sources.
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
// Not redundant: it asserts that the serialized report lacks a content string. The
// other tests assert the lists.
test("the report carries path names only, never content", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), `KEY=${SECRET}\n`);

  const report = await copyLocalFiles(linked);

  expect(JSON.stringify(report)).not.toContain(SECRET);
});

// Usefulness: verifies a `.gitignore` or `.gitattributes` held by a listed directory is
// skipped, because a copied one could un-ignore a copied sibling and change the
// snapshot.
// Not redundant: its sibling is un-ignored by the rule file, so the snapshot would show
// it if the rule file were copied.
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
// Not redundant: it runs the three sources in one run. The other snapshot tests use one
// source.
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
// Not redundant: its link target is `.git/config`. The other link tests use other
// targets.
test.skipIf(process.platform === "win32")("skips a symlink that resolves into .git", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await symlink(join(".git", "config"), join(main, ".env"));

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [".env"] });
  expect(await exists(join(linked, ".env"))).toBe(false);
});

// Usefulness: verifies a symlink into a work tree nested in the main work tree is
// skipped and named.
// Not redundant: its link target is a file in a nested work tree. The other link tests
// use other targets.
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
// Not redundant: its link target is an ordinary file in the main work tree. The
// outside-link test targets a path outside it.
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
// Not redundant: it is the test with a directory link and a self link.
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
// Not redundant: its link is an ancestor of the listed path, which the walk-time
// ancestor check refuses. The copy-time checks compare against the path the walk
// recorded, so they do not catch a link that was already there.
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
// Not redundant: it uses alias spellings. The control-file test uses the exact
// lower-case names.
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
// Not redundant: it uses alias spellings. The worktrees test uses the exact path, and
// the nested work tree test uses a real `.git` entry.
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
// Not redundant: it swaps the file itself. The no-follow open, the canonical path
// check, and the check that the path names a regular file each refuse it, so removing
// the first two together does not fail this test.
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
// is not copied.
// Not redundant: it swaps a directory, which the no-follow flag on the last path
// component does not stop, so it fails when the canonical path comparison is removed.
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
// Not redundant: the swap happens before the directories are created. It fails when the
// check that each target directory is a real directory is removed.
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
// Not redundant: the link exists before the copy starts. It fails when the target
// directory check is removed, as the early-swap test also does.
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
// Not redundant: it is the test with a directory over the bound, followed by a second
// listed path that must still copy.
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
// Not redundant: it is the test at the boundary, so a limit that is off by one fails
// it.
// The copy checks and copies each of the 2000 files in turn, with about 15 file system
// calls per file. That takes about 5 s on an idle Windows host and over 15 s while the
// full suite runs, so this test has its own timeout. The fixture cannot shrink: the
// bound is the file count.
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
}, 60_000);

// Usefulness: verifies a work tree that Git still lists but whose `.git` entry is gone
// is never read from.
// Not redundant: the nested work tree test keeps its `.git` file, so only this one has
// no `.git` entry to find.
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

// Usefulness: verifies a nested repository that Git does not list as a work tree is
// never read from, because its directory holds a `.git` entry.
// Not redundant: the nested work tree test uses a registered work tree, so it is also
// refused by the registered work tree list.
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
// Not redundant: the `.git` file test has a `.git` entry and no registration, so this
// test has the registration alone.
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
// Not redundant: it has a `.git` entry and no registration. The registered work tree
// test has the registration without the entry.
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

// Usefulness: verifies a file of exactly the maximum size, 1 MiB, is copied byte for
// byte, so the cap includes its limit.
// Not redundant: the size cap test uses a file one byte over the cap, so a limit that
// is off by one fails this test.
test("copies a file of the maximum size completely", async () => {
  const { main, linked } = await createLinked({ ignore: [".codex/"] });
  await mkdir(join(main, ".codex"));
  const data = Buffer.alloc(1024 * 1024, "abcdefgh");
  await writeFile(join(main, ".codex", "big.toml"), data);

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".codex/big.toml"]);
  expect(Buffer.compare(await readFile(join(linked, ".codex", "big.toml")), data)).toBe(0);
});

// Usefulness: verifies a destination that appears after the checks and before the copy
// survives byte for byte: the exclusive create fails, nothing is deleted, and the file
// is reported as skipped.
// Not redundant: the existing-file test creates the file before the checks run, so the
// copy never reaches the exclusive create there. Here it does.
test("a destination that appears during the copy survives byte for byte", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "from-main\n");
  const present = Buffer.from([0, 1, 2, 250, 251, 252]);

  const report = await copyLocalFiles(linked, {
    beforeCopy: async () => {
      await writeFile(join(linked, ".env"), present);
    },
  });

  expect(report).toEqual({ copied: [], skipped: [".env"] });
  expect(Buffer.compare(await readFile(join(linked, ".env")), present)).toBe(0);
});

// Usefulness: verifies a copy that fails leaves the clean flag and the snapshot digest
// unchanged, and leaves the directory holding only the file that was already there.
// Not redundant: the digest test copies successfully. This one fails the exclusive
// create after the target directory was made.
test("a failed copy leaves the snapshot unchanged", async () => {
  const { main, linked } = await createLinked({ ignore: [".claude/"] });
  await mkdir(join(main, ".claude"));
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");
  const before = reviewedState(await snapshot(linked));

  const report = await copyLocalFiles(linked, {
    beforeCopy: async () => {
      await writeFile(join(linked, ".claude", "settings.json"), "present\n");
    },
  });

  expect(report).toEqual({ copied: [], skipped: [".claude/settings.json"] });
  expect(reviewedState(await snapshot(linked))).toEqual(before);
  expect(before.clean).toBe(true);
  expect(await readdir(join(linked, ".claude"))).toEqual(["settings.json"]);
});

// Whether `base` is on a file system that reads names without regard to case, decided
// by a directory that is looked up under a name that differs only in case.
const caseInsensitive = async (base) => {
  await mkdir(join(base, "casecheck"));
  return exists(join(base, "CASECHECK"));
};

// A main work tree whose `.git` is a file that points at a separate Git directory,
// plus a linked work tree. Git lists the Git directory, not the checkout, first.
async function createLinkedWithGitFile() {
  const base = await mkdtemp(join(tmpdir(), "local-files-gitfile-"));
  created.push(base);
  const main = join(base, "main");
  const linked = join(base, "linked");
  await mkdir(main);
  await execa("git", ["init", "--separate-git-dir", join(base, "gitdir"), main]);
  await git(main, "config", "user.name", "Tester");
  await git(main, "config", "user.email", "test@example.com");
  await writeFile(join(main, "init.txt"), "hello\n");
  await git(main, "add", "init.txt");
  await git(main, "commit", "-m", "init");
  await writeFile(join(base, "gitdir", "info", "exclude"), ".codex/\n");
  await git(main, "worktree", "add", linked, "-b", "run");
  return { base, main, linked };
}

// Swaps `main/.codex` for a link to `lookalike/.codex`, which holds SECRET, just
// before the copy opens its source. Returns the copy report.
async function copyWithSwappedDirectory({ base, main, linked, lookalike }) {
  await mkdir(join(lookalike, ".codex"), { recursive: true });
  await writeFile(join(lookalike, ".codex", "config.toml"), `${SECRET}\n`);
  await mkdir(join(main, ".codex"));
  await writeFile(join(main, ".codex", "config.toml"), "a=1\n");
  return copyLocalFiles(linked, {
    beforeSourceOpen: async () => {
      await rename(join(main, ".codex"), join(base, "moved-codex"));
      await symlink(join(lookalike, ".codex"), join(main, ".codex"));
    },
  });
}

// Usefulness: verifies a directory swapped, after the walk, for a link to a directory
// whose path differs from the main work tree path only in case is not read on a
// case-sensitive file system, where that directory is outside the main work tree.
// Not redundant: the other swap tests link to a directory whose path differs by more
// than case. It needs two directories that differ only in case, so it is skipped on a
// case-insensitive file system, where they are one directory.
test.skipIf(process.platform === "win32")(
  "does not read through a swapped directory that differs from the main path only in case",
  async ({ skip }) => {
    const { base, main, linked } = await createLinked({ ignore: [".codex/"] });
    if (await caseInsensitive(base)) {
      skip();
    }

    const report = await copyWithSwappedDirectory({
      base,
      main,
      linked,
      lookalike: join(base, "MAIN"),
    });

    expect(report).toEqual({ copied: [], skipped: [".codex/config.toml"] });
    expect(await exists(join(linked, ".codex"))).toBe(false);
  },
);

// Usefulness: verifies a plain separate Git directory, made by `git init
// --separate-git-dir`, has no main work tree for this copy: Git lists the Git directory
// first, so nothing is copied and the run says so.
// Not redundant: it is the only test whose main checkout has a `.git` file that points at
// a separate Git directory.
test("copies nothing and reports it when Git records no main checkout", async () => {
  const { main, linked } = await createLinkedWithGitFile();
  await mkdir(join(main, ".codex"));
  await writeFile(join(main, ".codex", "config.toml"), "a=1\n");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  expect(await copyLocalFiles(linked)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
  expect(await exists(join(linked, ".codex"))).toBe(false);
});

// Usefulness: verifies two work trees whose paths differ only in case are two work
// trees on a case-sensitive file system, so the copy runs from one into the other.
// Not redundant: it is the test whose two work trees have paths that differ only in
// case. It is skipped on a case-insensitive file system, where they are one directory.
test("copies between work trees whose paths differ only in case", async ({ skip }) => {
  const probe = await mkdtemp(join(tmpdir(), "local-files-case-"));
  created.push(probe);
  if (await caseInsensitive(probe)) {
    skip();
  }
  const { main, linked } = await createLinked({
    ignore: [".env"],
    mainName: "repo",
    linkedName: "REPO",
  });
  await writeFile(join(main, ".env"), "A=1\n");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [".env"], skipped: [] });
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("A=1\n");
});

// Usefulness: verifies a listed directory whose on-disk name differs in case from the
// listed name is still copied on a case-insensitive file system, so the exact path
// comparison does not skip a file that is eligible.
// Not redundant: it is the test with an untracked file in a directory whose on-disk
// name differs in case from the listed name. The tracked alias test covers a tracked
// file. It is skipped on a case-sensitive file system, where `.Claude` is not `.claude`.
test("copies a listed directory whose on-disk name differs in case", async ({ skip }) => {
  const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
  if (!(await caseInsensitive(base))) {
    skip();
  }
  await mkdir(join(main, ".Claude"));
  await writeFile(join(main, ".Claude", "settings.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [".claude/settings.json"], skipped: [] });
});

// Usefulness: verifies a file that the main work tree tracks is never copied through
// another spelling of its path. On a case-insensitive file system `.claude/config` and
// the tracked `.Claude/config` are one file, and Git tracks it under one spelling.
// Not redundant: the tracked-path test uses the same spelling for the listed name and
// the tracked name. It is skipped on a case-sensitive file system, where they differ.
test("does not copy a tracked file through a different spelling of its path", async ({ skip }) => {
  const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
  if (!(await caseInsensitive(base))) {
    skip();
  }
  await mkdir(join(main, ".Claude"));
  await writeFile(join(main, ".Claude", "config"), "tracked\n");
  await git(main, "add", "-f", ".Claude/config");
  await git(main, "commit", "-m", "track");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [] });
  expect(await exists(join(linked, ".claude"))).toBe(false);
});

// Usefulness: verifies a `--cwd` that ends in a control character is refused, not
// redirected: the copy writes nothing, reports it, and does not write into the
// directory with the same name without that character, which is a real work tree here.
// Not redundant: each spelling is a different character that Git or the process
// runner can drop from the end of a printed path.
for (const [label, character] of [
  ["a line feed", "\n"],
  ["a carriage return", "\r"],
  ["a tab", "\t"],
]) {
  test.skipIf(process.platform === "win32")(
    `copies nothing and reports it for a --cwd ending in ${label} (not run on Windows, which cannot hold it)`,
    async () => {
      const { base, main, linked } = await createLinked({
        ignore: [".env"],
        linkedName: `linked${character}`,
      });
      await git(main, "worktree", "add", join(base, "linked"), "-b", "decoy");
      await writeFile(join(main, ".env"), "A=1\n");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      expect(await copyLocalFiles(linked)).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("control character"));
      expect(await exists(join(base, "linked", ".env"))).toBe(false);
      expect(await exists(join(linked, ".env"))).toBe(false);
    },
  );
}

// Usefulness: verifies a `--cwd` that is itself clean, a symlink to a work tree whose
// real path ends in a line feed, is refused: Git prints the real path with its final
// line feed, which must survive, or the copy would run in the directory without it.
// Not redundant: every other `--cwd` test puts the control character in `--cwd`
// itself, which is refused before Git runs. Here only Git's own output has it. It is not
// run on Windows, which cannot hold the character.
test.skipIf(process.platform === "win32")(
  "copies nothing and reports it for a --cwd symlink to a work tree ending in a line feed (not run on Windows, which cannot hold it)",
  async () => {
    const { base, main, linked } = await createLinked({
      ignore: [".env"],
      linkedName: "linked\n",
    });
    await git(main, "worktree", "add", join(base, "linked"), "-b", "decoy");
    await writeFile(join(main, ".env"), "A=1\n");
    const alias = join(base, "alias");
    await symlink(linked, alias);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await copyLocalFiles(alias)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("control character"));
    expect(await exists(join(base, "linked", ".env"))).toBe(false);
  },
);

// Usefulness: verifies a main work tree whose path holds a newline is refused, not
// replaced by the directory named by the text before the newline, which here is
// another repository's checkout.
// Not redundant: it puts the control character in the main work tree path, and the
// tests above put it in `--cwd`. It is not run on Windows, where a path cannot hold one.
test.skipIf(process.platform === "win32")(
  "copies nothing and reports it when the main work tree path holds a newline",
  async () => {
    const { base, main, linked } = await createLinked({
      ignore: [".env"],
      mainName: "repo\nmain",
    });
    await writeFile(join(main, ".env"), "REAL\n");
    await mkdir(join(base, "repo"));
    await writeFile(join(base, "repo", ".env"), "DECOY\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await copyLocalFiles(linked)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("control character"));
    expect(await exists(join(linked, ".env"))).toBe(false);
  },
);

// Usefulness: verifies a registered work tree whose path holds a newline is refused,
// whether or not its `.git` entry is still there, so no exclusion depends on parsing
// such a path.
// Not redundant: it puts the control character in a work tree that is neither the main
// work tree nor `--cwd`. It is not run on Windows, where a path cannot hold one.
test.skipIf(process.platform === "win32")(
  "copies nothing and reports it when a registered work tree path holds a newline",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".agents/"] });
    await mkdir(join(main, ".agents"));
    const nested = join(main, ".agents", "wt\nx");
    await git(main, "worktree", "add", nested, "-b", "nested");
    await rm(join(nested, ".git"));
    await writeFile(join(nested, "inner.md"), "x\n");
    await writeFile(join(main, ".agents", "skill.md"), "s\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await copyLocalFiles(linked)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("control character"));
    expect(await exists(join(linked, ".agents"))).toBe(false);
  },
);

// Usefulness: verifies a linked work tree whose directory name ends in a space is used
// as it is: the top level that Git prints is not trimmed.
// Not redundant: every other test has a work tree name without surrounding space. It is
// skipped on Windows, where a trailing space is dropped from a name.
test.skipIf(process.platform === "win32")(
  "copies into a linked work tree whose name ends in a space",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".env"], linkedName: "linked " });
    await writeFile(join(main, ".env"), "A=1\n");

    const report = await copyLocalFiles(linked);

    expect(report).toEqual({ copied: [".env"], skipped: [] });
  },
);

// Usefulness: verifies a file whose name holds a newline is listed, checked against
// the ignore rules, and copied as one path, and that a tracked file with such a name
// is not copied.
// Not redundant: no other test has a newline in a file name, which the NUL separated
// output of `git ls-files -z` and `git check-ignore -z` keeps whole.
test.skipIf(process.platform === "win32")(
  "copies a file whose name holds a newline and skips a tracked one",
  async () => {
    const { main, linked } = await createLinked({ ignore: [".claude/"] });
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "a\nb.json"), "{}\n");
    await writeFile(join(main, ".claude", "t\nu.json"), "{}\n");
    await git(main, "add", "-f", ".claude/t\nu.json");
    await git(main, "commit", "-m", "track");

    const report = await copyLocalFiles(linked);

    expect(report).toEqual({ copied: [".claude/a\nb.json"], skipped: [] });
  },
);
