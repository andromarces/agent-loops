import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { killTreeOnExit } from "../../src/lib/exec-tree.mjs";
import { removePath } from "../runtime-helpers.mjs";

const EXEC_TREE_URL = new URL("../../src/lib/exec-tree.mjs", import.meta.url).href;
const EXECA_URL = import.meta.resolve("execa");
const IS_WINDOWS = process.platform === "win32";
const MISSING_ROOT = "Z:/exec-tree-missing-root";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

function endProcess(pid) {
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
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
// tmpdir-isolation.test.mjs, and no other test exits the parent early.
test.skipIf(!IS_WINDOWS)(
  "a parent that exits with a nested run live leaves no process of that run",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-tree-"));
    const pidFile = join(dir, "nested.pid");
    const childPidFile = join(dir, "child.pid");
    const failedFile = join(dir, "failed.txt");
    let parentPid;
    let childPid;
    let nestedPid;
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
          // The nested run ended before it recorded a pid: report why, so a CI failure names the cause.
          `run.then((r) => { if (!existsSync(${JSON.stringify(pidFile)})) { writeFileSync(${JSON.stringify(failedFile)}, String(r.shortMessage ?? r.message ?? r.exitCode)); process.exit(3); } });`,
          `setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 50);`,
          "setTimeout(() => process.exit(2), 20000);",
        ].join("\n"),
      );

      parentPid = await startOutsideRunner(join(dir, "parent.mjs"));
      expect(await waitUntil(() => !isAlive(parentPid), 30000)).toBe(true);
      expect(await readFile(failedFile, "utf8").catch(() => "")).toBe("");

      nestedPid = await readPid(pidFile);
      childPid = await readPid(childPidFile);
      expect(nestedPid).toBeTypeOf("number");
      expect(childPid).toBeTypeOf("number");
      expect(await waitUntil(() => !isAlive(nestedPid) && !isAlive(childPid), 8000)).toBe(true);
    } finally {
      [parentPid, childPid, nestedPid ?? (await readPid(pidFile))].forEach(endProcess);
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
