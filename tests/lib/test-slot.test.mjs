import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { deadPid, processExists, removePath } from "../runtime-helpers.mjs";

// Delays each in-process lock attempt by `ms`, so a test can make one acquisition pass end
// after the wait bound. With `failTableRelease`, the release of the short acquisition lock
// removes the lock and then throws. Every spawned wrapper uses the real module.
const slowLock = vi.hoisted(() => ({ ms: 0, failTableRelease: false }));
vi.mock("../../src/lib/state-lock.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    tryStateLock: async (lockFile, ...rest) => {
      await new Promise((resolve) => setTimeout(resolve, slowLock.ms));
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

import { parseTestSlotArgs, runTestSlot } from "../../src/lib/test-slot.mjs";

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
const SLOT_ENV = [
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_TEST_SLOTS",
  "AGENT_LOOP_TEST_SLOT_WAIT",
  "AGENT_LOOP_TEST_SLOT_HELD",
];

const dirs = [];
const savedEnv = Object.fromEntries(SLOT_ENV.map((name) => [name, process.env[name]]));
afterEach(async () => {
  slowLock.ms = 0;
  slowLock.failTableRelease = false;
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
  const cwd = await mkdtemp(join(tmpdir(), "test-slot-"));
  dirs.push(cwd);
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(cwd, name), body, "utf8");
  }
  return { cwd, root: join(cwd, "slots") };
}

// Starts `agent-loop test-slot` as its own process. A marker or override inherited from a
// wrapped test run is dropped, so each test sets exactly the environment it names.
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

async function waitForFile(path, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`${path} did not appear`);
    }
    await delay(50);
  }
}

// Usefulness: acceptance (#847) — with one slot, two concurrent wrappers run their
// commands one after the other, which is the whole point of the slot.
test("with --slots 1, two concurrent wrappers run their commands one after the other", async () => {
  const ctx = await setup({
    "serial.mjs":
      "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync('order.log', 's');\n" +
      "setTimeout(() => appendFileSync('order.log', 'e'), 1000);\n",
  });
  const first = wrapper(["--slots", "1", "--wait", "60", "--", "node serial.mjs"], ctx);
  const second = wrapper(["--slots", "1", "--wait", "60", "--", "node serial.mjs"], ctx);
  const results = await Promise.all([first.done, second.done]);
  expect(results.map((r) => r.code)).toEqual([0, 0]);
  expect(await readFile(join(ctx.cwd, "order.log"), "utf8")).toBe("sese");
}, 60_000);

// Usefulness: acceptance (#847) — a slot left by a process that no longer exists is
// reclaimed, so a crashed wrapper cannot block every later run until the wait bound.
test("a slot left by a dead process is reclaimed", async () => {
  const ctx = await setup({
    "mark.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('mark', 'x');\n",
  });
  await holdSlot(ctx.root, {
    pid: await deadPid(),
    startedAt: new Date().toISOString(),
    nonce: "n",
  });
  const { done } = wrapper(["--slots", "1", "--wait", "10", "--", "node mark.mjs"], ctx);
  expect((await done).code).toBe(0);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(true);
});

// Usefulness: acceptance (#847) — at the wait bound the command does not run and the
// wrapper exits 75; the environment overrides of the slot count and the bound apply.
test("at the wait bound the command does not run and the wrapper exits 75", async () => {
  const ctx = await setup({
    "mark.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('mark', 'x');\n",
  });
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: "live" };
  await holdSlot(ctx.root, owner);
  const { done } = wrapper(["--", "node mark.mjs"], {
    ...ctx,
    env: { AGENT_LOOP_TEST_SLOTS: "1", AGENT_LOOP_TEST_SLOT_WAIT: "1" },
  });
  const result = await done;
  expect(result.code).toBe(75);
  expect(result.stderr).toMatch(/no test slot/i);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  expect(JSON.parse(await readFile(join(ctx.root, "slot-0.lock"), "utf8"))).toEqual(owner);
});

// Usefulness: acceptance (#847) — the wrapper exits with the exit code of the command and
// frees the slot, so a caller reads the test result through the wrapper.
test("the wrapper exits with the command's exit code and releases the slot", async () => {
  const ctx = await setup({ "exit7.mjs": "process.exit(7);\n" });
  const { done } = wrapper(["--slots", "1", "--wait", "10", "--", "node exit7.mjs"], ctx);
  expect((await done).code).toBe(7);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
});

