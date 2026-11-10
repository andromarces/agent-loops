import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { removePath, trackedTempDir } from "../fs-helpers.mjs";
import { deadPid, processExists } from "../process-helpers.mjs";

// Delays each in-process lock attempt by `ms`, so a test can make one acquisition pass end
// after the wait bound. With `failTableRelease`, the release of the short acquisition lock
// removes the lock and then throws. With `failSlotLock`, an attempt on a slot file throws.
// Every spawned wrapper uses the real module.
const slowLock = vi.hoisted(() => ({ ms: 0, failTableRelease: false, failSlotLock: false }));
vi.mock("../../src/lib/state-lock.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    tryStateLock: async (lockFile, ...rest) => {
      await new Promise((resolve) => setTimeout(resolve, slowLock.ms));
      if (slowLock.failSlotLock && !lockFile.endsWith("acquire.lock")) {
        throw new Error("slot lock failed");
      }
      const release = await real.tryStateLock(lockFile, ...rest);
      if (release && slowLock.failTableRelease && lockFile.endsWith("acquire.lock")) {
        return async () => {
          await release();
          throw new Error("release failed");
        };
      }
      return release;
    },
  };
});

// Lets a test set the CPU count that the in-process module reads.
const hostCpus = vi.hoisted(() => ({ count: null }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, availableParallelism: () => hostCpus.count ?? real.availableParallelism() };
});

import { parseTestSlotArgs, runTestSlot } from "../../src/lib/test-slot-cli.mjs";
import { holdTestSlot } from "../../src/lib/test-slot.mjs";

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
const SLOT_ENV = [
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_TEST_SLOTS",
  "AGENT_LOOP_TEST_SLOT_WAIT",
  "AGENT_LOOP_TEST_SLOT_HELD",
];

const dirs = [];
// Captured per test, after the file isolation has unset an inherited root pin, so the restore never reinstates it (issue #1022).
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(SLOT_ENV.map((name) => [name, process.env[name]]));
});
afterEach(async () => {
  hostCpus.count = null;
  slowLock.ms = 0;
  slowLock.failTableRelease = false;
  slowLock.failSlotLock = false;
  vi.restoreAllMocks();
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

// A work directory with a slot root inside it. Commands are script files in the work
// directory, so no command text needs quoting inside a shell argument.
async function setup(scripts = {}) {
  const cwd = await trackedTempDir("test-slot-", dirs);
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(cwd, name), body, "utf8");
  }
  return { cwd, root: join(cwd, "slots") };
}

// Starts `agent-loop test-slot` as its own process. A marker or override inherited from a
// wrapped test run is dropped, so each test sets exactly the environment it names. A case that
// tests process behavior, such as a signal or a nested wrapper, keeps this spawn.
function wrapper(args, { cwd, root, env = {} }) {
  const base = { ...process.env };
  for (const name of SLOT_ENV) {
    delete base[name];
  }
  const child = spawn(process.execPath, [CLI, "test-slot", ...args], {
    cwd,
    env: { ...base, AGENT_LOOP_TEST_SLOTS_ROOT: root, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stderr })),
  );
  return { child, done };
}

async function holdSlot(root, owner, index = 0) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `slot-${index}.lock`), JSON.stringify(owner), "utf8");
}

const liveOwner = (nonce = "live") => ({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  nonce,
});

const MARK = "import { writeFileSync } from 'node:fs';\nwriteFileSync('mark', 'x');\n";
const HANG =
  "import { writeFileSync } from 'node:fs';\n" +
  "writeFileSync('pid', String(process.pid));\n" +
  "setTimeout(() => {}, 60_000);\n";

// Points the in-process wrapper at `ctx` and returns a command that runs `script` with
// `ctx.cwd` as its directory, so the run needs no change of the worker's directory.
function inProcess(ctx, script) {
  process.env.AGENT_LOOP_TEST_SLOTS_ROOT = ctx.root;
  for (const name of SLOT_ENV.slice(1)) {
    delete process.env[name];
  }
  return `node -e "process.chdir(process.argv[1]); import(require('url').pathToFileURL(process.argv[2]).href)" "${ctx.cwd}" "${join(ctx.cwd, script)}"`;
}

