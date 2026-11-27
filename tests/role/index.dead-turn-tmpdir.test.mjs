import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the cases that open a clean directory: they assert turn-directory
// state, never a Git result. The killed-dispatch cases keep a real repository for their child
// process. Every other command reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { ownerAlive, processStartTime } from "../../src/lib/process-identity.mjs";
import { readProcessCommands, readProcessTable } from "../../src/lib/process-ancestry.mjs";
import { statePaths } from "../../src/lib/runstate.mjs";
import { lockHeld, readLockOwner } from "../../src/lib/state-lock.mjs";
import { withTurnTmpdir } from "../../src/lib/turn-tmpdir.mjs";
import { executeRoleCommand } from "../../src/role/index.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  initRun,
  newCleanRunRepo,
  newRunRepo as newRealRunRepo,
  readRepoState,
  REPORT,
  stdinPrompt,
  withRepo,
} from "./helpers.mjs";
import { removePath } from "../fs-helpers.mjs";
import { deadPid, processExists } from "../process-helpers.mjs";
import { within } from "../wait-helpers.mjs";

const newRunRepo = () => newCleanRunRepo(gitDouble);

// Passes every state write through, except the ones that a test arms to fail after the record write
// of a turn directory. `failures` is how many of the next writes throw, `Infinity` for every one.
const stateWrites = vi.hoisted(() => ({ failures: 0 }));
vi.mock("../../src/lib/atomic-write.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeFileAtomic: async (...args) => {
      if (stateWrites.failures > 0) {
        stateWrites.failures -= 1;
        throw new Error("EIO: injected state write failure");
      }
      return real.writeFileAtomic(...args);
    },
  };
});

const ROLE = fileURLToPath(new URL("../../src/role/index.mjs", import.meta.url));
const scratches = [];
// Every spawned dispatch, so teardown ends it on every path, a startup timeout included.
const dispatches = [];
// A live child that a case records as the child of a dead turn, so teardown ends it too.
const children = [];
// The fake `codex` pid and start time of each `killedDispatch` scratch, so teardown can narrow
// pid reuse. An unread identity falls back to main's pid-only cleanup.
const fakeStarts = new Map();

/** Starts a live node process, to stand as the child of a dead turn. */
function liveChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

/** Ends a recorded live child and waits for the process to go. */
async function endChild(child) {
  child.kill("SIGKILL");
  await vi.waitFor(() => expect(processExists(child.pid)).toBe(false), { timeout: 5000 });
}

// The pid that the fake `codex` of `scratch` wrote as its first action, or null when it never ran.
async function fakePid(scratch) {
  const pid = Number(await readFile(join(scratch, "pid.txt"), "utf8").catch(() => ""));
  return pid > 0 ? pid : null;
}

// Ends a dispatcher and every process below it, with no window between a spawn and its end. On
// POSIX the dispatcher is stopped first, so it spawns nothing more, then every descendant that the
// process table shows is ended, then the dispatcher. A process group would miss a child that
// starts its own group. On Windows `taskkill /T` walks the tree.
async function endTree(child) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      return;
    }
    process.kill(child.pid, "SIGSTOP");
    const table = await readProcessTable();
    const below = new Set([child.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const { pid, ppid } of table) {
        if (below.has(ppid) && !below.has(pid)) {
          below.add(pid);
          grew = true;
        }
      }
    }
    for (const pid of below) process.kill(pid, "SIGKILL");
  } catch {
    // The tree is already gone, or the table is unreadable and the pid fallback decides.
    if (process.platform !== "win32") child.kill("SIGKILL");
  }
}

// Ends every spawned dispatcher and every fake `codex`, on every path of a test, a startup timeout
// included: the tree of a live dispatcher first, then each fake by main's pid-only cleanup. When a
// start time was recorded, the signal waits for that identity; an unread identity falls back to
// the pid-only cleanup.
async function endSpawned() {
  for (const child of dispatches.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await endTree(child);
      await exited;
    }
  }
  for (const dir of scratches) {
    const fake = fakeStarts.get(dir);
    fakeStarts.delete(dir);
    if (fake === undefined) {
      // Main's cleanup for a fake whose pid was written but whose identity was never recorded.
      const pid = await fakePid(dir);
      if (pid !== null && processExists(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The fake ended between the check and the signal.
        }
      }
      continue;
    }
    const signal = fake.startTime === undefined ? processExists(fake.pid) : await ownerAlive(fake);
    if (signal) {
      try {
        process.kill(fake.pid, "SIGKILL");
      } catch {
        // The fake ended between the check and the signal.
      }
    }
  }
  for (const child of children.splice(0)) {
    if (processExists(child.pid)) child.kill("SIGKILL");
  }
}

afterEach(async () => {
  gitDouble.answer = null;
  stateWrites.failures = 0;
  vi.unstubAllEnvs();
  await endSpawned();
  await cleanup();
  for (const dir of scratches.splice(0)) await removePath(dir);
});

