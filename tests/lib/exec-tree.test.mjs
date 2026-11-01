import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import {
  endDescendantTrees,
  killLiveTrees,
  killTreeOnExit,
  processTableRows,
} from "../../src/lib/exec-tree.mjs";
import { removePath } from "../fs-helpers.mjs";
import { processExists } from "../process-helpers.mjs";

const EXEC_TREE_URL = new URL("../../src/lib/exec-tree.mjs", import.meta.url).href;
const LOG_URL = new URL("../../src/lib/log.mjs", import.meta.url).href;
const EXECA_URL = import.meta.resolve("execa");
const IS_WINDOWS = process.platform === "win32";
const MISSING_ROOT = "Z:/exec-tree-missing-root";

const waitUntil = (predicate, timeout) =>
  vi.waitFor(async () => expect(await predicate()).toBe(true), { timeout, interval: 100 });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function endProcess(pid) {
  if (Number.isInteger(pid) && pid > 0 && processExists(pid)) process.kill(pid, "SIGKILL");
}

/**
 * Ends every process that a failed run can have left: the pids in `known`, then the pids that the
 * `files` hold now. A second round reads the files again, so a process that recorded its pid while
 * the first round ran is ended too, and a failure before a pid file exists leaves no reader behind.
 */
async function endRecorded(known, files) {
  for (let round = 0; round < 2; round += 1) {
    const recorded = await Promise.all(files.map(readPid));
    [...known, ...recorded].forEach(endProcess);
    await sleep(300);
  }
}

async function readPid(file) {
  const pid = Number(await readFile(file, "utf8").catch(() => ""));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Starts `script` as a Node process with `Win32_Process.Create`, so it runs outside the process
 * tree of the test runner, and returns its pid. In a probe on Windows 11, a parent that the runner
 * spawned lost its nested run the moment it exited, with or without the fix, so that parent cannot
 * show the defect of issue #612. A parent that a user shell starts shows it. The created process
 * gets the system environment, so the test relies on no `PATH` entry: every executable is an
 * absolute path.
 */
async function startOutsideRunner(script) {
  const powershell = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const commandLine = `"${process.execPath}" "${script}"`;
  const created = await execa(powershell, [
    "-NoProfile",
    "-Command",
    `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine}'}).ProcessId`,
  ]);
  return Number(created.stdout.trim());
}

// Usefulness: acceptance (#612) — a parent that exits through `process.exit` while a nested run is
// live leaves no process of that run. Windows `taskkill /T` cannot find the descendants of a
// process that already exited, and execa cleanup starts it without waiting, so only a kill that
// finishes inside the exit handler covers this row. Not redundant: the timeout row is covered by
// setup-tmpdir.test.mjs, and no other test exits the parent early.
test.skipIf(!IS_WINDOWS)(
  "a parent that exits with a nested run live leaves no process of that run",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-tree-"));
    const pidFile = join(dir, "nested.pid");
    const childPidFile = join(dir, "child.pid");
    const shellPidFile = join(dir, "shell.pid");
    const failedFile = join(dir, "failed.txt");
    let parentPid;
    try {
      // The shell starts the child, and the child starts a grandchild that records its pid. The
      // chain is as deep as the nested `pnpm exec vp` run of issue #612, and a plain child with no
      // shell does not show the defect. Both processes end on their own after 60 s if a failure
      // leaves them.
      await writeFile(
        join(dir, "hang.cjs"),
        [
          'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
          "setTimeout(() => {}, 60000);",
        ].join("\n"),
      );
      await writeFile(
        join(dir, "child.cjs"),
        [
          'const { spawn } = require("node:child_process");',
          'require("node:fs").writeFileSync(process.argv[4], String(process.pid));',
          'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" });',
          "setTimeout(() => {}, 60000);",
        ].join("\n"),
      );
      const command = [
        process.execPath,
        join(dir, "child.cjs"),
        join(dir, "hang.cjs"),
        pidFile,
        childPidFile,
      ]
        .map((part) => `"${part}"`)
        .join(" ");
      await writeFile(
        join(dir, "parent.mjs"),
        [
          `import { execa } from ${JSON.stringify(EXECA_URL)};`,
          `import { killTreeOnExit } from ${JSON.stringify(EXEC_TREE_URL)};`,
          'import { existsSync, writeFileSync } from "node:fs";',
          `const run = killTreeOnExit(execa(${JSON.stringify(command)}, { shell: true, cwd: ${JSON.stringify(dir)}, reject: false, cleanup: true, killDescendants: true }));`,
          // The pid of the shell, which is the root that the exit handler kills.
          `writeFileSync(${JSON.stringify(shellPidFile)}, String(run.pid));`,
          // The nested run ended before it recorded a pid: report why, so a CI failure names the cause.
          `run.then((r) => { if (!existsSync(${JSON.stringify(pidFile)})) { writeFileSync(${JSON.stringify(failedFile)}, String(r.shortMessage ?? r.message ?? r.exitCode)); process.exit(3); } });`,
          `setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 50);`,
          "setTimeout(() => process.exit(2), 20000);",
        ].join("\n"),
      );

      parentPid = await startOutsideRunner(join(dir, "parent.mjs"));
      await waitUntil(() => !processExists(parentPid), 30000);
      expect(await readFile(failedFile, "utf8").catch(() => "")).toBe("");

      const tree = await Promise.all([shellPidFile, childPidFile, pidFile].map(readPid));
      expect(tree.every((pid) => typeof pid === "number")).toBe(true);
      await waitUntil(() => tree.every((pid) => !processExists(pid)), 8000);
    } finally {
      await endRecorded([parentPid], [shellPidFile, childPidFile, pidFile]);
      await removePath(dir);
    }
  },
  60000,
);

