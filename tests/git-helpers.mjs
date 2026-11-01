import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { vi } from "vite-plus/test";
import { removePath } from "./fs-helpers.mjs";

/**
 * Creates a temporary git repository with one initial commit (`init.txt`).
 * Side effect: leaves a directory in the OS temp dir; callers must remove it
 * with `removePath`.
 */
export async function createTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "runtime-test-repo-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.name", "Tester"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(join(dir, "init.txt"), "hello\n");
  await execa("git", ["add", "init.txt"], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

/**
 * Creates a main work tree with one commit and a linked work tree on a new
 * branch `run`, both under one temp directory. `ignore` lines go to the shared
 * `.git/info/exclude`. `seed(main)` runs after the first commit and before the
 * linked work tree exists. `mainName` and `linkedName` name the two directories.
 * Callers remove `base` with `removePath`.
 */
export async function createLinkedWorkTree({
  ignore = [],
  seed = async () => {},
  mainName = "main",
  linkedName = "linked",
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "linked-test-"));
  const main = join(base, mainName);
  const linked = join(base, linkedName);
  await mkdir(main);
  await execa("git", ["init"], { cwd: main });
  await execa("git", ["config", "user.name", "Tester"], { cwd: main });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: main });
  await writeFile(join(main, "init.txt"), "hello\n");
  await execa("git", ["add", "init.txt"], { cwd: main });
  await execa("git", ["commit", "-m", "init"], { cwd: main });
  await writeFile(join(main, ".git", "info", "exclude"), `${ignore.join("\n")}\n`);
  await seed(main);
  await execa("git", ["worktree", "add", linked, "-b", "run"], { cwd: main });
  return { base, main, linked };
}

// A clean repo at `CLEAN_REPO_HEAD`, answered from memory for a test that routes
// `execa` through a double. The real snapshot code still runs over these answers;
// only the `git` processes are gone. Each reply holds the bytes `git` prints, and
// `answer` applies the `stripFinalNewline` option as execa does. Only the exact
// argument arrays that the code under test sends are answered, compared element by
// element; any other `git` call, including a changed flag, flag order, or two
// arguments joined into one element, throws. A `cwd` that does not exist fails
// as execa does with `reject: false`: no exit code, `code: "ENOENT"`, empty output.
export const CLEAN_REPO_HEAD = "1111111111111111111111111111111111111111";
export const CLEAN_REPO_BRANCH = "main";

export function cleanRepoGit(command, args, options) {
  assert.equal(command, "git");
  if (!existsSync(options.cwd)) {
    return { exitCode: undefined, failed: true, code: "ENOENT", stdout: "", stderr: "" };
  }
  // execa strips one final newline from stdout unless `stripFinalNewline` is false.
  const answer = (stdout) => ({
    exitCode: 0,
    stdout: options?.stripFinalNewline === false ? stdout : stdout.replace(/\r?\n$/, ""),
    stderr: "",
  });
  switch (JSON.stringify(args)) {
    case '["rev-parse","--is-inside-work-tree"]':
      return answer("true\n");
    // The directory holds a `.git` directory, which is the common Git directory.
    case '["rev-parse","--git-common-dir"]':
      return answer(".git\n");
    case '["rev-parse","--show-toplevel"]':
      return answer(`${options.cwd}\n`);
    case '["rev-parse","--verify","-q","HEAD"]':
      return answer(`${CLEAN_REPO_HEAD}\n`);
    case '["symbolic-ref","--short","-q","HEAD"]':
      return answer(`${CLEAN_REPO_BRANCH}\n`);
    case '["status","--porcelain=v1","-z","--untracked-files=all"]':
    case '["ls-files","--stage","-z"]':
      return answer("");
    // The directory is the only work tree, on branch `main`, in the `--porcelain -z`
    // format: NUL-ended `worktree`, `HEAD`, and `branch` fields, then an empty field.
    // The init copy of local files has no main work tree to copy from.
    case '["worktree","list","--porcelain","-z"]':
      return answer(`worktree ${options.cwd}\0HEAD ${CLEAN_REPO_HEAD}\0branch refs/heads/main\0\0`);
    default:
      throw new Error(`unexpected git call: ${JSON.stringify(args)}`);
  }
}

