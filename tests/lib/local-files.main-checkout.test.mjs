import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
 * Answers the three Git commands that find the main checkout: the top level of the
 * linked work tree, `git worktree list --porcelain`, and `git rev-parse
 * --git-common-dir`. A command in `failing` exits 128. Any other command is an error.
 */
function answerGit({ root, list, common, failing = [] }) {
  execa.mockImplementation(async (command, args) => {
    expect(command).toBe("git");
    const name = args.slice(0, 2).join(" ");
    const reply = {
      "rev-parse --show-toplevel": root,
      "worktree list": list,
      "rev-parse --git-common-dir": common,
    }[name];
    if (reply === undefined) {
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    }
    if (failing.includes(name)) {
      return { exitCode: 128, stdout: "", stderr: "fatal: simulated failure" };
    }
    return { exitCode: 0, stdout: `${reply}\n`, stderr: "" };
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

const entry = (path) => `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\n\n`;

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
// Not redundant: the two tests above give an existing directory, so the directory check
// is reached only here.
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
