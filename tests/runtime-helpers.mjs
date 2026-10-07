import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";

/**
 * True when `args` begins with the elements of `lead`, compared element by
 * element. A call that merges arguments into one element does not match, which
 * a substring test on the joined text cannot tell apart.
 */
export function startsWithArgs(args, lead) {
  return lead.every((part, i) => args[i] === part);
}

/** True when `args` is a `gh api` call whose endpoint ends with `suffix`. */
export function isApiRead(args, suffix) {
  return args[0] === "api" && typeof args[1] === "string" && args[1].endsWith(suffix);
}

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

/**
 * Removes a test path, retrying transient Windows locks. `fs.rm` retries
 * EBUSY, EPERM, and ENOTEMPTY only when `maxRetries` is set (default 0), so a
 * handle held by antivirus, an indexer, or a lingering child otherwise fails
 * the removal. Retries stay scoped to fixture removal, both setup and
 * teardown; a deliberate in-test delete that is itself the case under test
 * keeps plain `rm`.
 */
export async function removePath(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_MAX_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}

const REMOVE_MAX_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;
// `fs.rm` backs off linearly: retry n waits n * retryDelay. A path that stays
// locked therefore costs 100 + 200 + ... + 1000 = 5500 ms before `removePath`
// throws (measured at 5573 ms on Windows with a child holding the directory).
// Test timeouts that include a `removePath` add this, not the delay alone.
const REMOVE_MAX_WAIT_MS =
  (REMOVE_RETRY_DELAY_MS * REMOVE_MAX_RETRIES * (REMOVE_MAX_RETRIES + 1)) / 2;
// Slack over the retry waits for the removal calls themselves.
const REMOVE_SYSCALL_SLACK_MS = 500;

// Captured at import, before any test overrides the runs root.
const originalRunsRoot = process.env.AGENT_LOOP_RUNS_ROOT;

/**
 * Puts AGENT_LOOP_RUNS_ROOT back to the value it had before the tests overrode
 * it: set when it existed, deleted only when it did not.
 */
export function restoreRunsRoot() {
  if (originalRunsRoot === undefined) {
    delete process.env.AGENT_LOOP_RUNS_ROOT;
  } else {
    process.env.AGENT_LOOP_RUNS_ROOT = originalRunsRoot;
  }
}

// Captured at import, before any test overrides the install home.
const originalAgentLoopHome = process.env.AGENT_LOOP_HOME;

/**
 * Puts AGENT_LOOP_HOME back to the value it had before the tests overrode it:
 * set when it existed, deleted only when it did not.
 */
export function restoreAgentLoopHome() {
  if (originalAgentLoopHome === undefined) {
    delete process.env.AGENT_LOOP_HOME;
  } else {
    process.env.AGENT_LOOP_HOME = originalAgentLoopHome;
  }
}

/**
 * Runs an ordered list of fake replies and records each call in `recorded`.
 * A reply may be a value or a `(state, prompt, options)` function; values are
 * returned as-is, functions are called instead.
 */
export function scripted(replies) {
  let callIndex = 0;
  const recorded = [];
  return {
    recorded,
    async run(state, prompt, options) {
      state.sessionId = state.sessionId ?? `${state.kind}-sess`;
      recorded.push({ prompt, options, sessionId: state.sessionId });
      const reply = replies[callIndex++];
      if (typeof reply === "function") {
        return reply(state, prompt, options);
      }
      return reply;
    },
  };
}

/**
 * Resolves to the pid of an exited one-shot process, so callers can build a
 * lock file that points at a dead owner. child_process exposes the pid; execa's
 * result does not.
 */
export async function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid));
    child.on("error", reject);
  });
}

