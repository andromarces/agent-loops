import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { execa } from "execa";
import { copyLocalFiles } from "../../src/lib/local-files.mjs";
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
test("returns null and changes nothing when cwd is the main work tree", async () => {
  const { main } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), "A=1\n");

  expect(await copyLocalFiles(main)).toBeNull();
});

// Usefulness: verifies a repository with no main work tree copies nothing.
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
test("the report carries path names only, never content", async () => {
  const { main, linked } = await createLinked({ ignore: [".env"] });
  await writeFile(join(main, ".env"), `KEY=${SECRET}\n`);

  const report = await copyLocalFiles(linked);

  expect(JSON.stringify(report)).not.toContain(SECRET);
});
