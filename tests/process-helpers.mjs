import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { REMOVE_MAX_WAIT_MS, REMOVE_SYSCALL_SLACK_MS, removePath } from "./fs-helpers.mjs";
import { pollUntil, within } from "./wait-helpers.mjs";

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
 * `started` with its own wall-clock start time (epoch ms), as `<pid> <start>`. It stays alive only while the `keep` or the `hold` file exists, so it
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
fs.writeFileSync(${JSON.stringify(started)}, process.pid + " " + Date.now());
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

// Returns the record the shim wrote, `{ pid, startMs }`, or null if no whole record
// appears within `waitMs`. `startMs` is the shim's own wall-clock start (epoch ms).
async function waitForRecord(started, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const match = /^(\d+) (\d+)$/.exec(await readFile(started, "utf8").catch(() => ""));
    if (match) {
      return { pid: Number(match[1]), startMs: Number(match[2]) };
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
// practical risk. Exported for tests that poll a pid.
export function processExists(pid) {
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
//
// A kill is proven only when the exit was first observed before the shim's start
// plus its ceiling (both wall clock). An exit observed at or after that deadline
// may be the shim ending itself at its ceiling or hard deadline, with a marker
// that was never written or never read, so it fails whatever the markers say. This
// rule needs no write at exit time. The ceiling marker is an extra signal.
async function assertGone({ pid, startMs }, forceKillAfterDelayMs, dir, ceilingMs) {
  const deadline = Date.now() + forceKillAfterDelayMs + TEARDOWN_MARGIN_MS;
  let alive = processExists(pid);
  let observedAt = Date.now();
  while (alive && Date.now() < deadline) {
    await delay(50);
    alive = processExists(pid);
    observedAt = Date.now();
  }
  assert.ok(
    !alive,
    `the shim child ${pid} outlived the ${forceKillAfterDelayMs} ms force-kill boundary`,
  );
  assert.ok(
    !statSync(join(dir, CEILING_FILE), { throwIfNoEntry: false })?.isFile(),
    `the shim child ${pid} exited on its wall-clock ceiling, so the code under test did not kill it`,
  );
  assert.ok(
    observedAt < startMs + ceilingMs,
    `the shim child ${pid} exit was first observed ${observedAt - startMs} ms after its start, not before its ${ceilingMs} ms ceiling, so the test cannot prove a runtime kill`,
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
  const pid = (await waitForRecord(join(dir, "started.txt"), 0))?.pid ?? null;
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
      const record = await waitForRecord(shim.started, RECORD_VISIBLE_MS);
      assert.notEqual(record, null, `the shim did not start within the ${boundMs} ms bound`);
      await assertGone(record, FORCE_KILL_AFTER_DELAY_MS, dir, ceilingMs);
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
      const record = await waitForRecord(shim.started, START_WAIT_MS);
      assert.notEqual(record, null, "the shim never started");
      controller.abort();
      const result = await returnsWithin(
        pending,
        CALL_CEILING_MS,
        "the call did not return after the abort",
      );
      await assertGone(record, ABORT_FORCE_KILL_AFTER_DELAY_MS, dir, ceilingMs);
      markGone();
      return result;
    });
  });
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Creates a POSIX `ps` shell script from `body` in a new directory under the system temporary
 * directory. The directory name holds a space, so an unquoted path fails. In the body:
 *
 * - `__DIR__` stands for the shell-quoted directory.
 * - `__STALL__` runs a loop that stalls the read. Every 0.2 s it writes a counter to the heartbeat
 *   file through a temporary file and a rename, so a reader sees a whole record or none. It checks
 *   real elapsed time (`date +%s`) and leaves the loop at the ceiling, whatever signal the body
 *   ignores, then writes the `done` marker. The ceiling is `ceilingSeconds` (default 10). The loop
 *   writes a heartbeat before each ceiling check, so one heartbeat exists at any ceiling, even when
 *   the start read and the check read straddle a second boundary. Whole seconds of `date` and the
 *   0.2 s sleep make the real ceiling at most `ceilingSeconds + 1` s plus 0.2 s.
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
    "while :; do",
    "  __n=$((__n + 1))",
    `  echo $__n > ${quoted}/beat.tmp && mv ${quoted}/beat.tmp ${quoted}/beat`,
    `  [ $(( $(date +%s) - __start )) -lt ${ceilingSeconds} ] || break`,
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

/**
 * POSIX only. Ends `pid` with SIGKILL only when its command line holds `marker`, a value that no
 * other process carries, so a stale or reused pid is never signaled. Returns true when it sent the
 * signal. The `ps` read ends after `timeoutMs` (default 3 s), and a read that ends that way signals
 * nothing.
 */
export async function endOwnedProcess(pid, marker, { timeoutMs = 3000 } = {}) {
  // Loaded on use, so a test file that mocks `execa` or `exec.mjs` sees its mock first.
  const { execBounded } = await import("../src/lib/exec.mjs");
  const read = await execBounded("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs });
  if (read.timedOut || !(read.stdout ?? "").includes(marker)) {
    return false;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the records that the `withGitHangingAfter` shim wrote into `shimDir`, one `{ number, pid }`
 * per `call-<n>/record` file that holds a whole record. A call that left no record, or a half
 * written one, is absent. Rejects when `shimDir` cannot be read.
 */
export async function shimCallRecords(shimDir) {
  const names = (await readdir(shimDir)).filter((name) => name.startsWith("call-"));
  const found = await Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(shimDir, name, "record"), "utf8").catch(() => "");
      const match = /^(\d+) (\d+)\n$/.exec(text);
      return match ? { number: Number(match[1]), pid: Number(match[2]) } : undefined;
    }),
  );
  return found.filter((record) => record !== undefined);
}