/**
 * Runs a parent that registers one run with `killTreeOnExit` while `SystemRoot` names a directory
 * that holds no `taskkill.exe`, so every kill attempt fails and logs. Returns the exit code, the
 * stderr, and the pid of the child that the parent started, if any.
 */
async function runFailingKillParent(mode) {
  const dir = await mkdtemp(join(tmpdir(), "exec-tree-"));
  try {
    // Set after the child starts: a Node child without a valid `SystemRoot` aborts at startup.
    const breakRoot = [
      `process.env.SystemRoot = ${JSON.stringify(MISSING_ROOT)};`,
      `process.env.windir = ${JSON.stringify(MISSING_ROOT)};`,
    ];
    const body = {
      live: [
        'const run = execa(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cleanup: false, killDescendants: true, reject: false });',
        ...breakRoot,
        "killTreeOnExit(run);",
        "console.log(run.pid);",
        "setTimeout(() => process.exit(0), 1000);",
      ],
      exited: [
        'const run = execa(process.execPath, ["-e", ""], { cleanup: false, killDescendants: true, reject: false });',
        "await run;",
        ...breakRoot,
        "killTreeOnExit(run);",
        "console.log(run.pid);",
        "process.exit(0);",
      ],
      pid0: [
        ...breakRoot,
        'killTreeOnExit(Object.assign(Promise.resolve({}), { pid: 0, exitCode: null, signalCode: null, kill() { throw new Error("kill called"); } }));',
        "process.exit(0);",
      ],
    }[mode];
    const script = join(dir, "parent.mjs");
    await writeFile(
      script,
      [
        `import { execa } from ${JSON.stringify(EXECA_URL)};`,
        `import { killTreeOnExit } from ${JSON.stringify(EXEC_TREE_URL)};`,
        ...body,
      ].join("\n"),
    );
    const result = await execa(process.execPath, [script], { reject: false });
    return { exitCode: result.exitCode, stderr: result.stderr, childPid: Number(result.stdout) };
  } finally {
    await removePath(dir);
  }
}

