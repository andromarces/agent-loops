import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { processStartTime, withStateLock } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

// The start-time query runs `ps` or PowerShell. Its failure modes (error, timeout,
// empty or unparseable output) cannot be produced on demand with the real command,
// so `execFile` is replaced by a stub that answers each query with a chosen result.
let answer = { err: null, out: "" };

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, _args, _options, callback) => callback(answer.err, answer.out)),
}));

let dirs = [];

afterEach(async () => {
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

const FAILURES = [
  ["a failed query", { err: new Error("spawn ps ENOENT"), out: "" }],
  ["a timed-out query", { err: Object.assign(new Error("timeout"), { killed: true }), out: "" }],
  ["an empty answer", { err: null, out: "  \n" }],
  ["an unparseable answer", { err: null, out: "mar.  6 oct. 04:22:29 2026\n" }],
];

// Usefulness: verifies every failed, timed-out, empty, or unparseable read of the
// current start time counts as alive, so an unknown stamp never frees a live lock.
test.each(FAILURES)("a live lock is kept after %s", async (_name, result) => {
  answer = result;
  const dir = await mkdtemp(join(tmpdir(), "runstate-starttime-"));
  dirs.push(dir);
  const lockFile = join(dir, "state.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: "old", startTime: 86_400 }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies processStartTime reports an unreadable start time as null, so
// a caller can tell it from a real stamp.
test.each(FAILURES)("processStartTime is null after %s", async (_name, result) => {
  answer = result;

  await expect(processStartTime(process.pid)).resolves.toBeNull();
});
