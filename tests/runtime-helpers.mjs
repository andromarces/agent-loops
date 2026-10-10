import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

/** True when `args` equals `expected` element by element, with no extra element. */
export function equalsArgs(args, expected) {
  return args.length === expected.length && startsWithArgs(args, expected);
}

/** The flags the gate passes to every paginated `gh api` read. */
export const PAGED = ["--paginate", "--slurp"];

/** The exact argument elements of the gate's `gh pr view` read. */
export const prViewArgs = (pr) => [
  "pr",
  "view",
  String(pr),
  "--json",
  "headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit",
];

/** The exact argument elements of the gate's `gh pr checks` read. */
export const prChecksArgs = (pr) => ["pr", "checks", String(pr), "--required", "--json", "name"];

/** The exact argument elements of the gate's `gh repo view` read. */
export const REPO_VIEW_ARGS = ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"];

/** The exact argument elements of a `gh api` read of `endpoint` with `flags`. */
export const apiArgs = (endpoint, flags = PAGED) => ["api", endpoint, ...flags];

/**
 * True when `args` is a `gh api` call whose endpoint ends with `suffix`. With
 * `flags`, the elements after the endpoint must equal `flags`, so a call that
 * merges two flags into one element does not match.
 */
export function isApiRead(args, suffix, flags) {
  return (
    args[0] === "api" &&
    typeof args[1] === "string" &&
    args[1].endsWith(suffix) &&
    (flags === undefined || equalsArgs(args.slice(2), flags))
  );
}

/** Every `gh` read the gate makes for PR 42 on `owner/repo` at `head`, as exact arguments. */
export const gateReadCalls = (head) => [
  prViewArgs(42),
  REPO_VIEW_ARGS,
  apiArgs("repos/owner/repo/rules/branches/main"),
  apiArgs("repos/owner/repo/branches/main/protection", []),
  apiArgs(`repos/owner/repo/commits/${head}/check-runs`),
  apiArgs(`repos/owner/repo/commits/${head}/status`),
  prChecksArgs(42),
];

/**
 * Asserts that `gh` fails every malformed variant of each call in `calls`: the
 * last two elements merged into one, the last element dropped, and an extra
 * element added. Each failure prints the arguments as an array.
 */
export async function expectNoReplyToMalformedCalls(gh, calls) {
  for (const args of calls) {
    const variants = [
      [...args.slice(0, -2), args.slice(-2).join(" ")],
      args.slice(0, -1),
      [...args, "--extra"],
    ];
    for (const bad of variants) {
      const reply = await gh(bad);
      assert.equal(reply.status, 1, `a reply to ${JSON.stringify(bad)}`);
      assert.equal(reply.stdout, "");
      assert.ok(reply.stderr.includes(JSON.stringify(bad)), `no array in: ${reply.stderr}`);
    }
  }
}

/**
 * Creates a symlink, or skips the test where the host cannot: Windows without the symlink
 * privilege. Every other failure throws, so Linux and macOS never skip silently.
 */