// Runs the wrapper in this process for a case that tests slot logic but no process behavior.
// A marker or override inherited from a wrapped test run is dropped, as `wrapper` drops it.
function runInProcess(ctx, args, env = {}) {
  for (const name of SLOT_ENV) delete process.env[name];
  process.env.AGENT_LOOP_TEST_SLOTS_ROOT = ctx.root;
  Object.assign(process.env, env);
  return runTestSlot(args);
}

// Holds a slot in this process for a case that asserts the slot decision and runs no command.
function holdInProcess(ctx, { ifHeld = false, slots = 1, waitSeconds = 10 } = {}, env = {}) {
  for (const name of SLOT_ENV) delete process.env[name];
  process.env.AGENT_LOOP_TEST_SLOTS_ROOT = ctx.root;
  Object.assign(process.env, env);
  return holdTestSlot({ slots, waitSeconds, ifHeld, signal: new AbortController().signal });
}

const waitForFile = (path, ms = 10_000) =>
  vi.waitFor(() => expect(existsSync(path), `${path} did not appear`).toBe(true), {
    timeout: ms,
    interval: 50,
  });

// Usefulness: acceptance (#847) — with one slot, two concurrent wrappers run their
// commands one after the other, which is the whole point of the slot.
// In process: both callers are holdTestSlot, so the serialization starts no command.
test("with --slots 1, two concurrent wrappers run their commands one after the other", async () => {
  const ctx = await setup();
  const first = await holdInProcess(ctx, { slots: 1 });
  expect(first).not.toBeNull();

  const logs = [];
  for (const name of ["log", "error"]) {
    vi.spyOn(console, name).mockImplementation((line) => logs.push(String(line)));
  }
  const waiting = holdInProcess(ctx, { slots: 1 });
  await vi.waitFor(() => expect(logs.join("\n")).toMatch(/waiting for a test slot/));
  // The second caller holds no slot while the first holds the only one.
  expect(existsSync(join(ctx.root, "slot-1.lock"))).toBe(false);

  await first.release();
  const second = await waiting;
  expect(second).not.toBeNull();
  await second.release();
}, 60_000);

// Usefulness: acceptance (#847) — a slot left by a process that no longer exists is
// reclaimed, so a crashed wrapper cannot block every later run until the wait bound.
// In process: the reclaimed slot name and owner are the whole outcome.
test("a slot left by a dead process is reclaimed", async () => {
  const ctx = await setup();
  await holdSlot(ctx.root, {
    pid: await deadPid(),
    startedAt: new Date().toISOString(),
    nonce: "n",
  });
  const slot = await holdInProcess(ctx, { slots: 1 });
  expect(slot).not.toBeNull();
  expect(JSON.parse(await readFile(join(ctx.root, "slot-0.lock"), "utf8")).pid).toBe(process.pid);
  await slot.release();
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
});

// Usefulness: acceptance (#847) — at the wait bound the command does not run and the
// wrapper exits 75; the environment overrides of the slot count and the bound apply.
test("at the wait bound the command does not run and the wrapper exits 75", async () => {
  const ctx = await setup({
    "mark.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('mark', 'x');\n",
  });
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: "live" };
  await holdSlot(ctx.root, owner);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const code = await runInProcess(ctx, ["--", inProcess(ctx, "mark.mjs")], {
    AGENT_LOOP_TEST_SLOTS: "1",
    AGENT_LOOP_TEST_SLOT_WAIT: "0.05",
  });
  expect(code).toBe(75);
  expect(errors.mock.calls.flat().join("\n")).toMatch(/no test slot/i);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  expect(JSON.parse(await readFile(join(ctx.root, "slot-0.lock"), "utf8"))).toEqual(owner);
});