// The hanging child is a `node` process on every platform, launched by a wrapper
// that stays alive as its parent (`.cmd` on Windows, `sh` with a background job
// and `wait` elsewhere, so the shell never execs into node). A kill that reaches
// only the wrapper leaves the node process running.
//
// These helpers prove termination only. The bound value is proved without a
// clock by tests/lib/spawn-bounds.test.mjs, so every wait here is a generous
// ceiling that load cannot reach, and none of them measures the bound.
const SHIM_HANG_MS = 60_000;
// The force-kill delay the runners pass with a bound. The source sets it in
// runGh and assertGitWorkTree, and spawn-bounds.test.mjs pins the value there, so
// a change to it fails that test until this constant follows.
export const FORCE_KILL_AFTER_DELAY_MS = 1000;
// With no bound the runners pass no delay, so execa applies its own default. It is
// the delay the abort path waits before the forced kill.
const ABORT_FORCE_KILL_AFTER_DELAY_MS = 5000;
// Slack past the force-kill boundary for the OS to finish tearing the process
// down: TerminateProcess and SIGKILL finish in milliseconds, and the pid leaves
// the process table shortly after. One second is far above that and small against
// the delay it follows, so a child that outlives it was not force-killed.
const TEARDOWN_MARGIN_MS = 1000;
// The longest a call may take to return once the bound or the abort has fired.
// A survivor that holds the call open never returns, so this cap fails the test
// with the reason before the test timeout does.
const CALL_CEILING_MS = 10_000;
// The longest the shim may take to record its pid, and to make the record visible.
const START_WAIT_MS = 10_000;
const RECORD_VISIBLE_MS = 500;
// The most the cleanup after a test can take: killing a leftover child is
// instant, and `removePath` costs at most its full retry backoff.
const CLEANUP_MS = REMOVE_MAX_WAIT_MS + REMOVE_SYSCALL_SLACK_MS;
// The most the fixture setup before a test can take: `mkdtemp`, then writing the
// hang script and the wrapper, are three file system calls. A call is
// milliseconds unless an antivirus scan or an indexer holds the file, so each
// gets one second.
const SETUP_STEPS = 3;
const SETUP_STEP_MS = 1000;
const SETUP_MS = SETUP_STEPS * SETUP_STEP_MS;
const BOUND_MS = 2000;

/**
 * Vitest timeouts for the two helpers below. Each is the sum of the waits the
 * helper permits, so a test that waits within its limits cannot hit the test
 * timeout, and a test that exceeds a limit fails on that limit's own message.
 */
export const BOUND_KILL_TEST_TIMEOUT_MS =
  SETUP_MS +
  BOUND_MS +
  CALL_CEILING_MS +
  RECORD_VISIBLE_MS +
  FORCE_KILL_AFTER_DELAY_MS +
  TEARDOWN_MARGIN_MS +
  CLEANUP_MS;
export const ABORT_KILL_TEST_TIMEOUT_MS =
  SETUP_MS +
  START_WAIT_MS +
  CALL_CEILING_MS +
  ABORT_FORCE_KILL_AFTER_DELAY_MS +
  TEARDOWN_MARGIN_MS +
  CLEANUP_MS;

/**
 * Writes a `command` shim into `dir` that hangs, so a kill is exercised against
 * a real child process. The long-lived node process records its own pid in
 * `started`, then exits by itself after SHIM_HANG_MS.
 */
async function writeHangingShim(dir, command) {
  const started = join(dir, "started.txt");
  const script = join(dir, "hang.js");
  await writeFile(
    script,
    `require("fs").writeFileSync(${JSON.stringify(started)}, String(process.pid));
setTimeout(() => {}, ${SHIM_HANG_MS});
`,
  );
  if (process.platform === "win32") {
    await writeFile(join(dir, `${command}.cmd`), `@echo off\r\nnode "${script}"\r\n`);
  } else {
    await writeFile(join(dir, command), `#!/bin/sh\nnode '${script}' &\nwait\n`, { mode: 0o755 });
  }
  return { started };
}

// Returns the pid the shim recorded, or null if none appears within `waitMs`.
async function waitForPid(started, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const pid = Number.parseInt(await readFile(started, "utf8").catch(() => ""), 10);
    if (Number.isInteger(pid)) {
      return pid;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await delay(50);
  }
}

// `kill(pid, 0)` sends no signal. It throws ESRCH once the process is gone, on
// POSIX and on Windows (where Node reports an exited process as ESRCH).
// known-limit: the OS may hand the pid to another process inside the window, which
// reads as alive and fails the test; the window is seconds, so reuse is not a
// practical risk.
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// The child must be gone once the force-kill boundary and the teardown margin
// have passed after the call returned. The force-kill timer starts when the kill
// is sent, which is at or before the return, so a child alive past this point was
// not force-killed.
async function assertGone(pid, forceKillAfterDelayMs) {
  const deadline = Date.now() + forceKillAfterDelayMs + TEARDOWN_MARGIN_MS;
  while (processExists(pid) && Date.now() < deadline) {
    await delay(50);
  }
  assert.ok(
    !processExists(pid),
    `the shim child ${pid} outlived the ${forceKillAfterDelayMs} ms force-kill boundary`,
  );
}

