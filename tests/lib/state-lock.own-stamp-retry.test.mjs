import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { withStateLock } from "../../src/lib/state-lock.mjs";
import { removePath, trackedTempDir } from "../fs-helpers.mjs";

// Answers each start-time query in turn. The first read fails, so a lock that records no
// stamp is the failure the test catches.
const queries = vi.hoisted(() => ({ answers: [] }));

vi.mock("../../src/lib/exec.mjs", () => ({
  execBounded: vi.fn(async () => {
    const answer = queries.answers.shift();
    if (answer === undefined) {
      throw new Error("unexpected start-time query");
    }
    return answer;
  }),
}));

// The start-time source is read through the darwin branch, whose stamp parses a fixed line.
const realPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});

const dirs = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await removePath(dir);
  }
});

// Usefulness: verifies issue #2042, that a lock records the owner start time even when its
// first own-stamp read fails. A lock without the stamp keeps the pid-only check, so a later
// contender reads a reused pid as the live owner. Not redundant: no other case covers a
// failed read at lock creation.
test("a lock records the owner start time after a failed first read", async () => {
  queries.answers = [
    { exitCode: undefined, stdout: "", timedOut: true, isCanceled: false, isMaxBuffer: false },
    {
      exitCode: 0,
      stdout: "Thu Jan  1 00:01:00 1970\n",
      timedOut: false,
      isCanceled: false,
      isMaxBuffer: false,
    },
  ];
  const dir = await trackedTempDir("lock-own-stamp-", dirs);
  const lockFile = join(dir, "state.lock");

  const content = await withStateLock(lockFile, async () => readFile(lockFile, "utf8"));

  expect(JSON.parse(content).startTime).toBe("darwin-lstart:60");
});
