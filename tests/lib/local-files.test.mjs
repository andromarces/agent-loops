import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

// Usefulness: verifies the core contract — an untracked, ignored file and a
// directory of such files reach the linked work tree, and the content is the
// source content. No other test proves the bytes arrive.
// Not redundant: the only test that reads the copied bytes and the nested directory path, so a copy that creates empty or wrong files fails here alone.
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

// Usefulness: verifies an untracked path that no ignore source covers in the
// linked work tree is skipped and named, never copied (acceptance 2).
// Not redundant: the only test of the skipped-and-named rule, so a copy that ignores condition 3 fails here alone.
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
// .gitignore on the linked branch alone is enough, which the main tree lacks.
// Not redundant: the other tests use the shared exclude file, so only this one fails when the check reads the main work tree instead of `--cwd`.
test("honors a .gitignore of the branch checked out in the linked work tree", async () => {
  const { main, linked } = await createLinked();
  await writeFile(join(linked, ".gitignore"), ".mcp.json\n");
  await git(linked, "add", ".gitignore");
  await git(linked, "commit", "-m", "ignore");
  await writeFile(join(main, ".mcp.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".mcp.json"]);
});

// Usefulness: verifies a partly tracked directory copies only its untracked,
// ignored files and never touches a tracked sibling (acceptance 5).
// Not redundant: the only test with a tracked sibling in the same directory, so a copy that treats a directory as one unit fails here alone.
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

// Usefulness: verifies a file that already exists in the linked work tree is
// never overwritten (acceptance 5) and is reported as skipped.
// Not redundant: the only test with a file already in `--cwd`, so a copy that overwrites fails here alone.
test("never overwrites an existing file in the linked work tree", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "from-main\n");
  await writeFile(join(linked, ".env"), "already-here\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([]);
  expect(report.skipped).toEqual([".env"]);
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("already-here\n");
});

// Usefulness: verifies a path tracked in the main work tree is not a local file
// and is neither copied nor reported.
// Not redundant: the only test with a tracked path in the main work tree, so a copy that skips condition 2 fails here alone.
test("ignores a tracked path in the main work tree", async () => {
  const { main, linked } = await createLinked();
  await writeFile(join(main, "GEMINI.md"), "tracked\n");
  await git(main, "add", "GEMINI.md");
  await git(main, "commit", "-m", "gemini");

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [] });
});

// Usefulness: verifies Claude Code's own work tree directory is never copied,
// even though it is an ignored, untracked path.
// Not redundant: the only test with a path under `.claude/worktrees`, so removing that exclusion fails here alone.
test("never copies anything under .claude/worktrees", async () => {
  const { main, linked } = await createLinked({ ignore: [".claude/"] });
  await mkdir(join(main, ".claude", "worktrees", "wt"), { recursive: true });
  await writeFile(join(main, ".claude", "worktrees", "wt", "file.txt"), "x\n");
  await writeFile(join(main, ".claude", "settings.json"), "{}\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".claude/settings.json"]);
  expect(await exists(join(linked, ".claude", "worktrees"))).toBe(false);
});

// Usefulness: verifies a directory that holds another work tree is excluded
// wherever it sits, not only at the Claude Code location.
// Not redundant: the Claude Code test names one fixed path, so only this test fails when the `git worktree list` exclusion is removed.
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

// Usefulness: verifies a symlink is never followed out of the main work tree
// and is never recreated, so a link to a secret outside the tree stays outside.
// Not redundant: the in-tree link tests prove the permitted case, so only this test fails when a link out of the tree is followed.
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

// Usefulness: verifies a file over the size cap is skipped and named, so a
// large cache under .codex/ or .claude/ is not duplicated into every run.
// Not redundant: the only test with a file over the cap, so removing the cap fails here alone.
test("skips a file over the size cap", async () => {
  const { main, linked } = await createLinked({ ignore: [".codex/"] });
  await mkdir(join(main, ".codex"));
  await writeFile(join(main, ".codex", "big.bin"), Buffer.alloc(1024 * 1024 + 1));
  await writeFile(join(main, ".codex", "config.toml"), "a=1\n");

  const report = await copyLocalFiles(linked);

  expect(report.copied).toEqual([".codex/config.toml"]);
  expect(report.skipped).toEqual([".codex/big.bin"]);
});

// Usefulness: verifies the main work tree as --cwd copies nothing and reports
// nothing (acceptance 4 of the scope list).
// Not redundant: the only test that passes the main work tree as `--cwd` to the copy itself, so a copy that skips the main-tree check fails here alone.
test("returns null and changes nothing when cwd is the main work tree", async () => {
  const { main } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "A=1\n");

  expect(await copyLocalFiles(main)).toBeNull();
});

// Usefulness: verifies a repository with no main work tree copies nothing.
// Not redundant: the only test with a bare repository, whose first `git worktree list` entry is not a work tree.
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

// Usefulness: verifies copied files never change the clean flag or the digest,
// because a copied path is ignored and the snapshot never lists it (acceptance 7).
// Not redundant: the ignore-source and control-file tests prove other paths to a changed digest, and this one proves the plain copy leaves it unchanged.
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

// Usefulness: verifies the report holds names only — no file content reaches
// the report that the envelope, the transcript, and the logs carry.
// Not redundant: the other tests assert the lists, and only this one fails when a content string enters the report.
test("the report carries path names only, never content", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), `KEY=${SECRET}\n`);

  const report = await copyLocalFiles(linked);

  expect(JSON.stringify(report)).not.toContain(SECRET);
});