// A call that a surviving child holds open never returns, so the wait is capped
// and fails with the reason instead of running into the test timeout.
async function returnsWithin(call, limitMs, message) {
  const cap = new AbortController();
  try {
    return await Promise.race([
      call,
      delay(limitMs, undefined, { signal: cap.signal }).then(() => {
        throw new assert.AssertionError({ message });
      }),
    ]);
  } finally {
    cap.abort();
  }
}

// A child that survived a failed test would hold its directory open and keep
// running for SHIM_HANG_MS. Killing it is instant, so it adds nothing to the
// cleanup budget, and it lets `removePath` succeed on its first try. Callers use
// it only while the test still owns the pid: once the gone check passed, the OS
// may have handed the pid to another process, which must never be signalled.
function killLeftover(pid) {
  if (pid !== null && processExists(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The child exited between the check and the kill.
    }
  }
}

async function withShimOnPath(dir, body) {
  const path = process.env.PATH;
  try {
    process.env.PATH = `${dir}${delimiter}${path}`;
    return await body();
  } finally {
    process.env.PATH = path;
  }
}

/**
 * Checks that a time bound kills a real hanging `command` child. `run(boundMs)`
 * starts the bounded call and resolves when it returns. The call must return
 * within `boundMs` plus CALL_CEILING_MS, and the node process the shim recorded
 * must be gone within the force-kill delay plus the teardown margin after that.
 * The child must have started before the call returned, or the test fails: a
 * child that never ran proves nothing about the kill, so `boundMs` must leave the
 * shim time to start on a loaded machine. That value is not what is under test
 * here. Pass BOUND_KILL_TEST_TIMEOUT_MS as the test timeout. Returns the call
 * result.
 */
export async function expectBoundKillsShim(command, run, boundMs = BOUND_MS) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  let pid = null;
  let record = null;
  let gone = false;
  try {
    const shim = await writeHangingShim(dir, command);
    record = shim.started;
    return await withShimOnPath(dir, async () => {
      const result = await returnsWithin(
        run(boundMs),
        boundMs + CALL_CEILING_MS,
        "the call did not return after its bound",
      );
      // The record was written before the bound expired, so a short wait only
      // covers file visibility.
      pid = await waitForPid(shim.started, RECORD_VISIBLE_MS);
      assert.notEqual(pid, null, `the shim did not start within the ${boundMs} ms bound`);
      await assertGone(pid, FORCE_KILL_AFTER_DELAY_MS);
      gone = true;
      return result;
    });
  } finally {
    if (!gone) {
      killLeftover(pid ?? (record && (await waitForPid(record, 0))));
    }
    await removePath(dir);
  }
}

/**
 * Checks that an abort signal kills a real hanging `command` child. `start(signal)`
 * starts the call without a time bound and returns its promise. The test aborts
 * only after the shim recorded its pid, so a slow start cannot make the abort
 * precede the child. The child must be gone within execa's default force-kill
 * delay plus the teardown margin after the call returns. Pass
 * ABORT_KILL_TEST_TIMEOUT_MS as the test timeout.
 */
export async function expectAbortKillsShim(command, start) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  let pid = null;
  let record = null;
  let gone = false;
  try {
    const shim = await writeHangingShim(dir, command);
    record = shim.started;
    return await withShimOnPath(dir, async () => {
      const controller = new AbortController();
      const pending = start(controller.signal);
      pid = await waitForPid(shim.started, START_WAIT_MS);
      assert.notEqual(pid, null, "the shim never started");
      controller.abort();
      const result = await returnsWithin(
        pending,
        CALL_CEILING_MS,
        "the call did not return after the abort",
      );
      await assertGone(pid, ABORT_FORCE_KILL_AFTER_DELAY_MS);
      gone = true;
      return result;
    });
  } finally {
    if (!gone) {
      killLeftover(pid ?? (record && (await waitForPid(record, 0))));
    }
    await removePath(dir);
  }
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
