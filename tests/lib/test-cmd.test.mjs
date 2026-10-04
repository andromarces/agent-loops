import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { TAIL_CHARS, redactEnvSecrets, runTestCmd } from "../../src/lib/test-cmd.mjs";
import { createTempRepo, removePath } from "../runtime-helpers.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await removePath(dir);
  }
});

async function repo() {
  const dir = await createTempRepo();
  dirs.push(dir);
  return dir;
}

// One shell-neutral way to run a JS body: double quotes outside, single quotes inside.
const node = (body) => `node -e "${body}"`;

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// Usefulness: verifies a passing command reports exit 0 and its output, so the
// reviewer sees the evidence the runtime read (issue #420).
test("a passing command reports pass, exit 0, and its output", async () => {
  const cwd = await repo();
  const run = await runTestCmd({ command: node("console.log('3 tests passed')"), cwd });
  expect(run).toMatchObject({
    status: "pass",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    workTreeChanged: false,
    advisory: true,
  });
  expect(run.tail).toContain("3 tests passed");
});

// Usefulness: verifies a failing command reports its own exit code as a failure,
// not as a pass and not as an error (issue #420).
test("a failing command reports fail with its exit code", async () => {
  const cwd = await repo();
  const run = await runTestCmd({
    command: node("console.error('1 test failed'); process.exit(3)"),
    cwd,
  });
  expect(run).toMatchObject({ status: "fail", exitCode: 3, timedOut: false });
  expect(run.summary).toBe("exit 3");
  expect(run.tail).toContain("1 test failed");
});

// Usefulness: verifies the command runs in the given work tree, which is the
// run's `--cwd` (issue #420).
test("the command runs in the given work tree", async () => {
  const cwd = await repo();
  const run = await runTestCmd({ command: node("console.log(process.cwd())"), cwd });
  const printed = run.tail.trim();
  expect(await readFile(join(printed, "init.txt"), "utf8")).toBe("hello\n");
});

// A command that records its pid and starts a process tree, then hangs. `orphan` starts the grandchild from an intermediate process
// that exits at once, so the grandchild has no live parent: it is reparented away from
// the command, and no walk of the parent links finds it. `trapTerm` makes the command
// exit 0 on SIGTERM, the shape of a runner that cleans up and exits.
async function hangingTree({ orphan = false, trapTerm = false }) {
  const dir = await mkdtemp(join(tmpdir(), "test-cmd-hang-"));
  dirs.push(dir);
  const grandchildPid = join(dir, "grandchild.pid");
  const childPid = join(dir, "child.pid");
  const grandchild = join(dir, "grandchild.js");
  const middle = join(dir, "middle.js");
  const child = join(dir, "child.js");
  const record = (file) =>
    `require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid));`;
  const spawnGrandchild = `require("child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" }).unref();`;
  await writeFile(grandchild, `${record(grandchildPid)}\nsetTimeout(() => {}, 60000);\n`);
  await writeFile(middle, `${spawnGrandchild}\n`);
  const start = orphan
    ? `const mid = require("child_process").spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: "ignore" });\nmid.on("exit", () => setTimeout(() => {}, 60000));`
    : spawnGrandchild;
  await writeFile(
    child,
    `${record(childPid)}\n${start}\n${trapTerm ? 'process.on("SIGTERM", () => process.exit(0));' : ""}\nsetTimeout(() => {}, 60000);\n`,
  );
  return { command: `node "${child}"`, pidFiles: [childPid, grandchildPid] };
}

// Waits until every file holds a pid, so a cancel never precedes the processes it must kill.
async function waitForPidFiles(files) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pids = await Promise.all(
      files.map((file) => readFile(file, "utf8").then(Number.parseInt, () => Number.NaN)),
    );
    if (pids.every(Number.isInteger)) {
      return;
    }
    expect(Date.now() < deadline, "the process tree never started").toBe(true);
    await delay(50);
  }
}