// Usefulness: a kill failure on exit is logged at warn level and never throws out of the exit
// handler, so the parent still exits 0 and the operator sees that a tree can remain. Not
// redundant: the first test covers only a successful kill.
test.skipIf(!IS_WINDOWS)("a failed taskkill on exit is logged and does not throw", async () => {
  const { exitCode, stderr, childPid } = await runFailingKillParent("live");
  try {
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/warn: process tree of pid \d+ not ended on exit: taskkill failed/);
  } finally {
    endProcess(childPid);
  }
});

// Usefulness: `taskkill` exit code 128 (no process with that pid) must not read as a confirmed tree
// kill, because `taskkill /T` walks the parent links of a live root only. Not redundant: the first
// test covers a kill that ends a live tree, and no other test covers a root that is gone. The pid
// is odd, and Windows pids are multiples of 4, so no process can have it.
test.skipIf(!IS_WINDOWS)(
  "a taskkill that finds no process is not logged as a tree kill",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-tree-"));
    try {
      const script = join(dir, "parent.mjs");
      await writeFile(
        script,
        [
          `import { killTreeOnExit } from ${JSON.stringify(EXEC_TREE_URL)};`,
          `import { setVerbose } from ${JSON.stringify(LOG_URL)};`,
          "setVerbose(true);",
          "killTreeOnExit(Object.assign(Promise.resolve({}), { pid: 999999999, exitCode: null, signalCode: null }));",
          "process.exit(0);",
        ].join("\n"),
      );
      const result = await execa(process.execPath, [script], { reject: false });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/debug: taskkill found no process with pid 999999999/);
      expect(result.stdout).not.toMatch(/ended on exit/);
    } finally {
      await removePath(dir);
    }
  },
);

// Usefulness: the exit handler never signals a child that already exited, because the OS can
// reassign its pid (a stale pid). Not redundant: only an attempted kill logs here, so the silence
// shows that none ran.
test.skipIf(!IS_WINDOWS)("an exited child gets no taskkill on exit", async () => {
  const { exitCode, stderr, childPid } = await runFailingKillParent("exited");
  endProcess(childPid);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
});

// Usefulness: a pid of 0 is never signaled, because `taskkill /pid 0` does not name a child of
// this process. Not redundant: only an attempted kill logs here, so the silence shows that none ran.
test.skipIf(!IS_WINDOWS)("a run with pid 0 gets no taskkill on exit", async () => {
  const { exitCode, stderr } = await runFailingKillParent("pid0");
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
});

// Usefulness: the helper must not break a caller that holds no child process, such as a spawn that
// failed, and it changes nothing off Windows. Not redundant: spawn-bounds.test.mjs mocks execa with
// a promise that has no pid.
test("a subprocess with no pid passes through unchanged", () => {
  const failed = Promise.resolve({ exitCode: 1 });
  expect(killTreeOnExit(failed)).toBe(failed);
});

// Usefulness: acceptance (#669) — killLiveTrees ends a live child that ignores SIGTERM, on every
// platform, so a forced exit of the runtime leaves no child alive.
test("killLiveTrees ends a live child that ignores SIGTERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exec-tree-force-"));
  const pidFile = join(dir, "child.pid");
  const script =
    'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  const subprocess = killTreeOnExit(
    execa(process.execPath, ["-e", script, pidFile], {
      reject: false,
      cleanup: true,
      killDescendants: true,
    }),
  );
  let pid;
  try {
    await waitUntil(async () => (pid = await readPid(pidFile)) !== undefined, 20_000);
    killLiveTrees();
    await waitUntil(() => !processExists(pid), 5000);
  } finally {
    endProcess(pid);
    await subprocess;
    await removePath(dir);
  }
}, 40_000);

