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

// Usefulness: verifies a command that runs past its bound is reported as timed
// out, never as a failure or a pass, and that the command and the child process
// it started are both gone, so no process stays running (issue #420). Both
// processes record their pids before the bound, or the test fails: a child that
// never ran proves nothing about the kill.
test("a timeout kills the command and its child process and reports timed-out", async () => {
  const cwd = await repo();
  const dir = await mkdtemp(join(tmpdir(), "test-cmd-hang-"));
  dirs.push(dir);
  const grandchildPid = join(dir, "grandchild.pid");
  const childPid = join(dir, "child.pid");
  const grandchild = join(dir, "grandchild.js");
  const child = join(dir, "child.js");
  await writeFile(
    grandchild,
    `require("fs").writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid));
setTimeout(() => {}, 60000);
`,
  );
  await writeFile(
    child,
    `require("fs").writeFileSync(${JSON.stringify(childPid)}, String(process.pid));
require("child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });
setTimeout(() => {}, 60000);
`,
  );

  // The bound is 3 seconds, a floor of a whole second: it leaves both node
  // processes time to start on a loaded machine.
  const run = await runTestCmd({ command: `node "${child}"`, timeoutSeconds: 3, cwd });
  expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
  expect(run.summary).toContain("neither a pass nor a failure");

  const pids = [];
  for (const file of [childPid, grandchildPid]) {
    const pid = Number.parseInt(await readFile(file, "utf8"), 10);
    expect(Number.isInteger(pid), `${file} holds no pid, so the process never started`).toBe(true);
    pids.push(pid);
  }
  const deadline = Date.now() + 4000;
  while (pids.some(processExists) && Date.now() < deadline) {
    await delay(50);
  }
  for (const pid of pids) {
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
    }
    expect(processExists(pid), `process ${pid} outlived the timeout`).toBe(false);
  }
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