// Usefulness: acceptance (#847) — the wrapper exits with the exit code of the command and
// frees the slot, so a caller reads the test result through the wrapper.
// Process: only a separate CLI process reports the command's exit code to its caller.
test("the wrapper exits with the command's exit code and releases the slot", async () => {
  const ctx = await setup({ "exit7.mjs": "process.exit(7);\n" });
  const { done } = wrapper(["--slots", "1", "--wait", "10", "--", "node exit7.mjs"], ctx);
  expect((await done).code).toBe(7);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
});

// Usefulness: issue #1673 — the argument-vector form spawns the executable with its arguments
// without a shell, so an argument holding a shell metacharacter reaches the program unchanged,
// and the wrapper keeps the command exit code and frees the slot.
test("the argument-vector form runs without a shell and keeps the exit code", async () => {
  const ctx = await setup({
    "argv.mjs":
      "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n" +
      "process.exit(7);\n",
  });
  const { done } = wrapper(
    ["--slots", "1", "--wait", "10", "--", process.execPath, "argv.mjs", "a b", "$HOME", ";"],
    ctx,
  );
  expect((await done).code).toBe(7);
  expect(JSON.parse(await readFile(join(ctx.cwd, "argv.json"), "utf8"))).toEqual([
    "a b",
    "$HOME",
    ";",
  ]);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
});

// Usefulness: acceptance (#847) — a nested wrapper inside a wrapped command runs at once
// instead of waiting on the slot its parent holds, so it cannot deadlock.
// Process: the nested wrapper is a second CLI process inside the wrapped command.
test("a nested wrapper inside a wrapped command runs without waiting", async () => {
  const ctx = await setup({
    "mark.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('mark', 'x');\n",
  });
  const inner = `node "${CLI}" test-slot --slots 1 --wait 1 -- "node mark.mjs"`;
  const { done } = wrapper(["--slots", "1", "--wait", "10", "--", inner], ctx);
  const result = await done;
  expect(result.code).toBe(0);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(true);
}, 30_000);

// Usefulness: acceptance (#847) — a signal ends the command's tree before the slot is
// freed, so no test process keeps running outside a slot. Windows has no catchable
// SIGTERM for an outside sender, so the check runs on POSIX.
// Process: an outside signal must reach a separate wrapper process.
test.skipIf(process.platform === "win32")(
  "SIGTERM ends the command tree and releases the slot",
  async () => {
    const ctx = await setup({
      "hang.mjs":
        "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync('pid', String(process.pid));\n" +
        "setTimeout(() => {}, 60_000);\n",
    });
    const { child, done } = wrapper(["--slots", "1", "--wait", "10", "--", "node hang.mjs"], ctx);
    await waitForFile(join(ctx.cwd, "pid"));
    const pid = Number(await readFile(join(ctx.cwd, "pid"), "utf8"));
    child.kill("SIGTERM");
    const result = await done;
    expect(result.code).toBe(143);
    // A killed child can stay a zombie until its new parent reaps it, so the check polls.
    const deadline = Date.now() + 5000;
    while (processExists(pid) && Date.now() < deadline) {
      await delay(50);
    }
    expect(processExists(pid)).toBe(false);
    expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
  },
  30_000,
);

// Usefulness: an invalid slot count is refused before any wait or command, with the
// documented usage code, so a typo never runs the suite unguarded.
test("an invalid --slots value exits 64 without running the command", async () => {
  const ctx = await setup({
    "mark.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('mark', 'x');\n",
  });
  const code = await runInProcess(ctx, ["--slots", "0", "--", inProcess(ctx, "mark.mjs")]);
  expect(code).toBe(64);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
});

// Usefulness: issue #847 contract — a caller starts only while fewer than its own N slots are
// held by live owners, so an N=1 caller waits while an N=2 caller holds any slot.
// In process: the held slot and the returned slot are the whole outcome.
test("a caller with --slots 1 waits while another caller holds any slot", async () => {
  const ctx = await setup();
  await holdSlot(ctx.root, liveOwner(), 1);
  expect(await holdInProcess(ctx, { slots: 1, waitSeconds: 0.05 })).toBeNull();
  const two = await holdInProcess(ctx, { slots: 2 });
  expect(two).not.toBeNull();
  await two.release();
}, 30_000);