/**
 * A temporary directory that holds a `.git` directory, for a test that routes `git` through
 * `cleanRepoGit`. The directory is not a repository: only the double answers for it, so the test
 * starts no `git` process. The caller removes it with `removePath`.
 */
export async function createCleanRepoDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-repo-"));
  await mkdir(join(dir, ".git"));
  return dir;
}

/**
 * A linked work tree whose main checkout holds an ignored `.env` with `KEY=<secret>`. The tree's
 * `base` is appended to `bases`, so the caller's `afterEach` removes it.
 */
export async function createLinkedWithEnv(secret, bases) {
  const tree = await createLinkedWorkTree({ ignore: [".env"] });
  bases.push(tree.base);
  await writeFile(join(tree.main, ".env"), `KEY=${secret}\n`);
  return tree;
}

/**
 * Builds `withContinueRepo(fn)` for a test file whose hoisted `execa` mock reads `gitDouble.answer`.
 * It runs `fn(repo, transcriptPath, errorSpy)` with a clean exit-code and error state. The repo is
 * a directory with a `.git` directory and `git` is answered from memory (`cleanRepoGit`), so the
 * test starts no `git` process. The repo is removed afterwards.
 */
export function createWithContinueRepo(gitDouble) {
  return async function withContinueRepo(fn) {
    const repo = await createCleanRepoDir();
    gitDouble.answer = cleanRepoGit;
    const origExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fn(repo, join(repo, "run.json"), errorSpy);
    } finally {
      process.exitCode = origExitCode;
      errorSpy.mockRestore();
      logSpy.mockRestore();
      gitDouble.answer = null;
      await removePath(repo);
    }
  };
}

/**
 * A `git` double that puts a cancel inside the post-turn snapshot by construction. The adapter
 * calls `arm()` as its last act, so the next `git` call is that snapshot. It aborts `controller`
 * and then answers as `cleanRepoGit`. `fired` is true once the abort ran, so a test can assert that
 * it reached the window.
 */
export function gitAbortingPostTurn(controller) {
  const window = {
    fired: false,
    armed: false,
    arm: () => {
      window.armed = true;
    },
    git: (command, args, options) => {
      if (window.armed && !window.fired) {
        window.fired = true;
        controller.abort();
      }
      return cleanRepoGit(command, args, options);
    },
  };
  return window;
}

// `cleanRepoGit` for a repo with no tracked files, whose `status` lists each regular
// file in the top level of the directory as untracked, read from the real work tree
// at call time. A write by the test command or an agent therefore shows up in the
// next snapshot, as it does under real `git`, and no `git` process runs. Files in
// subdirectories are not listed.
export async function untrackedFilesGit(command, args, options) {
  if (JSON.stringify(args) !== '["status","--porcelain=v1","-z","--untracked-files=all"]') {
    return cleanRepoGit(command, args, options);
  }
  const entries = await readdir(options.cwd, { withFileTypes: true });
  const stdout = entries
    .filter((entry) => entry.isFile())
    .map((entry) => `?? ${entry.name}\0`)
    .join("");
  return { exitCode: 0, stdout, stderr: "" };
}

// `cleanRepoGit` for a directory that is a work tree only while it holds a `.git`
// entry. Without one, every `git` call exits 128 with git's "not a git repository"
// message, as real `git` does for lost Git metadata, and no `git` process runs. A
// directory that is gone fails as `cleanRepoGit` reports it.
export function gitWhileDotGitExists(command, args, options) {
  if (existsSync(join(options.cwd, ".git")) || !existsSync(options.cwd)) {
    return cleanRepoGit(command, args, options);
  }
  return {
    exitCode: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git",
  };
}