/**
 * Reads the pids in `shimDir/started`, one `<pid>` entry for each marker that the
 * `withGitHangingAfter` shim wrote. A missing entry does not show that a call skipped the shim.
 * Rejects when the directory cannot be read.
 */
export async function shimStartPids(shimDir) {
  return (await readdir(join(shimDir, "started"))).filter((name) => /^\d+$/.test(name)).map(Number);
}

/**
 * Puts a `git` on PATH that runs the real `git` for its first `passes` calls, also when calls start
 * at once, and then hangs. A test can let the before snapshot finish and stall the read that
 * follows. `run` gets `hungPid()` and `shimDir`. `hungPid()` resolves with the pid of the hung `git`
 * once it started.
 *
 * `shimDir` holds one `call-<n>` directory per call, each with a `record` file of the claimed
 * number and the pid (read it with `shimCallRecords`). The shim also writes
 * `started/<pid>` before its claim, which `shimStartPids` reads. The hung process carries the unique
 * shim directory in its command line. The helper ends it through `endOwnedProcess` if the test left
 * it alive, and removes the shim directory.
 *
 * On POSIX the shell shim `exec`s the hung node process, so one pid carries the call. On Windows a
 * `git.cmd` wrapper starts the hung node process, and the record names that node pid. The runtime
 * kills the process tree, so the wrapper ends with it. On Windows the helper ends no process, since
 * no cheap marker read exists there, and a leftover shim ends at its own ceiling.
 */
export async function withGitHangingAfter(passes, run) {
  const realGit =
    process.platform === "win32"
      ? (await execa("where", ["git"])).stdout.split(/\r?\n/).find((line) => line.trim() !== "")
      : (await execa("sh", ["-c", "command -v git"])).stdout.trim();
  const dir = await mkdtemp(join(tmpdir(), "git-hang-after-"));
  const pidFile = join(dir, "hung.pid");
  await mkdir(join(dir, "started"));
  if (process.platform === "win32") {
    await writeWindowsGitShim(dir, { passes, realGit, pidFile });
  } else {
    await writeFile(
      join(dir, "git"),
      [
        "#!/bin/sh",
        // The marker records the pid of a call that ran the shim. A failed `mkdir` never ends the
        // shell, so the claim below always runs.
        `mkdir '${dir}/started/'$$ 2>/dev/null`,
        // Calls can start at once, as the reads of one snapshot do. `mkdir` is atomic, so each call
        // claims the first free number. A counter file loses updates and can be read half written.
        "n=0",
        `while ! mkdir '${dir}/call-'$n 2>/dev/null; do n=$((n + 1)); done`,
        // The record holds the claimed number and the pid, which `exec` keeps.
        `echo "$n $$" > '${dir}/call-'$n/record`,
        `if [ "$n" -lt ${passes} ]; then exec '${realGit}' "$@"; fi`,
        `echo $$ > '${pidFile}'`,
        `exec '${process.execPath}' -e 'setTimeout(() => {}, 30000)' '${dir}'`,
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const hungPid = () =>
    pollUntil(async () => {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      return /^\d+\n$/.test(text) ? Number(text) : undefined;
    }, 20_000);
  try {
    return await withShimOnPath(dir, () => run({ hungPid, shimDir: dir }));
  } finally {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    if (/^\d+\n$/.test(text) && process.platform !== "win32") {
      await endOwnedProcess(Number(text), dir);
    }
    await removePath(dir);
  }
}

// Writes the Windows shim: a `git.cmd` wrapper and the node script that records the call and hangs.
async function writeWindowsGitShim(dir, { passes, realGit, pidFile }) {
  const script = join(dir, "git-shim.cjs");
  await writeFile(
    script,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const { spawnSync } = require("node:child_process");',
      "const [dir, passes, realGit, ...args] = process.argv.slice(2);",
      'try { fs.mkdirSync(path.join(dir, "started", String(process.pid))); } catch {}',
      "let n = 0;",
      "for (;;) {",
      '  try { fs.mkdirSync(path.join(dir, "call-" + n)); break; }',
      '  catch (err) { if (err.code !== "EEXIST") throw err; n += 1; }',
      "}",
      'fs.writeFileSync(path.join(dir, "call-" + n, "record"), `${n} ${process.pid}\\n`);',
      "if (n < Number(passes)) {",
      '  const run = spawnSync(realGit, args, { stdio: "inherit" });',
      "  process.exit(run.status ?? 1);",
      "}",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, \`\${process.pid}\\n\`);`,
      "setTimeout(() => {}, 30000);",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "git.cmd"),
    `@echo off\r\n"${process.execPath}" "${script}" "${dir}" ${passes} "${realGit}" %*\r\n`,
  );
}