// Usefulness: issue #847 review — a nested-call marker that names no slot held by a live
// owner is ignored, so an exported or leftover marker cannot bypass the throttle.
test.each([
  ["a hand-exported marker", () => "1"],
  [
    "a marker whose holder exited",
    (root) => JSON.stringify({ lock: join(root, "slot-0.lock"), nonce: "gone" }),
  ],
])("%s does not bypass the slot", async (_name, marker) => {
  const ctx = await setup();
  const dead = { pid: await deadPid(), startedAt: new Date().toISOString(), nonce: "gone" };
  await holdSlot(ctx.root, dead);
  await holdSlot(ctx.root, liveOwner(), 1);
  // In process: `holdTestSlot` reads the marker, so the decision needs no command.
  expect(
    await holdInProcess(
      ctx,
      { slots: 1, waitSeconds: 0.05 },
      { AGENT_LOOP_TEST_SLOT_HELD: marker(ctx.root) },
    ),
  ).toBeNull();
});

// Usefulness: issue #847 review — when the outer wrapper ends its command tree, the command
// of a nested wrapper ends too, so no test process outlives the slot. POSIX only: the
// defect is a separate process group, and Windows has no catchable outside SIGTERM.
// Process: the signal must cross two wrapper processes.
test.skipIf(process.platform === "win32")(
  "SIGTERM to the outer wrapper ends the command of a nested wrapper",
  async () => {
    const ctx = await setup({ "hang.mjs": HANG });
    const inner = `node "${CLI}" test-slot --slots 1 --wait 5 -- "node hang.mjs"`;
    const { child, done } = wrapper(["--slots", "1", "--wait", "10", "--", inner], ctx);
    await waitForFile(join(ctx.cwd, "pid"));
    const pid = Number(await readFile(join(ctx.cwd, "pid"), "utf8"));
    child.kill("SIGTERM");
    expect((await done).code).toBe(143);
    const deadline = Date.now() + 5000;
    while (processExists(pid) && Date.now() < deadline) {
      await delay(50);
    }
    expect(processExists(pid)).toBe(false);
  },
  30_000,
);

// Usefulness: issue #847 review — a nested wrapper that a signal reaches exits with the
// documented signal code, not the code of the killed command.
// Process: the command must run in a child so the signal can end it.
test("a nested wrapper ended by SIGTERM exits 143", async () => {
  const ctx = await setup({ "hang.mjs": HANG });
  const command = inProcess(ctx, "hang.mjs");
  await holdSlot(ctx.root, liveOwner("outer"));
  process.env.AGENT_LOOP_TEST_SLOT_HELD = JSON.stringify({
    lock: join(ctx.root, "slot-0.lock"),
    nonce: "outer",
  });
  const run = runTestSlot(["--slots", "1", "--wait", "5", "--", command]);
  await waitForFile(join(ctx.cwd, "pid"));
  process.emit("SIGTERM", "SIGTERM");
  expect(await run).toBe(143);
}, 30_000);

// Usefulness: issue #847 review — an acquisition that ends after the wait bound never
// starts the command, so the bound holds even when one pass is slow.
test("a slot won after the wait bound does not run the command", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  const command = inProcess(ctx, "mark.mjs");
  slowLock.ms = 120;
  expect(await runTestSlot(["--slots", "1", "--wait", "0.05", "--", command])).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
}, 30_000);

// Usefulness: verifies the #926 decision: the default is 1 slot on any CPU count, and an
// override still wins. No other test reads the default.
test("the default slot count is 1 on a 16-CPU host, and AGENT_LOOP_TEST_SLOTS overrides it", () => {
  hostCpus.count = 16;
  expect(parseTestSlotArgs(["--", "x"], {}).slots).toBe(1);
  expect(parseTestSlotArgs(["--", "x"], { AGENT_LOOP_TEST_SLOTS: "3" }).slots).toBe(3);
});

