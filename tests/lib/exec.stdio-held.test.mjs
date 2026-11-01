import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { exec, execBounded } from "../../src/lib/exec.mjs";
import { processExists } from "../process-helpers.mjs";

// The child prints `lines` lines and starts a grandchild that keeps stdout and stderr open for a
// minute. It records the grandchild pid in the file named by argv[3] and exits at once. The grandchild
// is detached, unless argv[4] is `same-group`, which keeps it in the process group of the child.
const CHILD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"],
  detached: process.argv[4] !== "same-group",
});
writeFileSync(process.argv[3], String(gc.pid));
gc.unref();
for (let i = 0; i < Number(process.argv[2]); i += 1) console.log("line " + i);
`;

let dir;
let pidFile;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "exec-stdio-held-"));
  pidFile = join(dir, "grandchild.pid");
  await writeFile(join(dir, "child.cjs"), CHILD);
});

afterEach(async () => {
  const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
  if (Number.isInteger(pid) && pid > 0 && processExists(pid)) process.kill(pid, "SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

const runChild = (lines, options = {}, placement = "detached") =>
  exec(process.execPath, [join(dir, "child.cjs"), String(lines), pidFile, placement], options);

// Usefulness: a descendant that keeps stdout open after the child exited must not hold the call.
// A normal-exit path with no timeout is the case no timer can rescue (issue #1302).
test("exec returns the output after the child exits while a grandchild holds the pipe", async () => {
  const startedAt = Date.now();
  const result = await runChild(500);
  expect(result.stdout.split("\n")).toHaveLength(500);
  expect(result.stdout).toContain("line 499");
  expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 20_000);

// Usefulness: the turn timeout must end the turn when the child is gone and a grandchild holds the
// pipe. The timeout kill reaches nothing in that case (issue #1302).
test("exec rejects with timedOut when the timeout passes and a grandchild holds the pipe", async () => {
  const startedAt = Date.now();
  const failure = await runChild(3, { timeout: 1 }).catch((err) => err);
  expect(failure.timedOut).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 20_000);

// Usefulness: the early settle must still end the process group that the call owns, as the base
// timeout kill did. A descendant of the child then never outlives the call (review of PR #1306).
// POSIX only: on Windows no kill reaches a descendant of an exited child.
test.skipIf(process.platform === "win32")(
  "exec ends a same-group descendant that holds the pipe when it stops waiting",
  async () => {
    await runChild(3, {}, "same-group");
    const pid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 3000 });
  },
  20_000,
);

// Usefulness: a bound must never cut output that the child wrote and a slow reader has not taken
// yet. This holds when the reader waits longer than the drain bound (review of PR #1306).
test("execBounded keeps the output of an exited child that a paused reader takes late", async () => {
  const script = 'process.stdout.write("x".repeat(40000) + "\\n")';
  const subprocess = execBounded(process.execPath, ["-e", script], { buffer: false });
  let received = 0;
  subprocess.stdout.on("data", (chunk) => (received += chunk.length));
  subprocess.stdout.pause();
  await new Promise((resolve) => setTimeout(resolve, 4500));
  subprocess.stdout.resume();
  await subprocess;
  expect(received).toBe(40001);
}, 20_000);
