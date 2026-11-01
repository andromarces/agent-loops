import { spawn, spawnSync } from "node:child_process";
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
import { readProcessCommands, readProcessTable } from "../src/lib/process-ancestry.mjs";
import { statePaths } from "../src/lib/runstate.mjs";
import { withTurnTmpdir } from "../src/lib/turn-tmpdir.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  initRun,
  newRunRepo,
  readRepoState,
  REPORT,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { removePath } from "./fs-helpers.mjs";
import { deadPid, processExists } from "./process-helpers.mjs";

// Passes every state write through, except the ones that a test arms to fail after the record write
// of a turn directory. `failures` is how many of the next writes throw, `Infinity` for every one.
const stateWrites = vi.hoisted(() => ({ failures: 0 }));
vi.mock("../src/lib/atomic-write.mjs", async (importOriginal) => {
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

const ROLE = fileURLToPath(new URL("../src/role.mjs", import.meta.url));
const scratches = [];
// Every spawned dispatch, so teardown ends it on every path, a startup timeout included.
const dispatches = [];

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
// included: the tree of a live dispatcher first, then the pid that each fake wrote on its own.
async function endSpawned() {
  for (const child of dispatches.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await endTree(child);
      await exited;
    }
  }
  for (const dir of scratches) {
    const pid = await fakePid(dir);
    if (pid !== null && processExists(pid)) process.kill(pid, "SIGKILL");
  }
}

afterEach(async () => {
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

/**
 * Starts a real `role dispatch` whose Codex turn hangs and kills the dispatch with SIGKILL mid-turn,
 * once the state file holds the child of the turn. The orphaned fake `codex` is ended unless
 * `keepChild` is set, and teardown ends it either way. Returns the work tree, the temporary
 * directory of the turn (as the turn child saw it), the temporary root that holds it, and the pid
 * of the fake `codex`.
 */
async function killedDispatch({
  keepChild = false,
  startupMs = 30_000,
  reportDelayMs = 0,
  startDelayMs = 0,
} = {}) {
  const repo = await newRunRepo();
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
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let turn;
  await vi.waitFor(
    async () => {
      turn = JSON.parse(await readFile(report, "utf8").catch(() => "null"));
      expect(turn?.pid).toBeGreaterThan(0);
      // The dispatch has recorded the child, so the kill leaves the record a recovery reads.
      const state = await readRepoState(repo).catch(() => null);
      expect(state?.lastDispatch?.turnTmpdir?.child?.pid).toBeGreaterThan(0);
    },
    { timeout: startupMs, interval: 100 },
  );
  child.kill("SIGKILL");
  await exited;
  if (!keepChild) {
    if (processExists(turn.pid)) process.kill(turn.pid, "SIGKILL");
    await vi.waitFor(() => expect(processExists(turn.pid)).toBe(false), { timeout: 5000 });
  }
  return { repo, turnDir: turn.dir, tmpRoot, childPid: turn.pid };
}

// The recovery call inherits the temporary directory that held the turn directory, as a call of the
// same host does. A record of another parent is refused (issue #1216).
const nextCall = (repo, tmpRoot) => {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tmpRoot);
  return executeRoleCommand(withRepo(dispatchArgv(), repo), { ...basicDeps(), stdin: stdinPrompt });
};

// Runs another role operation on the run in `repo`, under the temporary root of its killed
// dispatch, so a re-check of the kept turn directory meets the record origin check.
const laterCall = (repo, tmpRoot, argv) => {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tmpRoot);
  return executeRoleCommand(withRepo(argv, repo), { ...basicDeps(), stdin: stdinPrompt });
};

// Turns the run in `repo` into an interrupted run that kept a turn directory whose recorded child
// is dead. Returns the directory and the temporary root that holds it.
async function interruptedWithKeptDir(repo) {
  const tmpRoot = await mkdtemp(join(tmpdir(), "kept-turn-"));
  scratches.push(tmpRoot);
  const dir = await mkdtemp(join(tmpRoot, "al-"));
  writeFileSync(join(dir, "leftover.txt"), "x\n");
  const stat = lstatSync(dir, { bigint: true });
  const state = await readRepoState(repo);
  state.lifecycle = "interrupted";
  state.lastDispatch = {
    role: "worker",
    at: new Date().toISOString(),
    turnTmpdir: {
      dir,
      parentReal: dirname(realpathSync.native(dir)),
      device: String(stat.dev),
      inode: String(stat.ino),
      child: { pid: await deadPid() },
    },
  };
  await writeFile(
    statePaths({ cwd: repo }).stateFile,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { dir, tmpRoot };
}

// Usefulness: verifies issue #1207 acceptance 1, that the call which marks a run `interrupted`
// after its dispatch process died mid-turn removes the directory of that turn.
test("the call that marks a killed dispatch interrupted removes its turn directory", async () => {
  const { repo, turnDir, tmpRoot } = await killedDispatch();
  expect(existsSync(turnDir)).toBe(true);

  const next = await nextCall(repo, tmpRoot);

  expect(next.exitCode).toBe(1);
  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(turnDir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
}, 60_000);

// Usefulness: verifies issue #1207 acceptance 2, that a recorded directory which is already gone
// does not fail the call and the run is still marked `interrupted`.
test("a recorded turn directory that is gone does not fail the interrupted mark", async () => {
  const { repo, turnDir, tmpRoot } = await killedDispatch();
  await removePath(turnDir);

  const next = await nextCall(repo, tmpRoot);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
}, 60_000);

// Usefulness: verifies issue #1207 acceptance 2, that a directory which replaced the recorded one
// is not followed or removed, and the run is still marked `interrupted`.
test("a directory that replaced the recorded turn directory keeps its content", async () => {
  const { repo, turnDir, tmpRoot } = await killedDispatch();
  renameSync(turnDir, join(tmpRoot, "moved"));
  mkdirSync(turnDir);
  const sentinel = join(turnDir, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");

  const next = await nextCall(repo, tmpRoot);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(sentinel)).toBe(true);
}, 60_000);

// Usefulness: verifies issue #1207 review blocker 2, that a child of the dead dispatch which still
// runs keeps its turn directory, and the run is still marked `interrupted`.
test("a live child of the killed dispatch keeps the turn directory", async () => {
  const { repo, turnDir, tmpRoot, childPid } = await killedDispatch({ keepChild: true });
  expect(processExists(childPid)).toBe(true);

  const next = await nextCall(repo, tmpRoot);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(join(turnDir, "leftover.txt"))).toBe(true);
}, 60_000);

// Usefulness: verifies issue #1329 acceptance 1, that a later call on an interrupted run
// re-checks the kept turn directory and removes it once no process of the dead child group runs.
test("a later abort removes the turn directory kept for a dead child group", async () => {
  const { repo, turnDir, tmpRoot, childPid } = await killedDispatch({ keepChild: true });
  const first = await nextCall(repo, tmpRoot);
  expect(first.payload.error).toContain("interrupted");
  expect(existsSync(join(turnDir, "leftover.txt"))).toBe(true);

  process.kill(childPid, "SIGKILL");
  await vi.waitFor(() => expect(processExists(childPid)).toBe(false), { timeout: 5000 });

  const later = await laterCall(repo, tmpRoot, ["abort", "--cwd", "<repo>", "--reason", "stop"]);

  expect(later.exitCode).toBe(0);
  expect(later.payload.lifecycle).toBe("aborted");
  expect(existsSync(turnDir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
}, 60_000);

// Usefulness: verifies issue #1329 hostile case, that a later call keeps the turn directory and
// warns while a process of the dead child group still runs.
test("a later call keeps the turn directory and warns while the dead child group runs", async () => {
  const { repo, turnDir, tmpRoot, childPid } = await killedDispatch({ keepChild: true });
  await nextCall(repo, tmpRoot);
  expect(existsSync(join(turnDir, "leftover.txt"))).toBe(true);

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const later = await nextCall(repo, tmpRoot);

    expect(later.exitCode).toBe(1);
    expect(later.payload.error).toContain("interrupted");
    const warnings = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes("kept") && line.includes(turnDir))).toBe(true);
    expect(existsSync(join(turnDir, "leftover.txt"))).toBe(true);
    expect(processExists(childPid)).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
}, 60_000);

// Usefulness: verifies issue #1329 hostile case, that a later call does not follow a directory that
// replaced the kept turn directory.
test("a later call keeps a directory that replaced the kept turn directory", async () => {
  const { repo, turnDir, tmpRoot, childPid } = await killedDispatch({ keepChild: true });
  await nextCall(repo, tmpRoot);
  renameSync(turnDir, join(tmpRoot, "moved"));
  mkdirSync(turnDir);
  const sentinel = join(turnDir, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");

  process.kill(childPid, "SIGKILL");
  await vi.waitFor(() => expect(processExists(childPid)).toBe(false), { timeout: 5000 });

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
test("teardown ends a fake codex that is delayed before its first statement", async () => {
  await expect(
    killedDispatch({ startupMs: 3000, reportDelayMs: 20_000, startDelayMs: 20_000 }),
  ).rejects.toThrow();
  const scratch = scratches.at(-1);
  expect(await fakePid(scratch)).toBeNull();
  let running = [];
  await vi.waitFor(async () => {
    running = await fakeProcesses(scratch);
    expect(running.length).toBeGreaterThan(0);
  });

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