// Usefulness: acceptance (#669) — a SIGKILL that execa does not deliver (it returns false) is
// logged at warn level and does not stop the kill of the next live run, so ADR 0033 can name it.
test("killLiveTrees warns when a SIGKILL is not delivered and still kills the next run", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const refused = Object.assign(Promise.resolve(), { pid: 424241, kill: vi.fn(() => false) });
  const killed = Object.assign(Promise.resolve(), { pid: 424242, kill: vi.fn(() => true) });
  try {
    killTreeOnExit(refused);
    killTreeOnExit(killed);
    killLiveTrees();
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(killed.kill).toHaveBeenCalledWith("SIGKILL");
    expect(logged).toMatch(/warn: .*424241.*not ended.*SIGKILL/);
    expect(logged).not.toMatch(/424242/);
  } finally {
    Object.defineProperty(process, "platform", platform);
    warn.mockRestore();
  }
});

/**
 * Starts a parent that runs one child with the tree end on. It waits until the child's detached
 * command tree records its pid. Then it sends `SIGTERM` to the parent, and returns the parent exit
 * and the tree pid. The child is the stand-in for a Codex child. Its command runs in its own
 * session, so the process-group signal of the parent cannot reach it.
 */
async function startSigTermParent() {
  const dir = await mkdtemp(join(tmpdir(), "exec-tree-sigterm-"));
  const treePidFile = join(dir, "tree.pid");
  const orphanFile = join(dir, "orphan.txt");
  const child = join(dir, "child.mjs");
  const parent = join(dir, "parent.mjs");
  await writeFile(
    child,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const tree = spawn("/bin/sh", ["-c", "sleep 1; echo ORPHAN > " + JSON.stringify(${JSON.stringify(orphanFile)}) + "; sleep 60"], { detached: true, stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(treePidFile)}, String(tree.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    parent,
    [
      `import { exec } from ${JSON.stringify(new URL("../../src/lib/exec.mjs", import.meta.url).href)};`,
      `exec(process.execPath, [${JSON.stringify(child)}], { treeEnd: true }).catch(() => {});`,
    ].join("\n"),
  );
  const runner = spawn(process.execPath, [parent], { stdio: "ignore" });
  const exited = new Promise((resolve) =>
    runner.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await waitUntil(async () => {
    const pid = Number(await readFile(treePidFile, "utf8").catch(() => ""));
    return Number.isInteger(pid) && pid > 0;
  }, 20_000);
  const treePid = Number(await readFile(treePidFile, "utf8"));
  runner.kill("SIGTERM");
  const exit = await exited;
  return { dir, exit, treePid, orphanFile };
}

// Usefulness: acceptance (#1326) — a SIGTERM of the parent ends a command tree that left the Codex
// child's process group. No orphan write lands after the parent exit. Not redundant: the other
// tests end a tree through a kill inside the parent, never through a parent signal.
test.skipIf(IS_WINDOWS)(
  "a parent SIGTERM ends a descendant command tree that left the child process group",
  async () => {
    const { dir, exit, treePid, orphanFile } = await startSigTermParent();
    try {
      expect(exit.signal).toBe("SIGTERM");
      await vi.waitFor(() => expect(processExists(treePid)).toBe(false), {
        timeout: 4_000,
        interval: 100,
      });
      // The tree writes 1 s after the signal if it survives the parent.
      await sleep(2_500);
      expect(await readFile(orphanFile, "utf8").catch(() => null)).toBe(null);
    } finally {
      endProcess(treePid);
      await removePath(dir);
    }
  },
  60_000,
);

/** Builds a process table from `[pid, ppid, start]` rows. */
const tableOf = (rows) =>
  new Map(
    rows.map(([pid, ppid, start = "Mon Jan 1 00:00:00 2026"]) => [pid, { pid, ppid, start }]),
  );

// Usefulness: acceptance (#1326) — the walk ends only the given roots and their descendants, so a
// process of another agent-loop run is never ended. Not redundant: no other test covers a table
// with a second, unrelated tree.
test("a tree end signals only its own roots and their descendants", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
    [102, 101],
    [200, 1],
    [201, 200],
    [1, 0],
  ]);
  const killed = [];
  const ended = endDescendantTrees({
    roots: [100],
    readTable: () => table,
    stop: () => {},
    kill: (pid) => killed.push(pid),
  });
  expect(killed.sort()).toEqual([100, 101, 102]);
  expect(ended.sort()).toEqual([100, 101, 102]);
});