// Usefulness: verifies a valid flag wins over an invalid environment value, and the invalid value
// is refused only when no flag replaces it, so one bad variable never blocks a valid call.
test("a valid flag wins over an invalid environment value", () => {
  const env = { AGENT_LOOP_TEST_SLOTS: "many", AGENT_LOOP_TEST_SLOT_WAIT: "-1" };
  expect(parseTestSlotArgs(["--slots", "2", "--wait", "5", "--", "x"], env)).toEqual({
    slots: 2,
    waitSeconds: 5,
    ifHeld: false,
    command: "x",
  });
  expect(() => parseTestSlotArgs(["--wait", "5", "--", "x"], env)).toThrow(/AGENT_LOOP_TEST_SLOTS/);
  expect(() => parseTestSlotArgs(["--slots", "2", "--", "x"], env)).toThrow(
    /AGENT_LOOP_TEST_SLOT_WAIT/,
  );
});

// Usefulness: issue #1673 — two or more arguments after -- form an argument vector that runs
// without a shell, so a Git Bash child passes the suite command with no quoting step; one
// argument keeps the shell-string form.
test("two or more arguments after -- parse as an argument vector, one keeps the string form", () => {
  expect(parseTestSlotArgs(["--", "node", "tests/foo.test.mjs", "run"], {})).toEqual({
    slots: 1,
    waitSeconds: 1800,
    ifHeld: false,
    command: "node",
    args: ["tests/foo.test.mjs", "run"],
  });
  expect(parseTestSlotArgs(["--", "node tests/foo.test.mjs"], {})).toEqual({
    slots: 1,
    waitSeconds: 1800,
    ifHeld: false,
    command: "node tests/foo.test.mjs",
  });
});

// Usefulness: issue #1673 — the vector needs the -- separator, at least two arguments, and a
// non-empty executable, so a malformed call is a usage error instead of a shell run.
test("an argument vector needs -- and a non-empty executable", () => {
  expect(usageRefusal(() => parseTestSlotArgs(["--"], {})).usage).toBe(true);
  expect(usageRefusal(() => parseTestSlotArgs(["node", "x"], {})).usage).toBe(true);
  expect(usageRefusal(() => parseTestSlotArgs(["--", "", "x"], {})).usage).toBe(true);
});

// Usefulness: maintainer decision (#847) — `--wait 0` is one attempt: a free slot is taken now,
// and a held one gives up at once.
// In process: the held slot is the whole outcome, so no command process starts.
test("--wait 0 takes a free slot and gives up on a held one", async () => {
  const ctx = await setup();
  const free = await holdInProcess(ctx, { slots: 1, waitSeconds: 0 });
  expect(free).not.toBeNull();
  await free.release();
  await holdSlot(ctx.root, liveOwner());
  expect(await holdInProcess(ctx, { slots: 1, waitSeconds: 0 })).toBeNull();
}, 30_000);

// Usefulness: issue #847 review — a slot file that cannot be read counts as held, so a caller
// never takes a free index while the unreadable slot may belong to a live holder. A directory
// at the slot path is unreadable as a file on every platform.
test("an unreadable slot file counts as held", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  await mkdir(join(ctx.root, "slot-1.lock"), { recursive: true });
  const code = await runInProcess(ctx, [
    "--slots",
    "1",
    "--wait",
    "1",
    "--",
    inProcess(ctx, "mark.mjs"),
  ]);
  expect(code).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
}, 30_000);

// Usefulness: issue #847 review — a slot won exactly at the wait bound does not run the
// command, so the command starts only strictly before the bound.
test("a slot won exactly at the wait bound does not run the command", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  const command = inProcess(ctx, "mark.mjs");
  const start = Date.now();
  // The first reading sets the bound; every later reading is exactly at it.
  vi.spyOn(Date, "now")
    .mockReturnValueOnce(start)
    .mockReturnValue(start + 1000);
  expect(await runTestSlot(["--slots", "1", "--wait", "1", "--", command])).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
}, 30_000);