export async function symlinkOrSkip(ctx, target, path, type) {
  try {
    await symlink(target, path, type);
  } catch (err) {
    if (process.platform === "win32" && err?.code === "EPERM") ctx.skip();
    throw err;
  }
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
 * Resolves to a pid that no process can hold, so callers can build a lock file
 * that points at a dead owner. The pid is the largest signed 32-bit integer, the
 * largest value `process.kill` accepts: it is above the pid limit of Linux
 * (2^22) and macOS (99999), and a Windows pid is a multiple of 4. The OS never
 * reuses it, unlike the pid of an exited process.
 */
export async function deadPid() {
  return 2 ** 31 - 1;
}

// The hanging child is a `node` process on every platform, launched by a wrapper
// that stays alive as its parent (`.cmd` on Windows, `sh` with a background job
// and `wait` elsewhere, so the shell never execs into node). A kill that reaches
// only the wrapper leaves the node process running.
//
// These helpers prove termination only. The bound value is proved without a
// clock by tests/lib/spawn-bounds.test.mjs, so every wait here is a generous
// ceiling that load cannot reach, and none of them measures the bound.
//
// A shim bounds itself by wall-clock time. Its ceiling is the longest window in which the
// helper still waits on it, so a correct kill always comes first, and a failed kill is
// caught by the helper before the ceiling can end the shim and hide it.
// The shim checks its `keep` file this often.
const SHIM_POLL_MS = 50;
const KEEP_FILE = "keep";
const EXITED_FILE = "exited";
const CEILING_FILE = "ceiling";
const HOLD_FILE = "hold";
// The shim exits unconditionally at this multiple of its ceiling, whatever the marker or file
// state. Every helper's kill check ends within the ceiling, so the hard deadline comes after it
// and a failed kill is reported as outlived first. It is the bound on any survivor.
const HARD_DEADLINE_FACTOR = 2;
const hardDeadlineMs = (ceilingMs) => ceilingMs * HARD_DEADLINE_FACTOR;
// The longest cleanup waits for a surviving shim to acknowledge its exit. The shim polls every
// SHIM_POLL_MS, so a live shim answers within a few polls even on a loaded machine.
const SHIM_EXIT_WAIT_MS = 5000;
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
// The most the cleanup after a test can take: the wait for a surviving shim to exit, then
// `removePath` at its full retry backoff.
const CLEANUP_MS = SHIM_EXIT_WAIT_MS + REMOVE_MAX_WAIT_MS + REMOVE_SYSCALL_SLACK_MS;
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
 * `started`. It stays alive only while the `keep` or the `hold` file exists, so it
 * exits when both are gone by any means, when `dir` is gone, or at the wall-clock
 * ceiling `ceilingMs`. A ceiling exit writes the `ceiling` marker first, so a helper
 * can tell it from a kill. If that write fails, the shim does not exit: it stays alive
 * and retries, so no ceiling exit goes unmarked. At the hard deadline it exits whatever
 * the marker or file state, so a survivor has a bound. On exit it writes the `exited` marker when `dir` still
 * exists. The test never signals that pid.
 *
 * Each poll reads `keep` first and `hold` second. A test that swaps the keep file
 * creates `hold` before it removes `keep` and never removes `hold` while the shim
 * must live. The shim reads `keep` absent only after the test removed it, and `hold`
 * was created before that removal, so the later `hold` read sees it: no poll finds
 * both absent during the swap.
 */
async function writeHangingShim(dir, command, ceilingMs) {
  const started = join(dir, "started.txt");
  const script = join(dir, "hang.js");
  const keep = join(dir, KEEP_FILE);
  const hold = join(dir, HOLD_FILE);
  await writeFile(keep, "");
  await writeFile(
    script,
    `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
const begun = Date.now();
process.on("exit", () => {
  try {
    fs.writeFileSync(${JSON.stringify(join(dir, EXITED_FILE))}, "");
  } catch {
    // The directory is already gone, so nobody waits for the marker.
  }
});
const watch = setInterval(() => {
  const alive = fs.existsSync(${JSON.stringify(keep)}) || fs.existsSync(${JSON.stringify(hold)});
  if (Date.now() - begun >= ${hardDeadlineMs(ceilingMs)}) {
    clearInterval(watch);
  } else if (!alive || !fs.existsSync(${JSON.stringify(dir)})) {
    clearInterval(watch);
  } else if (Date.now() - begun >= ${ceilingMs}) {
    try {
      fs.writeFileSync(${JSON.stringify(join(dir, CEILING_FILE))}, "");
      clearInterval(watch);
    } catch {
      // Fail closed: a ceiling exit without its marker would pass as a kill. The shim stays
      // alive, so the helper reports it as a survivor, and retries the write on the next
      // poll. A removed directory or keep file, or the hard deadline, ends it.
    }
  }
}, ${SHIM_POLL_MS});
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
async function assertGone(pid, forceKillAfterDelayMs, dir) {
  const deadline = Date.now() + forceKillAfterDelayMs + TEARDOWN_MARGIN_MS;
  while (processExists(pid) && Date.now() < deadline) {
    await delay(50);
  }
  assert.ok(
    !processExists(pid),
    `the shim child ${pid} outlived the ${forceKillAfterDelayMs} ms force-kill boundary`,
  );
  // The shim writes this marker before it exits on its own ceiling, so an exit the
  // runtime did not cause cannot pass as a kill.
  assert.ok(
    !statSync(join(dir, CEILING_FILE), { throwIfNoEntry: false })?.isFile(),
    `the shim child ${pid} exited on its wall-clock ceiling, so the code under test did not kill it`,
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

// A child that survived a failed test would hold its directory open until its
// ceiling. The `keep` file is a handle the test owns: the test deletes it, the
// shim sees that and exits by itself, and the `exited` marker acknowledges it.
// The marker is written as the exit starts, so the wait then continues until the
// recorded pid no longer exists. That check sends no signal, and no pid from a
// file is ever signalled, because the OS may hand that pid to another process once
// the shim exits. The test does not own the shim process, so it cannot end it. A
// shim that does not confirm its exit within SHIM_EXIT_WAIT_MS is reported with its
// pid and its own wall-clock ceiling, which ends it. A missing or unreadable pid
// record proves nothing and is reported as an unconfirmed exit. `gone` is true when
// the test already proved the child ended. Returns the errors: the keep file removal,
// and any exit that is not confirmed.
async function stopShim(dir, gone, ceilingMs) {
  const errors = [];
  try {
    await rm(join(dir, KEEP_FILE), { force: true });
  } catch (error) {
    errors.push(error);
  }
  if (gone) {
    return errors;
  }
  const deadline = Date.now() + SHIM_EXIT_WAIT_MS;
  const until = async (done) => {
    while (!(await done())) {
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(SHIM_POLL_MS);
    }
    return true;
  };
  const survivor = (pid) =>
    `the shim in ${dir} (pid ${pid ?? "unknown"}) did not exit within ${SHIM_EXIT_WAIT_MS} ms of cleanup. ` +
    `The test does not own it and sends it no signal; its own hard wall-clock deadline of ${Math.ceil(hardDeadlineMs(ceilingMs) / 1000)} s ends it`;
  const pid = await waitForPid(join(dir, "started.txt"), 0);
  if (!(await until(async () => existsSync(join(dir, EXITED_FILE))))) {
    errors.push(new Error(survivor(pid)));
    return errors;
  }
  if (pid === null) {
    errors.push(
      new Error(
        `the shim in ${dir} wrote its exit marker, but its pid record is missing or unreadable, so its exit is unconfirmed`,
      ),
    );
    return errors;
  }
  if (!(await until(async () => !processExists(pid)))) {
    errors.push(new Error(survivor(pid)));
  }
  return errors;
}

// Runs `body(markGone)` and then the cleanup of its shim. The directory is removed
// whatever the shim stop does. Every failure reaches the caller: the body error, the
// shim stop errors, and the removal error. One error is rethrown as is, several as
// an AggregateError, so a failed body never hides a surviving shim.
async function runWithShimCleanup(dir, ceilingMs, body) {
  const errors = [];
  let gone = false;
  let result;
  try {
    result = await body(() => {
      gone = true;
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    errors.push(...(await stopShim(dir, gone, ceilingMs)));
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await removePath(dir);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    return result;
  }
  throw errors.length === 1 ? errors[0] : new AggregateError(errors, "the shim helper failed");
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
 * result. `options.ceilingMs` shortens the shim's wall-clock ceiling for a test of the
 * ceiling check itself.
 */
export async function expectBoundKillsShim(command, run, boundMs = BOUND_MS, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `hang-${command}-`));
  const ceilingMs =
    options.ceilingMs ??
    boundMs + CALL_CEILING_MS + RECORD_VISIBLE_MS + FORCE_KILL_AFTER_DELAY_MS + TEARDOWN_MARGIN_MS;
  return runWithShimCleanup(dir, ceilingMs, async (markGone) => {
    const shim = await writeHangingShim(dir, command, ceilingMs);
    return withShimOnPath(dir, async () => {
      const result = await returnsWithin(
        run(boundMs),
        boundMs + CALL_CEILING_MS,
        "the call did not return after its bound",
      );
      // The record was written before the bound expired, so a short wait only
      // covers file visibility.
      const pid = await waitForPid(shim.started, RECORD_VISIBLE_MS);
      assert.notEqual(pid, null, `the shim did not start within the ${boundMs} ms bound`);
      await assertGone(pid, FORCE_KILL_AFTER_DELAY_MS, dir);
      markGone();
      return result;
    });
  });
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
  const ceilingMs =
    START_WAIT_MS + CALL_CEILING_MS + ABORT_FORCE_KILL_AFTER_DELAY_MS + TEARDOWN_MARGIN_MS;
  return runWithShimCleanup(dir, ceilingMs, async (markGone) => {
    const shim = await writeHangingShim(dir, command, ceilingMs);
    return withShimOnPath(dir, async () => {
      const controller = new AbortController();
      const pending = start(controller.signal);
      const pid = await waitForPid(shim.started, START_WAIT_MS);
      assert.notEqual(pid, null, "the shim never started");
      controller.abort();
      const result = await returnsWithin(
        pending,
        CALL_CEILING_MS,
        "the call did not return after the abort",
      );
      await assertGone(pid, ABORT_FORCE_KILL_AFTER_DELAY_MS, dir);
      markGone();
      return result;
    });
  });
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

/**
 * Rejects when `promise` has not settled within `ms`, so a hung process fails its test with
 * `label` instead of holding the suite until the test timeout.
 */
export async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Calls `probe` until it returns a value other than `undefined`. Rejects at one absolute deadline
 * of `ms` on a monotonic clock. Each probe races the time that remains, so a probe that never
 * settles cannot hold the wait past the deadline, and slow I/O or timer delay cannot stretch it.
 * A result counts only when the probe settled at or before the deadline: a result that arrives
 * later, even before the timer callback runs, is rejected, and a late settle is ignored.
 * @returns {Promise<unknown>} the first value that is not `undefined`
 */
export async function pollUntil(probe, ms) {
  const deadline = performance.now() + ms;
  const expired = Symbol("expired");
  for (;;) {
    const pending = Promise.resolve()
      .then(probe)
      .then((value) => ({ value, at: performance.now() }));
    // A late failure of an abandoned probe must not become an unhandled rejection.
    pending.catch(() => {});
    let timer;
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - performance.now()), expired);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === expired || result.at > deadline) {
      throw new Error(`The condition was not met within ${ms} ms.`);
    }
    if (result.value !== undefined) {
      return result.value;
    }
    if (performance.now() >= deadline) {
      throw new Error(`The condition was not met within ${ms} ms.`);
    }
    await delay(Math.min(25, Math.max(0, deadline - performance.now())));
  }
}

/**
 * Creates a POSIX `ps` shell script from `body` in a new directory under the system temporary
 * directory. The directory name holds a space, so an unquoted path fails. In the body:
 *
 * - `__DIR__` stands for the shell-quoted directory.
 * - `__STALL__` runs a loop that stalls the read. Every 0.2 s it writes a counter to the heartbeat
 *   file through a temporary file and a rename, so a reader sees a whole record or none. It checks
 *   real elapsed time (`date +%s`) and leaves the loop at the ceiling, whatever signal the body
 *   ignores, then writes the `done` marker. The ceiling is `ceilingSeconds` (default 10). Whole
 *   seconds of `date` and the 0.2 s sleep make the real ceiling at most `ceilingSeconds + 1` s
 *   plus 0.2 s.
 *
 * The test never signals the shim. The code under test (the `exec` timeout or cancel) must end it,
 * and the test observes that:
 *
 * - `ready()` resolves when the heartbeat holds a whole counter and a newline, and rejects at its
 *   deadline.
 * - `heartbeatStopped()` is true when the heartbeat stops changing over 1 s and the `done` marker
 *   is absent. This is secondary evidence only: a paused live shim, or a shim that exited for an
 *   unrelated reason, gives the same answer. A test must first assert the production result (the
 *   read rejected with the expected reason inside the expected bound). Each file read is bounded
 *   by `ms` (default 5 s).
 * - `cleanup()` removes the directory. It signals no process, so a shim that a failed test left
 *   running ends at its ceiling.
 */
export async function createPsShim(body, { ceilingSeconds = 10 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ps shim-"));
  const quoted = shellQuote(dir);
  const stall = [
    "__start=$(date +%s)",
    "__n=0",
    `while [ $(( $(date +%s) - __start )) -lt ${ceilingSeconds} ]; do`,
    "  __n=$((__n + 1))",
    `  echo $__n > ${quoted}/beat.tmp && mv ${quoted}/beat.tmp ${quoted}/beat`,
    "  sleep 0.2",
    "done",
    `echo done > ${quoted}/done`,
  ].join("\n");
  // Replacer functions: a replacement string would read `$` sequences.
  const expanded = body.replaceAll("__STALL__", () => stall).replaceAll("__DIR__", () => quoted);
  await writeFile(join(dir, "ps"), `#!/bin/sh\n${expanded}\n`, { mode: 0o755 });
  const readBeat = async () => {
    const text = await readFile(join(dir, "beat"), "utf8").catch(() => "");
    return /^\d+\n$/.test(text) ? Number(text) : undefined;
  };
  return {
    dir,
    ready: (ms = 15_000) => pollUntil(readBeat, ms),
    async heartbeatStopped(ms = 5000) {
      const before = await within(readBeat(), ms, "The first heartbeat read");
      await delay(1000);
      const done = await within(
        readFile(join(dir, "done"), "utf8").then(
          () => true,
          () => false,
        ),
        ms,
        "The done marker read",
      );
      return (
        before !== undefined &&
        before === (await within(readBeat(), ms, "The second heartbeat read")) &&
        !done
      );
    },
    cleanup: () => removePath(dir),
  };
}