// Both processes record their pids before the bound, or the test fails: a child
// that never ran proves nothing about the kill. The survival check runs before any
// cleanup kill, so a leaked process fails the test, and the cleanup in `finally`
// only keeps a failed test from leaving a process behind.
async function expectAllGone(pidFiles) {
  const pids = [];
  for (const file of pidFiles) {
    const pid = Number.parseInt(await readFile(file, "utf8"), 10);
    expect(Number.isInteger(pid), `${file} holds no pid, so the process never started`).toBe(true);
    pids.push(pid);
  }
  try {
    const deadline = Date.now() + 4000;
    while (pids.some(processExists) && Date.now() < deadline) {
      await delay(50);
    }
    const survivors = pids.filter(processExists);
    expect(survivors, `processes outlived the kill: ${survivors.join(", ")}`).toEqual([]);
  } finally {
    for (const pid of pids.filter(processExists)) {
      process.kill(pid, "SIGKILL");
    }
  }
}

// Usefulness: verifies a command that runs past its bound is reported as timed
// out, never as a failure or a pass, and that the command and the child process
// it started are both gone, so no process stays running (issue #420). The bound
// is 3 seconds, the floor of a whole second plus time for both node processes to
// start on a loaded machine.
test("a timeout kills the command and its child process and reports timed-out", async () => {
  const cwd = await repo();
  const { command, pidFiles } = await hangingTree({});
  const run = await runTestCmd({ command, timeoutSeconds: 3, cwd });
  expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
  expect(run.summary).toContain("neither a pass nor a failure");
  expect(run.summary).toContain("an orphan that left it can survive");
  await expectAllGone(pidFiles);
}, 20_000);

// Usefulness: verifies a timed-out result carries exitCode null whatever the
// command exits with after the kill signal, as the ADR and the docs state, so a
// parent never reads a timeout as the exit code of a runner that trapped the
// signal and exited 0 (issue #420 review).
test("a timed-out command reports exitCode null even when it exits 0 on the signal", async () => {
  const cwd = await repo();
  const { command, pidFiles } = await hangingTree({ trapTerm: true });
  const run = await runTestCmd({ command, timeoutSeconds: 3, cwd });
  expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
  expect(run.summary).not.toContain("exit 0");
  await expectAllGone(pidFiles);
}, 20_000);

// Usefulness: verifies a timeout kills an orphan that stayed in the process group of the
// command, the group the runtime creates and owns. The guarantee differs by platform: POSIX
// reaches the orphan through the group, and Windows has no group and reaches only the live
// parent links, so the maintainer-approved limit of ADR 0017 keeps an orphan there (issue
// #420, approved 2026-10-04).
test.skipIf(process.platform === "win32")(
  "POSIX only: a timeout kills an orphan that stayed in the process group of the command",
  async () => {
    const cwd = await repo();
    const { command, pidFiles } = await hangingTree({ orphan: true });
    const run = await runTestCmd({ command, timeoutSeconds: 3, cwd });
    expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
    await expectAllGone(pidFiles);
  },
  20_000,
);

// Usefulness: verifies a cancel kills the command and its child on every platform, so an
// aborted run leaves no process of the tree behind (issue #420).
test("a cancel kills the command and its child process", async () => {
  const cwd = await repo();
  const { command, pidFiles } = await hangingTree({});
  const controller = new AbortController();
  const pending = runTestCmd({ command, timeoutSeconds: 60, cwd, signal: controller.signal });
  const outcome = pending.catch((err) => err);
  await waitForPidFiles(pidFiles);
  controller.abort();
  expect(await outcome).toMatchObject({ isCanceled: true });
  await expectAllGone(pidFiles);
}, 30_000);