// Usefulness: issue #847 review — a failed release of the short acquisition lock frees the
// slot it took and exits 1 without running the command, so no slot leaks.
test("a failed acquisition-lock release frees the slot and exits 1", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  const command = inProcess(ctx, "mark.mjs");
  slowLock.failTableRelease = true;
  expect(await runTestSlot(["--slots", "1", "--wait", "5", "--", command])).toBe(1);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
}, 30_000);

// Usefulness: issue #847 review — when the slot claim fails and the acquisition-lock release
// also fails, the wrapper reports both errors, so the release failure never hides the cause.
test("a failed slot claim and a failed acquisition-lock release are both reported", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  const command = inProcess(ctx, "mark.mjs");
  slowLock.failSlotLock = true;
  slowLock.failTableRelease = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runTestSlot(["--slots", "1", "--wait", "5", "--", command])).toBe(1);
  const output = errors.mock.calls.flat().join("\n");
  expect(output).toContain("slot lock failed");
  expect(output).toContain("release failed");
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
}, 30_000);

// Usefulness: issue #921 (option 2) — with `--if-held` and all slots free, the caller runs at once
// without a slot, so another caller takes it.
// In process: the returned slot entry is the whole outcome, so no command process starts.
test("--if-held runs at once while all slots are free and leaves the slot to others", async () => {
  const ctx = await setup();
  const direct = await holdInProcess(ctx, { ifHeld: true, waitSeconds: 0 });
  expect(direct).toMatchObject({ nested: false, env: undefined });
  const other = await holdInProcess(ctx, { slots: 1, waitSeconds: 0 });
  expect(other).not.toBeNull();
  await other.release();
}, 30_000);

// Usefulness: issue #921 (option 2) — a held slot makes `--if-held` wait, so a targeted run under
// load gives up at the bound.
test("--if-held waits while a slot is held and gives up at the bound", async () => {
  const ctx = await setup();
  await holdSlot(ctx.root, liveOwner());
  expect(await holdInProcess(ctx, { ifHeld: true, waitSeconds: 0.05 })).toBeNull();
}, 30_000);

// Usefulness: issue #921 (option 2) — any held slot counts, not only a full table: with one of two
// slots held, the caller takes the free slot, so a plain caller at once finds no slot.
test("--if-held runs as a slot holder when one of two slots is held", async () => {
  const ctx = await setup();
  await holdSlot(ctx.root, liveOwner());
  const held = await holdInProcess(ctx, { ifHeld: true, slots: 2, waitSeconds: 5 });
  expect(held.env).toBeDefined();
  expect(held.nested).toBe(false);
  expect(await holdInProcess(ctx, { slots: 2, waitSeconds: 0 })).toBeNull();
  await held.release();
}, 30_000);

// Usefulness: issue #921 (option 2) — a slot left by a dead process is not held, so `--if-held`
// stays direct and a crashed holder never makes edit loops wait.
test("--if-held ignores a slot whose owner is gone", async () => {
  const ctx = await setup();
  await holdSlot(ctx.root, {
    pid: await deadPid(),
    startedAt: new Date().toISOString(),
    nonce: "dead",
  });
  expect(await holdInProcess(ctx, { ifHeld: true, waitSeconds: 0 })).toMatchObject({
    nested: false,
    env: undefined,
  });
}, 30_000);

// Usefulness: issue #921 (option 2) — a missing slot directory means no slot is held, so the
// first targeted run on a host runs directly instead of failing.
test("--if-held runs directly when the slot directory does not exist", async () => {
  const ctx = await setup();
  expect(await holdInProcess(ctx, { ifHeld: true, waitSeconds: 0 })).toMatchObject({
    nested: false,
    env: undefined,
  });
}, 30_000);

// Returns the usage error that `run` throws, so a test checks its flag and message.
function usageRefusal(run) {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a usage refusal");
}