// Usefulness: acceptance (#847) — a nested wrapper inside a wrapped command runs at once
// instead of waiting on the slot its parent holds, so it cannot deadlock.
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
  const { done } = wrapper(["--slots", "0", "--", "node mark.mjs"], ctx);
  expect((await done).code).toBe(64);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
});

// Usefulness: issue #847 contract — a caller starts only while fewer than its own N slots are
// held by live owners, so an N=1 caller waits while an N=2 caller holds any slot.
test("a caller with --slots 1 waits while another caller holds any slot", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  await holdSlot(ctx.root, liveOwner(), 1);
  const one = await wrapper(["--slots", "1", "--wait", "1", "--", "node mark.mjs"], ctx).done;
  expect(one.code).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  const two = await wrapper(["--slots", "2", "--wait", "5", "--", "node mark.mjs"], ctx).done;
  expect(two.code).toBe(0);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(true);
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
  const ctx = await setup({ "mark.mjs": MARK });
  const dead = { pid: await deadPid(), startedAt: new Date().toISOString(), nonce: "gone" };
  await holdSlot(ctx.root, dead);
  await holdSlot(ctx.root, liveOwner(), 1);
  const result = await wrapper(["--slots", "1", "--wait", "1", "--", "node mark.mjs"], {
    ...ctx,
    env: { AGENT_LOOP_TEST_SLOT_HELD: marker(ctx.root) },
  }).done;
  expect(result.code).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
});

// Usefulness: issue #847 review — when the outer wrapper ends its command tree, the command
// of a nested wrapper ends too, so no test process outlives the slot. POSIX only: the
// defect is a separate process group, and Windows has no catchable outside SIGTERM.
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
  slowLock.ms = 1500;
  expect(await runTestSlot(["--slots", "1", "--wait", "1", "--", command])).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
  expect(existsSync(join(ctx.root, "slot-0.lock"))).toBe(false);
}, 30_000);

// Usefulness: issue #847 review — a valid flag wins over an invalid environment value, and
// the invalid value is refused only when no flag replaces it.
test("a valid flag wins over an invalid environment value", () => {
  const env = { AGENT_LOOP_TEST_SLOTS: "many", AGENT_LOOP_TEST_SLOT_WAIT: "-1" };
  expect(parseTestSlotArgs(["--slots", "2", "--wait", "5", "--", "x"], env)).toEqual({
    slots: 2,
    waitSeconds: 5,
    command: "x",
  });
  expect(() => parseTestSlotArgs(["--wait", "5", "--", "x"], env)).toThrow(/AGENT_LOOP_TEST_SLOTS/);
  expect(() => parseTestSlotArgs(["--slots", "2", "--", "x"], env)).toThrow(
    /AGENT_LOOP_TEST_SLOT_WAIT/,
  );
});

// Usefulness: maintainer decision (#847) — `--wait 0` is one attempt: the command runs when a
// slot is free now, and the wrapper exits 75 at once without running it otherwise.
test("--wait 0 runs on a free slot and exits 75 on a held one", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  const free = await wrapper(["--slots", "1", "--wait", "0", "--", "node mark.mjs"], ctx).done;
  expect(free.code).toBe(0);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(true);
  await rm(join(ctx.cwd, "mark"));
  await holdSlot(ctx.root, liveOwner());
  const held = await wrapper(["--slots", "1", "--wait", "0", "--", "node mark.mjs"], ctx).done;
  expect(held.code).toBe(75);
  expect(existsSync(join(ctx.cwd, "mark"))).toBe(false);
}, 30_000);

// Usefulness: issue #847 review — a slot file that cannot be read counts as held, so a caller
// never takes a free index while the unreadable slot may belong to a live holder. A directory
// at the slot path is unreadable as a file on every platform.
test("an unreadable slot file counts as held", async () => {
  const ctx = await setup({ "mark.mjs": MARK });
  await mkdir(join(ctx.root, "slot-1.lock"), { recursive: true });
  const result = await wrapper(["--slots", "1", "--wait", "1", "--", "node mark.mjs"], ctx).done;
  expect(result.code).toBe(75);
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
