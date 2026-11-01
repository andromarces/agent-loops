import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

// The mocked child never exits after the runtime kill, so only the kill bound can settle the run
// (issue #1307). Git reads still go to the real execa, so the snapshots run against a real repo.
const state = vi.hoisted(() => ({ mode: "stuck", child: null, command: "stuck-command" }));

vi.mock("execa", async () => {
  const actual = await vi.importActual("execa");
  const { EventEmitter } = await import("node:events");
  const settled = (exitCode) => {
    const done = Promise.resolve({ exitCode, stdout: "", stderr: "" });
    return {
      pid: 4343,
      exitCode,
      stdout: "",
      stderr: "",
      kill: vi.fn(() => true),
      all: new EventEmitter(),
      // oxlint-disable-next-line unicorn/no-thenable -- execa returns a thenable subprocess
      then: (...callbacks) => done.then(...callbacks),
      catch: (...callbacks) => done.catch(...callbacks),
      finally: (...callbacks) => done.finally(...callbacks),
    };
  };
  const stuck = () => {
    const never = new Promise(() => {});
    const child = {
      pid: 4242,
      kill: vi.fn(() => true),
      all: new EventEmitter(),
      nodeChildProcess: new EventEmitter(),
      // oxlint-disable-next-line unicorn/no-thenable -- execa returns a thenable subprocess
      then: (...callbacks) => never.then(...callbacks),
      catch: (...callbacks) => never.catch(...callbacks),
      finally: (...callbacks) => never.finally(...callbacks),
    };
    state.child = child;
    return child;
  };
  return {
    execa: vi.fn((command, args, options) =>
      command === state.command
        ? state.mode === "quick"
          ? settled(0)
          : stuck()
        : actual.execa(command, args, options),
    ),
  };
});

import { runTestCmd } from "../../src/lib/test-cmd.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

const SLOT_ENV = [
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_TEST_SLOTS",
  "AGENT_LOOP_TEST_SLOT_WAIT",
  "AGENT_LOOP_TEST_SLOT_HELD",
];
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

// A work tree and a slot directory of this test, with the command child in the stuck mode.
async function setup() {
  const cwd = await createTempRepo();
  const slotsRoot = await mkdtemp(join(tmpdir(), "test-cmd-kill-bound-slots-"));
  dirs.push(cwd, slotsRoot);
  process.env.AGENT_LOOP_TEST_SLOTS_ROOT = slotsRoot;
  process.env.AGENT_LOOP_TEST_SLOTS = "1";
  delete process.env.AGENT_LOOP_TEST_SLOT_HELD;
  delete process.env.AGENT_LOOP_TEST_SLOT_WAIT;
  state.mode = "stuck";
  state.child = null;
  return cwd;
}

// Waits until the command child exists, so a cancel lands on a started command, not on the slot wait.
const waitForChild = () =>
  vi.waitFor(() => expect(state.child).not.toBeNull(), { timeout: 10_000 });

// Usefulness: a command that survives the timeout kill must still settle as timed-out with a null
// exit code, so the reviewer dispatch never waits on it (issue #1307 acceptance).
test("a test command that survives the timeout kill settles as timed-out", async () => {
  const cwd = await setup();
  const run = await runTestCmd({ command: "stuck-command", timeoutSeconds: 0.05, cwd });
  expect(run).toMatchObject({
    status: "timed-out",
    timedOut: true,
    exitCode: null,
    workTreeChanged: false,
    changedPaths: [],
    changedCount: 0,
  });
  const child = state.child;
  child.nodeChildProcess.emit("exit", 0, null);
  expect(run.status).toBe("timed-out");
  // The bound released the slot, so a later run wins it at once instead of waiting.
  process.env.AGENT_LOOP_TEST_SLOT_WAIT = "0";
  state.mode = "quick";
  expect((await runTestCmd({ command: "stuck-command", cwd })).status).toBe("pass");
}, 30_000);

// Usefulness: a command that survives the cancel kill must settle as canceled with a null exit
// code, so a cancel ends the reviewer dispatch (issue #1307 acceptance).
test("a test command that survives the cancel kill settles as canceled", async () => {
  const cwd = await setup();
  const controller = new AbortController();
  const pending = runTestCmd({
    command: "stuck-command",
    timeoutSeconds: 600,
    cwd,
    signal: controller.signal,
  });
  const outcome = pending.catch((err) => err);
  await waitForChild();
  controller.abort();
  const error = await outcome;
  expect(error.isCanceled).toBe(true);
  expect(error.testRun).toMatchObject({
    status: "canceled",
    timedOut: false,
    exitCode: null,
    workTreeChanged: false,
  });
  // The cancel released the slot, so a later run wins it at once instead of waiting.
  process.env.AGENT_LOOP_TEST_SLOT_WAIT = "0";
  state.mode = "quick";
  expect((await runTestCmd({ command: "stuck-command", cwd })).status).toBe("pass");
}, 30_000);