// Usefulness: acceptance (#1469) — the inline form parses to the same options and command as the
// separated form, so every caller can use either spelling.
test("--slots=3 and --wait=0 parse the same as the separated forms", () => {
  const separated = parseTestSlotArgs(["--slots", "3", "--wait", "0", "--", "x"], {});
  expect(parseTestSlotArgs(["--slots=3", "--wait=0", "--", "x"], {})).toEqual(separated);
  expect(separated).toEqual({ slots: 3, waitSeconds: 0, ifHeld: false, command: "x" });
  expect(parseTestSlotArgs(["--slots=3", "--", "run --slots=3"], {})).toEqual({
    slots: 3,
    waitSeconds: 1800,
    ifHeld: false,
    command: "run --slots=3",
  });
});

// Usefulness: acceptance (#1469) — a count above Number.MAX_SAFE_INTEGER rounds in a double.
// The parser refuses that flag value as a usage error instead of accepting a rounded count.
test("a --slots value above Number.MAX_SAFE_INTEGER is refused with usage: true", () => {
  const tooLarge = String(Number.MAX_SAFE_INTEGER + 1);
  const error = usageRefusal(() => parseTestSlotArgs([`--slots=${tooLarge}`, "--", "x"], {}));
  expect(error.usage).toBe(true);
  expect(error.message).toBe(`--slots must be a positive integer, got "${tooLarge}".`);
});

// Usefulness: issue #1469 — the same unsafe count arrives through AGENT_LOOP_TEST_SLOTS, so the
// environment path gets the refusal too and never rounds a slot count.
test("an unsafe AGENT_LOOP_TEST_SLOTS value is refused with usage: true", () => {
  const tooLarge = String(Number.MAX_SAFE_INTEGER + 1);
  const error = usageRefusal(() =>
    parseTestSlotArgs(["--", "x"], { AGENT_LOOP_TEST_SLOTS: tooLarge }),
  );
  expect(error.usage).toBe(true);
  expect(error.message).toBe(
    `AGENT_LOOP_TEST_SLOTS must be a positive integer, got "${tooLarge}".`,
  );
});

// Usefulness: issue #1469 — each inline edge case keeps its refusal, so the new form accepts no
// value that the separated form refuses.
test.each([
  ["--slots=", '--slots must be a positive integer, got "".'],
  ["--wait=", '--wait must be a number of seconds of 0 or more, got "".'],
  ["--slots==3", '--slots must be a positive integer, got "=3".'],
  ["--wait=-1", '--wait must be a number of seconds of 0 or more, got "-1".'],
  ["--slots=0", '--slots must be a positive integer, got "0".'],
  ["--slots=1e3", '--slots must be a positive integer, got "1e3".'],
])("%s is refused as a usage error", (arg, message) => {
  const error = usageRefusal(() => parseTestSlotArgs([arg, "--", "x"], {}));
  expect(error.usage).toBe(true);
  expect(error.message).toBe(message);
});

// Usefulness: issue #1469 — a repeated flag in both forms keeps the last value, as the separated
// loop already does. The inline form adds no new precedence rule.
test("a repeated --slots flag in both forms keeps the last value", () => {
  expect(parseTestSlotArgs(["--slots", "2", "--slots=3", "--", "x"], {}).slots).toBe(3);
  expect(parseTestSlotArgs(["--slots=3", "--slots", "2", "--", "x"], {}).slots).toBe(2);
});

// Usefulness: issue #1469 — a boolean flag keeps its plain unknown-option refusal, so the inline
// value belongs to the value flags only.
test("--if-held=1 keeps its unknown-option refusal", () => {
  const error = usageRefusal(() => parseTestSlotArgs(["--if-held=1", "--", "x"], {}));
  expect(error.usage).toBe(true);
  expect(error.message).toBe("Unknown option --if-held=1.");
});

// Usefulness: issue #1469 — help wins after an inline value flag, as it does after the separated
// form. An inline flag before --help does not hide the help text.
test("--help after an inline value flag prints help", () => {
  expect(parseTestSlotArgs(["--slots=3", "--help", "x"], {})).toEqual({ help: true });
});