// Usefulness: verifies a cancel still compares the work tree and carries the result on
// the error, so a write the command made before the cancel is reported and not lost
// (issue #420 review of aa0b25e).
test("a cancel reports the work tree change the command made before it", async () => {
  const cwd = await repo();
  const controller = new AbortController();
  const pending = runTestCmd({
    command: node("require('fs').writeFileSync('early.txt', 'x'); setTimeout(() => {}, 60000)"),
    cwd,
    signal: controller.signal,
  });
  const outcome = pending.catch((err) => err);
  const deadline = Date.now() + 10_000;
  while (!(await readFile(join(cwd, "early.txt"), "utf8").catch(() => null))) {
    expect(Date.now() < deadline, "the command never wrote its file").toBe(true);
    await delay(50);
  }
  controller.abort();
  const error = await outcome;
  expect(error.isCanceled).toBe(true);
  expect(error.testRun.summary).toContain("an orphan that left it can survive");
  expect(error.testRun).toMatchObject({
    status: "canceled",
    exitCode: null,
    workTreeChanged: true,
    changedPaths: ["early.txt"],
  });
}, 20_000);

// Usefulness: verifies an output far over the capture window is cut to the tail,
// keeps the end of the output, and reports the cut, so a noisy suite cannot
// exhaust memory or the reviewer prompt (issue #420).
test("an output over the cap is cut to its tail", async () => {
  const cwd = await repo();
  const run = await runTestCmd({
    command: node("for (let i = 0; i < 20000; i++) console.log('line ' + i)"),
    cwd,
  });
  expect(run.status).toBe("pass");
  expect(run.truncated).toBe(true);
  expect(run.outputBytes).toBeGreaterThan(200_000);
  expect(run.tail.length).toBeLessThanOrEqual(TAIL_CHARS);
  expect(run.tail.trimEnd().endsWith("line 19999")).toBe(true);
  expect(run.tail).not.toContain("line 0\n");
});

// Usefulness: verifies a command that writes to the work tree is reported with
// the changed paths, a created file and an edited tracked file alike, so the
// writes do not silently become the reviewer baseline (issue #420).
test("a command that changes the work tree reports the changed paths", async () => {
  const cwd = await repo();
  const run = await runTestCmd({
    command: node(
      "const fs = require('fs'); fs.writeFileSync('new.txt', 'x'); fs.appendFileSync('init.txt', 'y')",
    ),
    cwd,
  });
  expect(run).toMatchObject({ status: "pass", workTreeChanged: true, changedCount: 2 });
  expect(run.changedPaths).toEqual(["init.txt", "new.txt"]);
});

// Usefulness: verifies a command that leaves the work tree as it found it
// reports no change, so the report is not noise on every run (issue #420).
test("a command that leaves the work tree alone reports no change", async () => {
  const cwd = await repo();
  const run = await runTestCmd({ command: node("console.log('ok')"), cwd });
  expect(run).toMatchObject({ workTreeChanged: false, changedPaths: [], changedCount: 0 });
});

// Usefulness: verifies the value of a secret-named environment variable never
// reaches the tail or the reported command, because the tail goes to a model and
// a transcript (issue #420).
test("a secret-named environment value is redacted from the tail and the command", async () => {
  const cwd = await repo();
  process.env.TEST_CMD_PROBE_TOKEN = "probe-secret-value-123";
  try {
    const run = await runTestCmd({
      command: node("console.log(process.env.TEST_CMD_PROBE_TOKEN)"),
      cwd,
    });
    expect(run.tail).toContain("[redacted:TEST_CMD_PROBE_TOKEN]");
    expect(run.tail).not.toContain("probe-secret-value-123");
    const inline = await runTestCmd({
      command: `${node("console.log('x')")} probe-secret-value-123`,
      cwd,
    });
    expect(inline.command).not.toContain("probe-secret-value-123");
  } finally {
    delete process.env.TEST_CMD_PROBE_TOKEN;
  }
});

// Usefulness: verifies a short value is never redacted, because a short value
// would match ordinary words and destroy the tail (issue #420).
test("a short secret-named value is not redacted", () => {
  expect(redactEnvSecrets("a 1234 b", { MY_TOKEN: "1234" })).toBe("a 1234 b");
});

// Usefulness: verifies a canceled run throws a cancel the caller already handles
// and leaves no command running (issue #420).
test("an abort signal cancels the command", async () => {
  const cwd = await repo();
  const controller = new AbortController();
  const pending = runTestCmd({
    command: node("setTimeout(() => {}, 60000)"),
    cwd,
    signal: controller.signal,
  });
  await delay(300);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
}, 20_000);