// Usefulness: acceptance (#1326) — the Codex child is stopped before any descendant. It cannot reap
// a first-level child and free that pid before the stop. Not redundant: no other test records the
// stop order from the root.
test("the Codex child is stopped before any descendant", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
    [102, 101],
  ]);
  const stops = [];
  endDescendantTrees({
    roots: [100],
    readTable: () => table,
    stop: (pid) => stops.push(pid),
    kill: () => {},
  });
  expect(stops).toEqual([100, 101, 102]);
});

// Usefulness: acceptance (#1326) — each process is killed while its parent is still stopped and
// alive. The Codex child is killed last, so no killed parent releases a zombie child to init. Not
// redundant: no other test records the kill order.
test("each kill comes before its parent's kill, and the Codex child is killed last", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
    [102, 101],
  ]);
  const parentOf = new Map([
    [101, 100],
    [102, 101],
  ]);
  const events = [];
  const killed = new Set();
  const killedAfterParent = [];
  const ended = endDescendantTrees({
    roots: [100],
    readTable: () => table,
    stop: (pid) => events.push(`stop ${pid}`),
    kill: (pid) => {
      events.push(`kill ${pid}`);
      if (killed.has(parentOf.get(pid))) killedAfterParent.push(pid);
      killed.add(pid);
    },
  });
  expect(killedAfterParent).toEqual([]);
  expect(events.filter((event) => event.startsWith("kill "))).toEqual([
    "kill 102",
    "kill 101",
    "kill 100",
  ]);
  expect(ended).toEqual([102, 101, 100]);
});

// Usefulness: the walk reads the table twice and drops a pid whose start stamp changed. A pid
// reused between the read and the signal is never ended. Not redundant: no other test presents a
// changed stamp.
test("a pid whose start stamp changed between the reads is not signaled", () => {
  const first = tableOf([
    [100, 1, "a"],
    [101, 100, "a"],
    [102, 100, "a"],
  ]);
  const second = tableOf([
    [100, 1, "a"],
    [101, 100, "b"],
    [102, 100, "a"],
  ]);
  const reads = [first, second];
  const killed = [];
  const stopped = [];
  endDescendantTrees({
    roots: [100],
    readTable: () => reads.shift(),
    stop: (pid) => stopped.push(pid),
    kill: (pid) => killed.push(pid),
  });
  expect(stopped).toEqual([100, 102]);
  expect(killed).toEqual([102, 100]);
});

// Usefulness: a failed process-table read still ends the stopped root, so a broken read never leaves
// a process stopped. Not redundant: it is the first read of the walk and the guard read is separate.
test("a failed process table read still ends the stopped root", () => {
  const killed = [];
  expect(
    endDescendantTrees({
      roots: [100],
      readTable: () => null,
      stop: () => {},
      kill: (pid) => killed.push(pid),
    }),
  ).toEqual([100]);
  expect(killed).toEqual([100]);
});

// Usefulness: a failed guard read still ends the stopped root, so the guard cannot leave a process
// stopped. Not redundant: it fails on the second read, after the root is stopped.
test("a failed guard read still ends the stopped root", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
  ]);
  let reads = 0;
  const killed = [];
  endDescendantTrees({
    roots: [100],
    readTable: () => (reads++ === 0 ? table : null),
    stop: () => {},
    kill: (pid) => killed.push(pid),
  });
  expect(killed).toEqual([100]);
});

// Usefulness: a walk that reaches its budget still ends the stopped set. A slow or deep tree cannot
// hold the parent exit past the budget. Not redundant: no other test moves the walk clock.
test("the walk ends at its budget and still ends the stopped set", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
  ]);
  let clock = 0;
  const stopped = [];
  const killed = [];
  endDescendantTrees({
    roots: [100],
    readTable: () => {
      clock += 2_000;
      return table;
    },
    stop: (pid) => stopped.push(pid),
    kill: (pid) => killed.push(pid),
    now: () => clock,
    budgetMs: 4_000,
  });
  expect(stopped).toEqual([100, 101]);
  expect(killed).toEqual([101, 100]);
});

