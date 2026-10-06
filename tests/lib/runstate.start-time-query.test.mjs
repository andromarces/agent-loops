import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { processStartTime, withStateLock } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

// The start-time query runs `ps` or PowerShell. Its failure modes (error, timeout,
// empty or unparseable output) cannot be produced on demand with the real command,
// so `execFile` is replaced by a stub that answers each query with a chosen result.
let answer = { err: null, out: "" };

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, _args, _options, callback) => callback(answer.err, answer.out)),
}));

// The darwin query path is the one under test, so the platform is fixed to it.
const realPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});

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
  ["a 31st of a 30-day month", { err: null, out: "Tue Jun 31 10:00:00 2026\n" }],
  ["a 29th of February in a common year", { err: null, out: "Mon Feb 29 10:00:00 2027\n" }],
  ["hour 24", { err: null, out: "Tue Jan  6 24:00:00 2026\n" }],
  ["second 60", { err: null, out: "Tue Jan  6 10:00:60 2026\n" }],
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
    JSON.stringify({ pid: process.pid, startedAt: "old", startTime: "darwin-lstart:86400" }),
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

// Usefulness: verifies a valid `ps` line, a leap day included, parses to the epoch
// seconds of that UTC time, so the calendar check rejects only dates that do not exist.
test.each([
  ["Thu Jan  1 00:01:00 1970", 60],
  ["Sat Feb 29 12:00:00 2020", 1_582_977_600],
])("processStartTime parses %j", async (out, epoch) => {
  answer = { err: null, out: `${out}\n` };

  await expect(processStartTime(process.pid)).resolves.toBe(`darwin-lstart:${epoch}`);
});

// Usefulness: verifies a stamp of the same kind that differs beyond the tolerance is a
// reused pid, so the lock is taken over (the positive case of the alive-on-failure rule).
test("a lock whose recorded stamp differs from the current one is taken over", async () => {
  answer = { err: null, out: "Thu Jan  1 00:01:00 1970\n" };
  const dir = await mkdtemp(join(tmpdir(), "runstate-starttime-"));
  dirs.push(dir);
  const lockFile = join(dir, "state.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: "old", startTime: "darwin-lstart:86400" }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
});
