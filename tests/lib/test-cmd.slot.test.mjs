import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runTestCmd } from "../../src/lib/test-cmd.mjs";
import { exists, removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

// The `--test-cmd` run inside a machine-wide test slot (issue #848, ADR 0040). Each test points
// the slot directory at a scratch directory of its own and drops any marker that a wrapped test
// run passed down, so the runtime acquires a slot as a run outside any wrapper does.

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url)).replaceAll("\\", "/");
const SLOT_ENV = [
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_TEST_SLOTS",
  "AGENT_LOOP_TEST_SLOT_WAIT",
  "AGENT_LOOP_TEST_SLOT_HELD",
];
// Captured per test, after the file isolation has unset an inherited root pin, so the restore never reinstates it (issue #1022).
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(SLOT_ENV.map((name) => [name, process.env[name]]));
});
const dirs = [];
afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const dir of dirs.splice(0)) {
    await removePath(dir);
  }
});

const slash = (path) => path.replaceAll("\\", "/");

// A work tree, a scratch directory with the helper scripts, and one slot.
async function setup() {
  const cwd = await createTempRepo();
  const scratch = await mkdtemp(join(tmpdir(), "test-cmd-slot-"));
  dirs.push(cwd, scratch);
  // Creates the file named by its first argument, or exits 9 when it exists, then removes it
  // after the given time: two commands that overlap make one of them exit 9.
  await writeFile(
    join(scratch, "busy.js"),
    "const fs = require('fs');\n" +
      "try { fs.writeFileSync(process.argv[2], '', { flag: 'wx' }); } catch { process.exit(9); }\n" +
      "setTimeout(() => fs.unlinkSync(process.argv[2]), Number(process.argv[3]));\n",
  );
  await writeFile(
    join(scratch, "mark.js"),
    "require('fs').writeFileSync(process.argv[2], 'ran');\n",
  );
  delete process.env.AGENT_LOOP_TEST_SLOT_HELD;
  delete process.env.AGENT_LOOP_TEST_SLOT_WAIT;
  process.env.AGENT_LOOP_TEST_SLOTS_ROOT = join(scratch, "slots");
  process.env.AGENT_LOOP_TEST_SLOTS = "1";
  const busy = (ms) =>
    `node "${slash(join(scratch, "busy.js"))}" "${slash(join(scratch, "busy"))}" ${ms}`;
  const ranFile = join(scratch, "ran");
  const mark = `node "${slash(join(scratch, "mark.js"))}" "${slash(ranFile)}"`;
  return { cwd, scratch, busy, mark, ranFile };
}

// Starts a command that holds the only slot for `ms`, and resolves once that command runs. The
// pending run is wrapped, so the caller does not wait for it to end.
async function holdSlot({ cwd, scratch, busy }, ms) {
  const holder = runTestCmd({ command: busy(ms), cwd });
  while (!(await exists(join(scratch, "busy")))) {
    await delay(20);
  }
  return { holder };
}

// Usefulness: verifies the runtime runs `--test-cmd` inside a slot, so two runs that share one
// slot never run their commands at the same time (issue #848 acceptance 1).
test("two commands that share one slot run one after the other", async () => {
  const ctx = await setup();
  const runs = await Promise.all([
    runTestCmd({ command: ctx.busy(800), cwd: ctx.cwd }),
    runTestCmd({ command: ctx.busy(800), cwd: ctx.cwd }),
  ]);
  expect(runs.map((run) => run.status)).toEqual(["pass", "pass"]);
});

// Usefulness: verifies a slot wait that reaches its own bound reports the distinct advisory
// status and runs no command, so a busy host is neither a pass nor a failure (issue #848
// acceptance 2).
test("a slot wait that reaches its bound reports slot-timeout and runs no command", async () => {
  const ctx = await setup();
  const { holder } = await holdSlot(ctx, 2000);
  process.env.AGENT_LOOP_TEST_SLOT_WAIT = "0.3";
  const run = await runTestCmd({ command: ctx.mark, cwd: ctx.cwd, timeoutSeconds: 600 });
  expect(run).toMatchObject({
    status: "slot-timeout",
    exitCode: null,
    timedOut: false,
    workTreeChanged: false,
    advisory: true,
  });
  expect(run.summary).toMatch(/did not run/);
  expect(run.summary).toMatch(/neither a pass nor a failure/);
  expect(await exists(ctx.ranFile)).toBe(false);
  expect((await holder).status).toBe("pass");
});

// Usefulness: verifies a cancel during the slot wait ends the turn as a cancel, runs no command,
// and leaks no slot, so a later run still wins the slot at once (issue #848).
test("a cancel during the slot wait throws a cancel and leaks no slot", async () => {
  const ctx = await setup();
  const { holder } = await holdSlot(ctx, 1500);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const err = await runTestCmd({ command: ctx.mark, cwd: ctx.cwd, signal: controller.signal })
    .then(() => null)
    .catch((caught) => caught);
  expect(err?.isCanceled).toBe(true);
  expect(err.testRun).toMatchObject({ status: "canceled", exitCode: null, advisory: true });
  expect(await exists(ctx.ranFile)).toBe(false);
  expect((await holder).status).toBe("pass");
  process.env.AGENT_LOOP_TEST_SLOT_WAIT = "0";
  expect((await runTestCmd({ command: ctx.mark, cwd: ctx.cwd })).status).toBe("pass");
});

// Usefulness: verifies a `--test-cmd` that calls the wrapper itself runs at once inside the slot
// the runtime holds, so an operator command that already uses the wrapper cannot deadlock.
test("a wrapper call inside the command runs inside the held slot", async () => {
  const ctx = await setup();
  const run = await runTestCmd({
    command: `node "${CLI}" test-slot --slots 1 --wait 0 -- "node --version"`,
    cwd: ctx.cwd,
  });
  expect(run).toMatchObject({ status: "pass", exitCode: 0 });
});

// Usefulness: verifies a slot that cannot be acquired fails closed: the command does not run
// unthrottled, and the result says so as an advisory error.
test("an invalid slot setting runs no command and reports an error", async () => {
  const ctx = await setup();
  process.env.AGENT_LOOP_TEST_SLOTS = "many";
  const run = await runTestCmd({ command: ctx.mark, cwd: ctx.cwd });
  expect(run).toMatchObject({ status: "error", exitCode: null, advisory: true });
  expect(run.summary).toMatch(/did not run/);
  expect(await exists(ctx.ranFile)).toBe(false);
});
