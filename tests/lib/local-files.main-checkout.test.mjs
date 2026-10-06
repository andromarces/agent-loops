import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

// `git` is answered from memory, so a worktree list that Git would never print can
// be given to the main-checkout rule. Nothing else in the module is mocked.
vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { copyLocalFiles } from "../../src/lib/local-files.mjs";
import { removePath } from "../runtime-helpers.mjs";

const dirs = [];
let log;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  execa.mockReset();
  for (const dir of dirs.splice(0)) {
    await removePath(dir);
  }
});

/**
 * A Git that answers the three commands that find the main checkout: the top level of
 * the linked work tree (`top`, `root` unless given), `git worktree list --porcelain
 * -z`, and `git rev-parse --git-common-dir`. A command in `failing` exits 128, and so
 * does every command that runs outside `workingDirectory` when that is given. Any
 * other command is an error. Like execa, the double removes one final `\n` or `\r\n`
 * from the output unless the caller asks to keep it, so a path that ends in one of
 * them reaches the code only if the code asks for the output unchanged.
 */
function answerGit({ root, top = root, list, common, failing = [], workingDirectory }) {
  execa.mockImplementation(async (command, args, options = {}) => {
    expect(command).toBe("git");
    const name = args.slice(0, 2).join(" ");
    const reply = {
      "rev-parse --show-toplevel": top,
      "worktree list": list,
      "rev-parse --git-common-dir": common,
    }[name];
    if (reply === undefined) {
      throw new Error(`unexpected git call: ${JSON.stringify(args)}`);
    }
    if (failing.includes(name)) {
      return { exitCode: 128, stdout: "", stderr: "fatal: simulated failure" };
    }
    if (workingDirectory !== undefined && options.cwd !== workingDirectory) {
      return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    // The worktree list is a NUL separated stream; the other answers end in a newline.
    let stdout = name === "worktree list" ? reply : `${reply}\n`;
    if (options.stripFinalNewline !== false && name !== "worktree list") {
      stdout = stdout.replace(/\r?\n$/, "");
    }
    return { exitCode: 0, stdout, stderr: "" };
  });
}

async function makeBase() {
  const base = await mkdtemp(join(tmpdir(), "local-files-main-"));
  dirs.push(base);
  const root = join(base, "linked");
  const gitDir = join(base, "gitdir");
  await mkdir(root);
  await mkdir(gitDir);
  return { base, root, gitDir };
}

const entry = (path) => `worktree ${path}\0HEAD 0000000000000000000000000000000000000000\0\0`;

// Usefulness: verifies a first worktree entry that lies inside the common Git
// directory is not taken as the main checkout: nothing is copied and the run says so.
// Not redundant: Git never prints such an entry for a real repository, so no real
// repository can reach this rule; the answer is given from memory.
test("copies nothing when the first entry is inside the common Git directory", async () => {
  const { root, gitDir } = await makeBase();
  const inside = join(gitDir, "checkout");
  await mkdir(inside);
  answerGit({ root, list: entry(inside) + entry(root), common: gitDir });

  expect(await copyLocalFiles(root)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
});

// Usefulness: verifies a first entry that is the common Git directory itself is not
// taken as the main checkout.
// Not redundant: the inside test uses a path below the Git directory, and this one the
// Git directory, which is where Git lists a repository whose Git directory is separate.
test("copies nothing when the first entry is the common Git directory", async () => {
  const { root, gitDir } = await makeBase();
  answerGit({ root, list: entry(gitDir) + entry(root), common: gitDir });

  expect(await copyLocalFiles(root)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
});

// Usefulness: verifies a first entry whose path is not an existing directory, a missing
// path or a file, is not taken as the main checkout.
// Not redundant: the two tests above give an existing directory. This one gives a path
// that is missing and a path that is a file.
test("copies nothing when the first entry is not an existing directory", async () => {
  const { base, root, gitDir } = await makeBase();
  const file = join(base, "a-file");
  await writeFile(file, "x\n");
  for (const path of [join(base, "missing"), file]) {
    answerGit({ root, list: entry(path) + entry(root), common: gitDir });
    log.mockClear();

    expect(await copyLocalFiles(root), path).toBeNull();
    expect(log, path).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
  }
});

// Usefulness: verifies a Git command that fails while the main checkout is looked up
// fails the init with an error that names the command, and is not read as "no main
// work tree".
// Not redundant: the other tests in this file answer every command.
test("fails with a clear error when a Git command fails", async () => {
  const { root, gitDir } = await makeBase();
  const main = join(root, "..", "main");
  await mkdir(main);
  for (const failing of ["worktree list", "rev-parse --git-common-dir"]) {
    answerGit({ root, list: entry(main) + entry(root), common: gitDir, failing: [failing] });

    await expect(copyLocalFiles(root), failing).rejects.toThrow(
      `local files: git ${failing.split(" ")[0]} failed (exit 128): fatal: simulated failure`,
    );
  }
});

const refusal = () => expect.stringContaining("control character");

// Usefulness: verifies a `--cwd` with a control character is refused without any Git
// command, so nothing in Git's output or a path comparison can redirect it. The Git
// double throws on any call, so a copy that asked Git anything would reject.
// Not redundant: it is the test where Git cannot be reached at all. It runs on every
// platform, since it needs no directory.
test("copies nothing without asking Git for a --cwd with a control character", async () => {
  execa.mockImplementation(() => {
    throw new Error("git must not run for this --cwd");
  });
  for (const cwd of ["/run\n", "/run\r", "/run\t", "/ru\nn", "/run\u007f"]) {
    expect(await copyLocalFiles(cwd), JSON.stringify(cwd)).toBeNull();
  }
  expect(log).toHaveBeenCalledWith(refusal());
});

// Usefulness: verifies a top-level path that Git prints with a control character at its
// end is refused when `--cwd` itself is clean: a path that ends in a line feed or a
// carriage return keeps it, and the copy stops there. Git answers `<root>` plus the
// character plus its own terminator, and every later Git command fails, so a copy that
// had lost the character would carry on, ask for the work tree list, and reject.
// Not redundant: `--cwd` is clean in this test, so the refusal can come only from the
// printed top level.
test("copies nothing when Git prints a top level that ends in a control character", async () => {
  const { root } = await makeBase();
  for (const character of ["\n", "\r"]) {
    answerGit({
      root,
      top: `${root}${character}`,
      list: entry(root),
      common: ".git",
      failing: ["worktree list", "rev-parse --git-common-dir"],
    });

    expect(await copyLocalFiles(root), JSON.stringify(character)).toBeNull();
  }
  expect(log).toHaveBeenCalledWith(refusal());
});

// Usefulness: verifies a common Git directory whose path ends in a newline is refused,
// while the first entry and every other path are clean, so it is not read as the
// shorter path.
// Not redundant: the first entry here is clean and outside the directory, so the
// refusal can come only from the common Git directory check. It is not run on Windows,
// which cannot hold the character.
test.skipIf(process.platform === "win32")(
  "copies nothing and reports it when only the common Git directory ends in a newline",
  async () => {
    const { base, root } = await makeBase();
    const main = join(base, "main");
    await mkdir(main);
    const gitDir = join(base, "gitdir\n");
    await mkdir(gitDir);
    answerGit({ root, list: entry(main) + entry(root), common: gitDir });

    expect(await copyLocalFiles(root)).toBeNull();
    expect(log).toHaveBeenCalledWith(refusal());
  },
);

// Usefulness: verifies a first entry whose own path is clean but whose canonical path
// holds a control character, because a directory above it is a symlink to such a
// directory, is refused.
// Not redundant: the printed path is clean, so the refusal can come only from the check
// of the canonical path. It is not run on Windows, which cannot hold the character.
test.skipIf(process.platform === "win32")(
  "copies nothing and reports it when the main work tree resolves to a path with a newline",
  async () => {
    const { base, root, gitDir } = await makeBase();
    const real = join(base, "real\nmain");
    await mkdir(join(real, "main"), { recursive: true });
    const alias = join(base, "alias");
    await symlink(real, alias);
    answerGit({ root, list: entry(join(alias, "main")) + entry(root), common: gitDir });

    expect(await copyLocalFiles(root)).toBeNull();
    expect(log).toHaveBeenCalledWith(refusal());
  },
);

// Usefulness: verifies a registered work tree path with a control character is refused
// as printed, even when it is not the first entry and its directory does not exist.
// Not redundant: the other tests in this file put the character in the first entry, the
// top level, the Git directory, or a resolved path. It needs no directory, so it runs
// on every platform.
test("copies nothing and reports it when a later registered work tree path has a newline", async () => {
  const { base, root, gitDir } = await makeBase();
  const main = join(base, "main");
  await mkdir(main);
  answerGit({ root, list: entry(main) + entry(root) + entry(`${base}/gone\nwt`), common: gitDir });

  expect(await copyLocalFiles(root)).toBeNull();
  expect(log).toHaveBeenCalledWith(refusal());
});

// Usefulness: verifies a common Git directory whose printed path is clean but resolves
// to a path with a control character is refused.
// Not redundant: the other common Git directory test prints the control character
// itself, so the refusal here can come only from the check of the resolved path. It is
// not run on Windows, which cannot hold the character.
test.skipIf(process.platform === "win32")(
  "copies nothing and reports it when the common Git directory resolves to a path with a newline",
  async () => {
    const { base, root } = await makeBase();
    const main = join(base, "main");
    await mkdir(main);
    const real = join(base, "git\ndir");
    await mkdir(real);
    const alias = join(base, "gitalias");
    await symlink(real, alias);
    answerGit({ root, list: entry(main) + entry(root), common: alias });

    expect(await copyLocalFiles(root)).toBeNull();
    expect(log).toHaveBeenCalledWith(refusal());
  },
);

// Usefulness: verifies the Git commands after the top-level lookup run in the operator's
// own `--cwd` string when Git names the same directory. Here `--cwd` is the work tree
// with a trailing separator and Git prints it without. The Git double works only in the
// operator's string, so a copy that ran later commands in Git's echo would reject.
// Not redundant: it needs no control character, so it runs on every platform, and no
// other test gives Git a working directory that is spelled differently from its echo.
test("copies nothing and reports it when Git runs only in the operator's --cwd", async () => {
  const { root, gitDir } = await makeBase();
  const operator = `${root}${sep}`;
  answerGit({ root, list: entry(gitDir), common: gitDir, workingDirectory: operator });

  expect(await copyLocalFiles(operator)).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no main work tree"));
});

// Usefulness: acceptance (#522) — a merged-argument call reads differently from the split call in the error.
test("answerGit error for a merged-argument call differs from the split call text", async () => {
  answerGit({ root: tmpdir(), list: "", common: "" });
  const message = (args) =>
    execa("git", args).then(
      () => undefined,
      (error) => error.message,
    );
  expect(await message(["branch", "--show-current"])).toBeDefined();
  expect(await message(["branch --show-current"])).not.toBe(
    await message(["branch", "--show-current"]),
  );
});