// Usefulness: a read that fails after a level is stopped still kills the stopped set from the leaves
// up. A broken read never leaves the freeze in place. Not redundant: the other read-failure tests
// stop no descendant.
test("a failed read after a stop still ends the stopped set", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
  ]);
  let reads = 0;
  const killed = [];
  const ended = endDescendantTrees({
    roots: [100],
    readTable: () => (reads++ < 2 ? table : null),
    stop: () => {},
    kill: (pid) => killed.push(pid),
  });
  expect(killed).toEqual([101, 100]);
  expect(ended).toEqual([101, 100]);
});

// Usefulness: a kill that fails resumes the row, so a failed kill never leaves a process stopped.
// Not redundant: the other tests kill every stopped row.
test("a row that a failed kill leaves stopped is resumed", () => {
  const table = tableOf([
    [100, 1],
    [101, 100],
  ]);
  const resumed = [];
  const ended = endDescendantTrees({
    roots: [100],
    readTable: () => table,
    stop: () => {},
    kill: (pid) => {
      if (pid === 101) throw new Error("not permitted");
    },
    resume: (pid) => resumed.push(pid),
  });
  expect(resumed).toEqual([101]);
  expect(ended).toEqual([100]);
});

// Usefulness: records the accepted gap of ADR 0071. A descendant that lost its parent chain, for
// example reparented to pid 1, is not found by a parent-link walk. Not redundant: this is the one
// hostile case that the fix does not cover, and the assertion pins it.
test("a process reparented to pid 1 is not a descendant of the root", () => {
  const table = tableOf([
    [100, 1],
    [301, 1],
  ]);
  const signalled = [];
  endDescendantTrees({
    roots: [100],
    readTable: () => table,
    stop: (pid) => signalled.push(`stop ${pid}`),
    kill: (pid) => signalled.push(`kill ${pid}`),
  });
  expect(signalled).toEqual(["stop 100", "kill 100"]);
  expect(signalled.some((event) => event.endsWith("301"))).toBe(false);
});

// Usefulness: a `ps` that hangs is ended at the read bound, so a parent signal never holds the
// exit beyond it. Not redundant: no other test exercises the real synchronous read and its bound.
test.skipIf(IS_WINDOWS)(
  "a hanging process-table read ends at its bound",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-tree-read-"));
    try {
      const shim = join(dir, "ps");
      // `exec` replaces the shell, so the bound ends the `sleep` itself.
      await writeFile(shim, "#!/bin/sh\nexec sleep 30\n");
      await chmod(shim, 0o755);
      const script = [
        `import { endDescendantTrees } from ${JSON.stringify(EXEC_TREE_URL)};`,
        "const started = Date.now();",
        "const ended = endDescendantTrees({ roots: [process.pid], stop: () => {}, kill: () => {}, resume: () => {} });",
        "console.log(JSON.stringify({ pid: process.pid, ended, elapsed: Date.now() - started }));",
      ].join("\n");
      const result = await execa(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        timeout: 20_000,
        reject: false,
      });
      expect(result.exitCode).toBe(0);
      const { pid, ended, elapsed } = JSON.parse(result.stdout);
      expect(ended).toEqual([pid]);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await removePath(dir);
    }
  },
  30_000,
);

// Usefulness: a table read that returns no parseable row is an empty table, not a crash. Not
// redundant: the parse is the only place that reads raw `ps` output.
test("a process table with no parseable row is empty", () => {
  expect(processTableRows("not a table\n")).toEqual(new Map());
  expect(processTableRows("  1     0 Sat Oct 31 09:50:03 2026\n").get(1)).toEqual({
    pid: 1,
    ppid: 0,
    start: "Sat Oct 31 09:50:03 2026",
  });
});
