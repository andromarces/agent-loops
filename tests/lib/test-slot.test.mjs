import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vite-plus/test";
import { deadPid, processExists, removePath } from "../runtime-helpers.mjs";

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
const SLOT_ENV = [
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_TEST_SLOTS",
  "AGENT_LOOP_TEST_SLOT_WAIT",
  "AGENT_LOOP_TEST_SLOT_HELD",
];

const dirs = [];
afterEach(async () => {
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

async function holdSlot(root, owner) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "slot-0.lock"), JSON.stringify(owner), "utf8");
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
  const inner = `node "${CLI}" test-slot --slots 1 --wait 0 -- "node mark.mjs"`;
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