// A fake `codex` that waits `FAKE_CODEX_START_DELAY_MS` before its first statement, writes its pid in
// a path that the test owns, reports its temporary directory after `FAKE_CODEX_DELAY_MS`, leaves a
// file in that directory, and hangs, so a test can kill the dispatch that owns it mid-turn.
const FAKE_CODEX = `
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CODEX_START_DELAY_MS));
const fs = require("fs");
const dir = process.env.TMPDIR;
fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
setTimeout(() => {
  fs.writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ pid: process.pid, dir }));
  fs.writeFileSync(dir + "/leftover.txt", "x");
}, Number(process.env.FAKE_CODEX_DELAY_MS));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 60000);
`;

// The killed-turn wait keeps main's 5 s bound and 50 ms poll. The state read after the kill is a
// read only, so it has its own bound; the recovery call is awaited to completion, so no work of it
// survives teardown.
const DEAD_TURN_WAIT_MS = 5000;
const DEAD_TURN_POLL_MS = 50;
const STATE_READ_BOUND_MS = 5000;
// The case's own timeout and the margin kept to report a budget failure before it.
const CASE_TIMEOUT_MS = 60_000;
const CASE_MARGIN_MS = 2000;
const STATE_READ_RESERVE_MS = 1000;

/** Races one liveness read against the time left in the wait, without a loose rejection. */
function readLiveness(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    ),
    new Promise((resolve) => {
      const bound = Math.max(0, ms);
      timer = setTimeout(
        () => resolve({ error: `${label} did not finish within ${Math.round(bound)} ms` }),
        bound,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The liveness of the killed turn: `lockHeld` for the state lock, and `ownerAlive` with the
 * recorded start time for each child. The reads carry no cache, so each poll applies the same
 * fresh read that lock acquisition uses. Each read is bounded by `boundMs`.
 */
async function readTurnLiveness({ lockFile, lockPid, child, fake }, boundMs) {
  const [lock, childAlive, fakeAlive] = await Promise.all([
    readLiveness(lockHeld(lockFile), boundMs, `the state lock read for pid ${lockPid ?? "none"}`),
    readLiveness(ownerAlive(child), boundMs, `the child liveness read for pid ${child.pid}`),
    readLiveness(ownerAlive(fake), boundMs, `the fake codex liveness read for pid ${fake.pid}`),
  ]);
  return { lock, child: childAlive, fake: fakeAlive };
}

// The pids, recorded start times, liveness reads, and elapsed time of a killed-turn failure.
function describeTurn(
  { turnDir, lockPid, lockStartTime, child, fake, identityMs },
  reads,
  dispatcherExited,
  elapsedMs,
) {
  const status = (read) =>
    read === undefined
      ? "not read"
      : read.error !== undefined
        ? `not read (${read.error})`
        : read.value
          ? "alive"
          : "gone";
  const identityRead = identityMs === undefined ? "not recorded" : `${Math.round(identityMs)} ms`;
  return (
    `the turn directory is ${existsSync(turnDir) ? "present" : "absent"} ${Math.round(elapsedMs)} ms after the kill; ` +
    `at the wait, state lock owner pid ${lockPid ?? "none"} (start time ${lockStartTime ?? "unknown"}) ${status(reads?.lock)}; ` +
    `child pid ${child.pid} (start time ${child.startTime ?? "unknown"}) ${status(reads?.child)}; ` +
    `fake codex pid ${fake.pid} (start time ${fake.startTime ?? "unknown"}, identity read ${identityRead}) ${status(reads?.fake)}; ` +
    `dispatcher ${dispatcherExited ? "exited" : "not exited"}`
  );
}

/**
 * Waits, with one bound, until the killed turn reads gone by the rule the next call uses. It starts
 * no read at or after the deadline. `reads`, `now`, and `sleep` are injectable so a test drives
 * the wait itself. Resolves with the last reads; rejects with the pids, the reads, and the elapsed
 * time.
 */
async function waitForKilledTurn(
  turn,
  {
    dispatcherExited,
    waitForFake = true,
    boundMs = DEAD_TURN_WAIT_MS,
    budgetMs = boundMs,
    pollMs = DEAD_TURN_POLL_MS,
    reads = readTurnLiveness,
    now = () => performance.now(),
    sleep = delay,
  } = {},
) {
  const effectiveBoundMs = Math.min(boundMs, budgetMs);
  const startedAt = now();
  const deadline = startedAt + effectiveBoundMs;
  const elapsed = () => now() - startedAt;
  let last;
  for (;;) {
    if (now() >= deadline) {
      throw new Error(
        `${describeTurn(turn, last, dispatcherExited(), elapsed())}; the wait reached its ${effectiveBoundMs} ms bound before the turn was gone`,
      );
    }
    last = await reads(turn, deadline - now());
    const finishedAt = now();
    const gone =
      dispatcherExited() &&
      last.lock.value === false &&
      last.child.value === false &&
      (!waitForFake || last.fake.value === false);
    if (gone) {
      if (finishedAt <= deadline) {
        return last;
      }
      throw new Error(
        `${describeTurn(turn, last, dispatcherExited(), elapsed())}; the wait passed after its ${effectiveBoundMs} ms bound`,
      );
    }
    if (finishedAt >= deadline) {
      throw new Error(
        `${describeTurn(turn, last, dispatcherExited(), elapsed())}; the killed turn still reads as live`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/**
 * Starts a real `role dispatch` whose Codex turn hangs and kills the dispatch with SIGKILL mid-turn,
 * once the state file holds the child of the turn. The orphaned fake `codex` is ended unless
 * `keepChild` is set, and teardown ends it either way. Waits, with a bound, until the killed
 * dispatch and its recorded child no longer read as live by the rule that the state lock and the
 * turn removal use, because the next call reads both as a lock owner and as a child of the dead
 * turn. Returns the work tree, the temporary directory of the turn (as the turn child saw it), the
 * temporary root that holds it, the pid of the fake `codex`, the time of the kill, and a function
 * that reports the pids, liveness reads, and elapsed time of a later failure.
 */
async function killedDispatch({
  keepChild = false,
  startupMs = 30_000,
  reportDelayMs = 0,
  startDelayMs = 0,
  deadline = Infinity,
} = {}) {
  const repo = await newRealRunRepo();
  const { lockFile } = statePaths({ cwd: repo });
  const scratch = await mkdtemp(join(tmpdir(), "dead-turn-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  const tmpRoot = join(scratch, "tmp");
  mkdirSync(bin);
  mkdirSync(tmpRoot);
  const script = join(bin, "fake-codex.cjs");
  const report = join(scratch, "report.json");
  const promptFile = join(scratch, "prompt.txt");
  await writeFile(script, FAKE_CODEX, "utf8");
  await writeFile(promptFile, "work it", "utf8");
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), `@echo off\r\nnode "${script}"\r\n`);
  } else {
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec node '${script}'\n`, { mode: 0o755 });
  }
  const runner = [
    `import { main } from ${JSON.stringify(pathToFileURL(ROLE).href)};`,
    "await main(process.argv.slice(1));",
  ].join("\n");
  // Process: each dispatch runs as its own CLI, so a crash mid-turn leaves the directory behind.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      runner,
      "--",
      "dispatch",
      "--role",
      "worker",
      "--cwd",
      repo,
      "--parent-session",
      "dead-turn-session",
      "--task",
      "Fix the flaky test.",
      "--worker",
      "codex",
      "--reviewer",
      "codex",
      "--prompt-file",
      promptFile,
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        TMPDIR: tmpRoot,
        TEMP: tmpRoot,
        TMP: tmpRoot,
        FAKE_CODEX_REPORT: report,
        FAKE_CODEX_PID: join(scratch, "pid.txt"),
        FAKE_CODEX_DELAY_MS: String(reportDelayMs),
        FAKE_CODEX_START_DELAY_MS: String(startDelayMs),
      },
    },
  );
  dispatches.push(child);
  let dispatcherExited = false;
  child.once("exit", () => {
    dispatcherExited = true;
  });
  let turn;
  let recordedChild;
  await vi.waitFor(
    async () => {
      turn = JSON.parse(await readFile(report, "utf8").catch(() => "null"));
      expect(turn?.pid).toBeGreaterThan(0);
      // The dispatch has recorded the child, so the kill leaves the record a recovery reads.
      const state = await readRepoState(repo).catch(() => null);
      recordedChild = state?.lastDispatch?.turnTmpdir?.child;
      expect(recordedChild?.pid).toBeGreaterThan(0);
    },
    { timeout: startupMs, interval: 100 },
  );
  // The lock owner is the dispatcher, and the fake codex is the child of the turn. Both start
  // times are read before the kill, so the wait can apply the same rule as the state lock.
  const lockOwner = await readLockOwner(lockFile);
  // The identity query runs before the kill, so it cannot extend the post-kill wait. Its elapsed
  // time is part of every later failure report.
  const identityStartedAt = performance.now();
  const fakeStartTime = (await processStartTime(turn.pid)) ?? undefined;
  const identityMs = performance.now() - identityStartedAt;
  const fake = { pid: turn.pid, startTime: fakeStartTime };
  fakeStarts.set(scratch, fake);
  const killedAt = Date.now();
  child.kill("SIGKILL");
  // Main's cleanup: signal the fake by pid when the dispatcher is killed, whether or not its
  // recorded identity was read. The recorded start time narrows the teardown signal; an unread
  // identity falls back to this pid-only cleanup.
  if (!keepChild && processExists(turn.pid)) {
    try {
      process.kill(turn.pid, "SIGKILL");
    } catch {
      // The child ended between the check and the signal; the wait below confirms it.
    }
  }
  // Windows keeps a killed process in the process table while a handle to it is open. The next call
  // reads the dispatcher pid as the state-lock owner and the recorded child as the child of the dead
  // turn, so either one that still looks live refuses the lock or keeps the turn directory. The
  // wait uses the state lock's rule (`lockHeld`) and the turn removal's rule (`ownerAlive`) with a
  // fresh read for every poll, and starts no read at or after its bound. The dispatcher exit waits
  // in the same bound, so a late exit event cannot hold the case past it.
  const turnLiveness = {
    turnDir: turn.dir,
    lockFile,
    lockPid: lockOwner?.pid,
    lockStartTime: lockOwner?.startTime,
    child: { pid: recordedChild.pid, startTime: recordedChild.startTime },
    fake,
    identityMs,
  };
  const reads = await waitForKilledTurn(turnLiveness, {
    dispatcherExited: () => dispatcherExited,
    waitForFake: !keepChild,
    budgetMs: Math.max(0, deadline - Date.now()),
  });
  return {
    repo,
    turnDir: turn.dir,
    tmpRoot,
    childPid: turn.pid,
    killedAt,
    diagnose: () => describeTurn(turnLiveness, reads, dispatcherExited, Date.now() - killedAt),
    recoveryBudgetMs: () => Math.max(0, deadline - Date.now()),
  };
}

// The recovery call inherits the temporary directory that held the turn directory, as a call of the
// same host does. A record of another parent is refused (issue #1216).
const nextCall = (repo, tmpRoot) => {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tmpRoot);
  return executeRoleCommand(withRepo(dispatchArgv(), repo), { ...basicDeps(), stdin: stdinPrompt });
};

// Runs the recovery as the real CLI in its own process, so the test can end it at the budget and
// await its exit before teardown. The child writes state, so no test-side timeout leaves it running.
// Process: the case already runs one real dispatch; this is the second entry point, and it lets the
// test meet the budget without a late state write.
async function recoveryCall(repo, tmpRoot, budgetMs, { spawnChild = spawn } = {}) {
  const runner = [
    `import { main } from ${JSON.stringify(pathToFileURL(ROLE).href)};`,
    "await main(process.argv.slice(1));",
  ].join("\n");
  const args = dispatchArgv().map((value) => (value === "<repo>" ? repo : value));
  let child;
  try {
    child = spawnChild(process.execPath, ["--input-type=module", "-e", runner, "--", ...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot },
    });
  } catch (error) {
    throw new Error(
      `the recovery call could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let stdout = "";
  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on?.("data", (chunk) => {
    stdout += chunk;
  });
  // A failed launch emits `error` and may never emit `close`, so both settle the helper.
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  child.once("close", (code, signal) => settle({ code, signal }));
  child.once("error", (error) => settle({ error }));
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });
  try {
    const result = await Promise.race([done, expired]);
    if (result.timedOut) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The launch already failed; no process runs.
      }
      await done;
      return { timedOut: true, code: null, stdout };
    }
    if (result.error !== undefined) {
      throw new Error(
        `the recovery call could not start: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
      );
    }
    return { timedOut: false, code: result.code, signal: result.signal, stdout };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The launch already failed; no process runs.
      }
      await done;
    }
  }
}

// Runs another role operation on the run in `repo`, under the temporary root of its killed
// dispatch, so a re-check of the kept turn directory meets the record origin check.
const laterCall = (repo, tmpRoot, argv) => {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tmpRoot);
  return executeRoleCommand(withRepo(argv, repo), { ...basicDeps(), stdin: stdinPrompt });
};

// Turns the run in `repo` into an interrupted run that kept a turn directory whose recorded child
// is dead. Returns the directory and the temporary root that holds it.
async function interruptedWithKeptDir(repo, { child } = {}) {
  const made = await keptTurnDir();
  const state = await readRepoState(repo);
  state.lifecycle = "interrupted";
  // A dispatch that dies mid-turn records no turn of its own.
  state.turns = [];
  state.lastDispatch = {
    role: "worker",
    at: new Date().toISOString(),
    turnTmpdir: { ...made.record, child: child ? { pid: child.pid } : { pid: await deadPid() } },
  };
  await writeFile(
    statePaths({ cwd: repo }).stateFile,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { dir: made.dir, tmpRoot: made.tmpRoot };
}

// Turns the run in `repo` into the state that a dispatch process leaves when it dies mid-turn: the
// durable `dispatched` lifecycle and the record of the turn directory, with a dead child.
async function dispatchedWithKeptDir(repo, { child } = {}) {
  const made = await keptTurnDir();
  const state = await readRepoState(repo);
  state.lifecycle = "dispatched";
  // A dispatch that dies mid-turn records no turn of its own.
  state.turns = [];
  state.lastDispatch = {
    role: "worker",
    at: new Date().toISOString(),
    turnTmpdir: { ...made.record, child: child ? { pid: child.pid } : { pid: await deadPid() } },
  };
  await writeFile(
    statePaths({ cwd: repo }).stateFile,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { dir: made.dir, tmpRoot: made.tmpRoot };
}

/** Makes a turn directory in a fresh temporary root, with the record that a killed turn leaves. */
async function keptTurnDir() {
  const tmpRoot = await mkdtemp(join(tmpdir(), "kept-turn-"));
  scratches.push(tmpRoot);
  const dir = await mkdtemp(join(tmpRoot, "al-"));
  writeFileSync(join(dir, "leftover.txt"), "x\n");
  const stat = lstatSync(dir, { bigint: true });
  return {
    dir,
    tmpRoot,
    record: {
      dir,
      parentReal: dirname(realpathSync.native(dir)),
      device: String(stat.dev),
      inode: String(stat.ino),
    },
  };
}

// Usefulness: verifies issue #1207 acceptance 1, that the call which marks a run `interrupted`
// after its dispatch process died mid-turn removes the directory of that turn.
// Process: this is the one real crash that proves a killed dispatch leaves its turn directory and
// state record for the next call. Every other case writes that state in process.
test(
  "the call that marks a killed dispatch interrupted removes its turn directory",
  async () => {
    const caseStartedAt = Date.now();
    const { repo, turnDir, tmpRoot, diagnose, recoveryBudgetMs } = await killedDispatch({
      deadline: caseStartedAt + CASE_TIMEOUT_MS - CASE_MARGIN_MS,
    });
    // Every failure past the kill reports the pids, the liveness reads, and the time from the kill
    // to the check (issue #2042).
    const check = () => diagnose();
    const withCheck = (error) => {
      const detail = check();
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error) {
        if (!message.includes(detail)) error.message = `${detail}; ${message}`;
        return error;
      }
      return new Error(`${detail}; ${message}`);
    };
    try {
      expect(existsSync(turnDir), check()).toBe(true);

      // The identity read time is already spent from this budget. The recovery gets what remains,
      // less a reserve for the state read, and it runs in a process the test ends and awaits.
      const recoveryBudget = recoveryBudgetMs() - STATE_READ_RESERVE_MS;
      if (recoveryBudget <= 0) {
        throw new Error("the recovery budget is exhausted");
      }
      const recovered = await recoveryCall(repo, tmpRoot, recoveryBudget);
      if (recovered.timedOut) {
        throw new Error(`the recovery call did not finish within ${recoveryBudget} ms`);
      }
      const next = {
        exitCode: recovered.code,
        payload: JSON.parse(recovered.stdout.trim().split("\n").at(-1)),
      };
      const stateRead = readRepoState(repo);
      stateRead.catch(() => {});
      const readBudget = Math.min(STATE_READ_BOUND_MS, recoveryBudgetMs());
      if (readBudget <= 0) {
        throw new Error("the state-read budget is exhausted");
      }
      const state = await within(stateRead, readBudget, "the state read");

      expect(next.exitCode, check()).toBe(1);
      expect(next.payload.error, check()).toContain("interrupted");
      expect(state.lifecycle, check()).toBe("interrupted");
      expect(existsSync(turnDir), check()).toBe(false);
      expect(readdirSync(tmpRoot), check()).toEqual([]);
    } catch (error) {
      throw withCheck(error);
    }
  },
  CASE_TIMEOUT_MS,
);

// The wait cases below drive `waitForKilledTurn`, the function the killed-dispatch case runs, with
// an injected read source and clock. No process is started.
const waitTurn = {
  turnDir: join(tmpdir(), "dead-turn-wait-absent"),
  lockPid: 1234,
  lockStartTime: "darwin-lstart:1000",
  child: { pid: 2345, startTime: "darwin-lstart:1000" },
  fake: { pid: 3456, startTime: "darwin-lstart:1000" },
  identityMs: 12,
};

// Usefulness: verifies issue #2042, that the wait asks the state lock's rule and not a recorded pid
// whether the turn is gone. Every recorded pid is this live process, so a pid-only gate holds the
// wait to its bound. Not redundant: the case's own wait is the function under test.
test("the dead-turn wait resolves when the lock rule reads every recorded pid gone", async () => {
  const liveTurn = {
    ...waitTurn,
    lockPid: process.pid,
    child: { pid: process.pid, startTime: "unused" },
    fake: { pid: process.pid, startTime: "unused" },
  };
  const reads = async () => ({
    lock: { value: false },
    child: { value: false },
    fake: { value: false },
  });
  let clock = 0;

  await expect(
    waitForKilledTurn(liveTurn, {
      dispatcherExited: () => true,
      boundMs: 100,
      pollMs: 10,
      reads,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
  ).resolves.toEqual({
    lock: { value: false },
    child: { value: false },
    fake: { value: false },
  });
  expect(processExists(process.pid)).toBe(true);
});

// Usefulness: verifies issue #2042 blockers 2 and 3, that the wait reports the pids, the liveness
// reads, the identity read time, and the elapsed time at its bound, and starts no read after it.
// The case passes the budget left after the identity read, so the wait uses the smaller of main's
// 5 s and that budget. Not redundant: no other case drives the shared budget or the failure text.
test("the dead-turn wait spends the budget left after the identity read", async () => {
  let clock = 0;
  let calls = 0;
  const reads = async () => {
    calls += 1;
    return { lock: { value: true }, child: { value: false }, fake: { value: false } };
  };

  const failure = await waitForKilledTurn(waitTurn, {
    dispatcherExited: () => true,
    budgetMs: 60,
    pollMs: 100,
    reads,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  }).catch((error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain("state lock owner pid 1234");
  expect(failure.message).toContain("alive");
  expect(failure.message).toContain("identity read 12 ms");
  expect(failure.message).toContain("60 ms after the kill");
  expect(calls).toBe(1);
});

// Usefulness: verifies issue #2042 blocker 3, that a liveness read which reaches the wait bound is
// reported with its pid and elapsed time. Not redundant: the held-lock case never takes the read
// error path.
test("the dead-turn wait reports a liveness read that reaches its bound", async () => {
  let clock = 0;
  let calls = 0;
  const reads = async (_turn, remaining) => {
    calls += 1;
    clock += 100;
    return {
      lock: {
        error: `the state lock read for pid 1234 did not finish within ${Math.round(remaining)} ms`,
      },
      child: { value: false },
      fake: { value: false },
    };
  };

  const failure = await waitForKilledTurn(waitTurn, {
    dispatcherExited: () => true,
    boundMs: 100,
    pollMs: 10,
    reads,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  }).catch((error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain(
    "the state lock read for pid 1234 did not finish within 100 ms",
  );
  expect(failure.message).toContain("100 ms after the kill");
  expect(calls).toBe(1);
});

// Usefulness: verifies issue #2042, that a recovery process which fails to launch settles at once
// with the launch error, so the case reports the pids, liveness, identity read, and elapsed time
// instead of an outer timeout. Not redundant: no other case fails a launch.
// In-process: the child double emits `error`; no process is started.
test("a recovery launch failure settles with its error", async () => {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  const spawnChild = vi.fn(() => {
    process.nextTick(() => {
      child.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }));
    });
    return child;
  });

  await expect(recoveryCall("unused", "unused", 1000, { spawnChild })).rejects.toThrow(
    /the recovery call could not start: spawn EAGAIN/,
  );
  expect(child.kill).toHaveBeenCalled();
});

// Usefulness: verifies issue #1207 acceptance 2, that a recorded directory which is already gone
// does not fail the call and the run is still marked `interrupted`.
// In-process: the durable `dispatched` state of a killed turn is written directly, so the case
// still proves the transition to `interrupted`.
test("a recorded turn directory that is gone does not fail the interrupted mark", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo);
  expect((await readRepoState(repo)).lifecycle).toBe("dispatched");
  await removePath(dir);

  const next = await nextCall(repo, tmpRoot);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
}, 60_000);

// Usefulness: verifies issue #1207 acceptance 2, that a directory which replaced the recorded one
// is not followed or removed, and the run is still marked `interrupted`.
// In-process: the durable `dispatched` state of a killed turn is written directly, so the case
// still proves the transition to `interrupted`.
test("a directory that replaced the recorded turn directory keeps its content", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo);
  expect((await readRepoState(repo)).lifecycle).toBe("dispatched");
  renameSync(dir, join(tmpRoot, "moved"));
  mkdirSync(dir);
  const sentinel = join(dir, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");

  const next = await nextCall(repo, tmpRoot);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(sentinel)).toBe(true);
}, 60_000);

// Usefulness: verifies issue #1207 review blocker 2, that a child of the dead dispatch which still
// runs keeps its turn directory, and the run is still marked `interrupted`.
// Process: a live child is what the guard reads, so the case starts one and records its pid. The
// durable `dispatched` state is written in process, so the case still proves the transition.
test("a live child of the killed dispatch keeps the turn directory", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const child = liveChild();
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo, { child });
  expect((await readRepoState(repo)).lifecycle).toBe("dispatched");
  expect(processExists(child.pid)).toBe(true);

  const next = await nextCall(repo, tmpRoot);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(join(dir, "leftover.txt"))).toBe(true);
}, 60_000);

// Usefulness: verifies issue #1591 acceptance 1 and 2, that `abort` on a run whose dispatch was
// killed removes the turn directory when no process of the dead child runs, and records the killed
// turn as `interrupted` in `turns`. Not redundant with the interrupted-run test below, which needs
// a dispatch call first and never exercises the direct `dispatched` abort.
// In-process: the durable `dispatched` state that the death leaves is written directly, because no
// case here reads the death itself.
test("abort after a killed dispatch removes its turn directory and records the interrupted turn", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo);
  expect(existsSync(dir)).toBe(true);
  const before = await readRepoState(repo);
  expect(before.lifecycle).toBe("dispatched");
  expect(before.turns).toEqual([]);

  const aborted = await laterCall(repo, tmpRoot, ["abort", "--cwd", "<repo>", "--reason", "stop"]);

  expect(aborted.exitCode).toBe(0);
  expect(aborted.payload).toMatchObject({ status: "ok", lifecycle: "aborted" });
  expect(existsSync(dir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("aborted");
  expect(state.turns).toHaveLength(1);
  expect(state.turns[0]).toMatchObject({
    role: "worker",
    status: "interrupted",
    verdict: null,
    head: null,
  });
}, 60_000);

// Usefulness: verifies issue #1591 acceptance 1, that `abort` keeps the turn directory and warns
// while a process of the dead child still runs, and still records the killed turn as `interrupted`.
// Not redundant with the removal test above, which has no live child to keep the directory.
// Process: a live child is what the guard reads, so the case starts one and records its pid.
test("abort after a killed dispatch keeps the turn directory while the dead child runs", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const child = liveChild();
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo, { child });
  expect(processExists(child.pid)).toBe(true);

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const aborted = await laterCall(repo, tmpRoot, [
      "abort",
      "--cwd",
      "<repo>",
      "--reason",
      "stop",
    ]);

    expect(aborted.exitCode).toBe(0);
    expect(aborted.payload).toMatchObject({ status: "ok", lifecycle: "aborted" });
    const warnings = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes("kept") && line.includes(dir))).toBe(true);
    expect(existsSync(join(dir, "leftover.txt"))).toBe(true);
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("aborted");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ role: "worker", status: "interrupted" });
    expect(processExists(child.pid)).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
}, 60_000);

// Usefulness: verifies issue #1329 acceptance 1, that a later call on an interrupted run
// re-checks the kept turn directory and removes it once no process of the dead child group runs.
// Process: a live child stands as the group at first, and its end is the condition under test.
test("a later abort removes the turn directory kept for a dead child group", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const child = liveChild();
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo, { child });
  await nextCall(repo, tmpRoot);
  expect(existsSync(join(dir, "leftover.txt"))).toBe(true);

  await endChild(child);

  const later = await laterCall(repo, tmpRoot, ["abort", "--cwd", "<repo>", "--reason", "stop"]);

  expect(later.exitCode).toBe(0);
  expect(later.payload.lifecycle).toBe("aborted");
  expect(existsSync(dir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
}, 60_000);

// Usefulness: verifies issue #1329 hostile case, that a later call keeps the turn directory and
// warns while a process of the dead child group still runs.
// Process: a live child is what the guard reads, so the case starts one and records its pid.
test("a later call keeps the turn directory and warns while the dead child group runs", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const child = liveChild();
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo, { child });
  await nextCall(repo, tmpRoot);
  expect(existsSync(join(dir, "leftover.txt"))).toBe(true);

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const later = await nextCall(repo, tmpRoot);

    expect(later.exitCode).toBe(1);
    expect(later.payload.error).toContain("interrupted");
    const warnings = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes("kept") && line.includes(dir))).toBe(true);
    expect(existsSync(join(dir, "leftover.txt"))).toBe(true);
    expect(processExists(child.pid)).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
}, 60_000);

// Usefulness: verifies issue #1329 hostile case, that a later call does not follow a directory that
// replaced the kept turn directory.
// Process: a live child is what the guard reads, so the case starts one and records its pid.
test("a later call keeps a directory that replaced the kept turn directory", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const child = liveChild();
  const { dir, tmpRoot } = await dispatchedWithKeptDir(repo, { child });
  await nextCall(repo, tmpRoot);
  renameSync(dir, join(tmpRoot, "moved"));
  mkdirSync(dir);
  const sentinel = join(dir, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");

  await endChild(child);

  const later = await laterCall(repo, tmpRoot, ["abort", "--cwd", "<repo>", "--reason", "stop"]);

  expect(later.exitCode).toBe(0);
  expect(existsSync(sentinel)).toBe(true);
}, 60_000);

// Usefulness: verifies issue #1329 hostile case, that a later call with no turn directory record
// still ends the run, because the re-check has nothing to remove.
test("a later abort with no turn directory record still ends the run", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const state = await readRepoState(repo);
  state.lifecycle = "interrupted";
  delete state.lastDispatch.turnTmpdir;
  await writeFile(
    statePaths({ cwd: repo }).stateFile,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );

  const later = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo),
    basicDeps(),
  );

  expect(later.exitCode).toBe(0);
  expect(later.payload.lifecycle).toBe("aborted");
});

// Usefulness: verifies issue #1329, that `dispatch --resume-interrupted` re-checks the kept turn
// directory of an ended child before it starts the new turn.
test("resume-interrupted removes the kept turn directory of an ended child", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await interruptedWithKeptDir(repo);

  const resumed = await laterCall(repo, tmpRoot, dispatchArgv(["--resume-interrupted"]));

  expect(resumed.exitCode).toBe(0);
  expect(existsSync(dir)).toBe(false);
}, 60_000);

// Usefulness: verifies issue #1329, that a new init after abort re-checks a directory that abort
// kept because it ran under another temporary directory, and removes it.
test("a new init after abort removes a turn directory that abort kept", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await interruptedWithKeptDir(repo);

  const elsewhere = await mkdtemp(join(tmpdir(), "other-tmp-"));
  scratches.push(elsewhere);
  const aborted = await laterCall(repo, elsewhere, [
    "abort",
    "--cwd",
    "<repo>",
    "--reason",
    "stop",
  ]);
  expect(aborted.exitCode).toBe(0);
  expect(existsSync(dir)).toBe(true);

  const reinit = await laterCall(repo, tmpRoot, [
    "dispatch",
    "--role",
    "worker",
    ...INIT_OVERRIDES,
    "--cwd",
    "<repo>",
  ]);

  expect(reinit.exitCode).toBe(0);
  expect(existsSync(dir)).toBe(false);
}, 60_000);

// Usefulness: verifies issue #1329, that `extend` on an interrupted run re-checks and removes a kept
// turn directory whose child has ended.
test("extend re-checks the kept turn directory of an interrupted run", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await interruptedWithKeptDir(repo);

  const extended = await laterCall(repo, tmpRoot, [
    "extend",
    "--cwd",
    "<repo>",
    "--max-steps",
    "100",
    "--parent-session",
    "parent-sess-1",
  ]);

  expect(extended.exitCode).toBe(0);
  expect(existsSync(dir)).toBe(false);
}, 60_000);

// Usefulness: verifies issue #1329, that `declare-pr` on an interrupted run re-checks and removes a
// kept turn directory whose child has ended.
test("declare-pr re-checks the kept turn directory of an interrupted run", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await interruptedWithKeptDir(repo);

  const declared = await laterCall(repo, tmpRoot, [
    "declare-pr",
    "--cwd",
    "<repo>",
    "--pr",
    "42",
    "--parent-session",
    "parent-sess-1",
  ]);

  expect(declared.exitCode).toBe(0);
  expect(existsSync(dir)).toBe(false);
}, 60_000);

// Usefulness: verifies issue #1329, that a plain dispatch refused for an interrupted run still
// re-checks and removes a kept turn directory whose child has ended.
test("a plain dispatch refused for the interrupted run removes the kept directory", async () => {
  const repo = await newRunRepo();
  await initRun(repo, { agents: basicDeps().agents });
  const { dir, tmpRoot } = await interruptedWithKeptDir(repo);

  const refused = await nextCall(repo, tmpRoot);

  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("interrupted");
  expect(existsSync(dir)).toBe(false);
}, 60_000);

// The pids of the processes that run the fake `codex` script of `scratch`.
async function fakeProcesses(scratch) {
  const script = join(scratch, "bin", "fake-codex.cjs");
  return (await readProcessCommands())
    .filter(({ command }) => command.includes(script))
    .map(({ pid }) => pid)
    .filter((pid) => pid !== process.pid);
}

// Usefulness: verifies issue #1207 review items 1 and 2, that teardown ends the fake `codex` when
// startup times out after the spawn and before the child writes its pid or its report, the window
// that no pid file or process group can cover.
// Process: the case proves teardown of a real child that never reports, which no double can show.
test("teardown ends a fake codex that is delayed before its first statement", async () => {
  await expect(
    killedDispatch({ startupMs: 3000, reportDelayMs: 20_000, startDelayMs: 20_000 }),
  ).rejects.toThrow();
  const scratch = scratches.at(-1);
  expect(await fakePid(scratch)).toBeNull();
  let running = [];
  // A process-table read is bounded at 30 s, so the default 1 s wait can end before one returns.
  await vi.waitFor(
    async () => {
      running = await fakeProcesses(scratch);
      expect(running.length).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );

  await endSpawned();

  await vi.waitFor(async () => expect(await fakeProcesses(scratch)).toEqual([]), {
    timeout: 5000,
  });
}, 60_000);

// Runs one `role dispatch` of a worker whose adapter mirrors the Codex adapter: it creates the turn
// directory with `withTurnTmpdir` and hands the record to `onTurnTmpdir`, then starts its child.
// `failAfterRecord` arms the state writes that follow the start of the record write: the write of
// the record itself is the first one to fail. Returns the call result, the number of children
// started, the turn directory, the temporary root that held it, and the step count before the call.
async function dispatchWithRecordFailure(failAfterRecord) {
  const repo = await newRunRepo();
  const tmpRoot = await mkdtemp(join(tmpdir(), "record-failure-"));
  scratches.push(tmpRoot);
  let armed = false;
  let started = 0;
  let turnDir = null;
  const agents = {
    fake1: {
      async run(_state, _prompt, options) {
        await withTurnTmpdir(
          async (env) => {
            started += 1;
            return env;
          },
          {
            onCreated: async (record) => {
              if (armed) {
                turnDir = record.dir;
                stateWrites.failures = failAfterRecord;
              }
              await options.onTurnTmpdir(record);
            },
          },
        );
        return REPORT;
      },
    },
    fake2: { run: async () => REPORT },
  };
  await initRun(repo, { agents });
  armed = true;
  started = 0;
  const stepsBefore = (await readRepoState(repo)).stepsUsed;
  vi.stubEnv("TMPDIR", tmpRoot);
  vi.stubEnv("TEMP", tmpRoot);
  vi.stubEnv("TMP", tmpRoot);
  const result = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  stateWrites.failures = 0;
  return { repo, result, started, turnDir, tmpRoot, stepsBefore };
}

// Usefulness: verifies ADR 0058 decision 1, first sentences, that a dispatch whose record write
// fails once starts no child, removes the turn directory, charges the step, and returns the run to
// `active` with an error result. Not redundant with tests/lib/turn-tmpdir.test.mjs, which stops at
// `withTurnTmpdir` and never reaches the lifecycle or the step count.
test("a failed record write starts no child and returns the run to active with the step charged", async () => {
  const { repo, result, started, turnDir, tmpRoot, stepsBefore } =
    await dispatchWithRecordFailure(1);

  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(started).toBe(0);
  expect(existsSync(turnDir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("active");
  expect(state.stepsUsed).toBe(stepsBefore + 1);
  expect(state.lastResult.status).toBe("error");
});

// Usefulness: verifies ADR 0058 decision 1, last sentences, that when the write of the error result
// fails too, the call fails and the run keeps the durable `dispatched` state of the write before the
// spawn, with the step charged, no child started, and the turn directory removed.
test("a failed record write and a failed result write leave the run dispatched with the step charged", async () => {
  const { repo, result, started, turnDir, tmpRoot, stepsBefore } =
    await dispatchWithRecordFailure(Infinity);

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("injected state write failure");
  expect(started).toBe(0);
  expect(existsSync(turnDir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("dispatched");
  expect(state.stepsUsed).toBe(stepsBefore + 1);
  expect(state.lastResult.status).not.toBe("error");
});

// Usefulness: verifies issue #1216 stale record, that a record write which fails leaves no record in
// the state that the later error-result write saves, because the directory is already removed.
// Not redundant with the lifecycle tests above, which never read the saved record.
test("a failed record write leaves no turn directory record in the saved state", async () => {
  const { repo } = await dispatchWithRecordFailure(1);

  const state = await readRepoState(repo);
  expect(state.lastDispatch.turnTmpdir).toBeUndefined();
});
