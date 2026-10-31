import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { exec } from "../../src/lib/exec.mjs";
import { processExists } from "../runtime-helpers.mjs";

// The child prints `lines` lines, starts a detached grandchild that keeps stdout and stderr open for
// a minute, records the grandchild pid in the file named by argv[3], and exits at once.
const CHILD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
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

const runChild = (lines, options = {}) =>
  exec(process.execPath, [join(dir, "child.cjs"), String(lines), pidFile], options);

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
// pipe, which kills nothing the timeout can reach (issue #1302).
test("exec rejects with timedOut when the timeout passes and a grandchild holds the pipe", async () => {
  const startedAt = Date.now();
  const failure = await runChild(3, { timeout: 1 }).catch((err) => err);
  expect(failure.timedOut).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 20_000);