// Usefulness: verifies a copy never changes ignore rules — a `.gitignore` held by
// a listed directory is skipped, because a copied one can un-ignore a sibling
// that was copied and make the snapshot list it (review blocker 1). Not
// redundant: the digest test copies no rule file, so only this test fails when a
// copied `.gitignore` changes what the snapshot sees.
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

// Usefulness: verifies the snapshot identity is the same before and after the
// copy under every ignore source the issue names: the branch `.gitignore`, the
// shared `.git/info/exclude`, and `core.excludesFile` (review blocker 1). Not
// redundant: the other digest test uses one ignore source only.
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

// Usefulness: verifies a symlink into `.git` is skipped even though it resolves
// inside the main work tree path, because `.git` holds repository state, not a
// local file. Not redundant: the in-tree
// test would pass if the containment check ignored `.git`.
test.skipIf(process.platform === "win32")("skips a symlink that resolves into .git", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await symlink(join(".git", "config"), join(main, ".env"));

  const report = await copyLocalFiles(linked);

  expect(report).toEqual({ copied: [], skipped: [".env"] });
  expect(await exists(join(linked, ".env"))).toBe(false);
});

// Usefulness: verifies a symlink that resolves into another work tree nested in
// the main work tree is skipped, because that work tree holds a checkout, not a
// local file. Not redundant: the nested work tree test reaches the directory
// rule only, so removing the work tree list from the link containment check
// fails here alone.
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

// Usefulness: verifies the symlink policy of issue #423 ("The copy must not
// follow a symlink out of the main work tree"), taken without a race: a symlink
// is never followed, so a link that resolves inside the main work tree is
// skipped and named too, and nothing is created in its place. Not redundant: the
// outside-link test cannot tell a policy that follows in-tree links from one that
// follows none.
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

// Usefulness: verifies a directory symlink is skipped by name and not walked, so
// no file is copied through it, and a link back to an ancestor cannot loop. Not
// redundant: it is the only test of a directory link.
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

// Usefulness: verifies a listed path under a symlinked directory of the main work
// tree is skipped by name, because the read would go through the link. Not
// redundant: every other source test has the link at the leaf.
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

// Usefulness: verifies a case or Windows alias of a Git control file is skipped
// like the plain name (review blocker 4), on every platform. Not redundant: the
// control-file test uses the exact lower-case names, so only this one fails when
// the comparison is case-sensitive.
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

// Usefulness: verifies a case alias of `.git` or of `.claude/worktrees` is dropped
// like the plain name (review blocker 2), so a path that must be excluded is not
// read through another spelling. Not redundant: the worktrees test uses the exact
// lower-case path.
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

// Usefulness: verifies a source swapped for a symlink to a secret after the walk
// and before the open is not copied (review blocker 1). Not redundant: the
// symlink-policy tests set the link up before the walk, so only this one fails
// when the copy trusts the walk instead of the opened file.
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

// Usefulness: verifies a source whose ancestor directory is swapped for a symlink
// after the walk is not copied, which the no-follow flag on the last component
// alone does not stop. Not redundant: only this test fails when the opened file
// is not checked against its resolved path.
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

// Usefulness: verifies a target directory swapped for a symlink after the
// directories were created gets no content and no leftover file (review blocker
// 3). Not redundant: the symlinked-directory test sets the link up before the
// copy, so only this one fails when the target is not verified after the open.
test.skipIf(process.platform === "win32")(
  "writes nothing through a target directory that is swapped for a symlink",
  async () => {
    const { base, main, linked } = await createLinked({ ignore: [".claude/"] });
    const outside = join(base, "outside-claude");
    await mkdir(outside);
    await mkdir(join(main, ".claude"));
    await writeFile(join(main, ".claude", "settings.json"), `${SECRET}\n`);

    const report = await copyLocalFiles(linked, {
      beforeTargetOpen: async () => {
        await rm(join(linked, ".claude"), { recursive: true });
        await symlink(outside, join(linked, ".claude"));
      },
    });

    expect(report).toEqual({ copied: [], skipped: [".claude/settings.json"] });
    expect(await exists(join(outside, "settings.json"))).toBe(false);
  },
);

// Usefulness: verifies a target that appears in the linked work tree after the
// existence check is not overwritten, because the target is created exclusively.
// Not redundant: the existing-file test sets the file up before the check, so
// only this one fails when the create is not exclusive.
test("does not overwrite a target that appears after the existence check", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "from-main\n");

  const report = await copyLocalFiles(linked, {
    beforeTargetOpen: async () => {
      await writeFile(join(linked, ".env"), "already-here\n");
    },
  });

  expect(report).toEqual({ copied: [], skipped: [".env"] });
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("already-here\n");
});

// Usefulness: verifies a target directory that becomes a symlink after the
// existence check and before the directories are created is refused (review
// blocker 3). Not redundant: the swap test below fires after the directories
// exist, so only this one fails when an existing directory is not checked to be
// a real directory.
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

// Usefulness: verifies a target under a symlinked directory of the linked work
// tree is skipped, so a write cannot leave the linked work tree. Not redundant:
// every other test has real directories in the linked work tree.
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

// Usefulness: verifies the directory limit of the documented contract: a listed
// directory that holds more than 2000 entries is skipped as one name with none
// of its files copied, and it does not use up the bound of the next listed
// path. Not redundant: no other test reaches the bound.
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

// Usefulness: verifies a directory with exactly the bound of entries is still
// copied, so the bound is "more than" as documented. Not redundant: it fails if
// the limit is off by one, which the over-bound test cannot detect.
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
