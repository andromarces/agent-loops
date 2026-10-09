import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { pidAlive } from "../src/lib/runstate.mjs";
import { cleanRepoGit, deadPid, untrackedFilesGit } from "./runtime-helpers.mjs";

const options = { cwd: tmpdir() };
const expected = ["rev-parse", "--verify", "-q", "HEAD"];
const merged = ["rev-parse", "--verify -q", "HEAD"];

// Usefulness: acceptance (#514) — a merged-argument call reads differently from the expected call in the error.
test("cleanRepoGit error for a merged-argument call differs from the expected call text", () => {
  const message = (args) => {
    try {
      cleanRepoGit("git", args, options);
    } catch (error) {
      return error.message;
    }
    return undefined;
  };
  expect(message(expected)).toBeUndefined();
  expect(message(merged)).toBeDefined();
  expect(message(merged)).not.toBe(`unexpected git call: ${expected.join(" ")}`);
});

// Usefulness: acceptance (#514) — the same holds for `untrackedFilesGit`, which delegates unknown calls.
test("untrackedFilesGit error for a merged-argument call differs from the expected call text", async () => {
  const error = await untrackedFilesGit("git", merged, options).catch((caught) => caught);
  expect(error.message).toContain("unexpected git call");
  expect(error.message).not.toBe(`unexpected git call: ${expected.join(" ")}`);
});

// Largest pid limit of a supported OS: Linux `pid_max` is at most 2^22. macOS (99999) is lower, and a Windows pid is a multiple of 4.
// Status of these assumptions (#571):
// - Windows: probed on Windows 11 build 26220 with Node 26.8.1. All 383 live ids from `Get-Process` and `Get-CimInstance Win32_Process`,
//   387 from `tasklist`, and 300 ids of spawned Node children were multiples of 4. Not a guarantee: Microsoft calls it an implementation
//   detail, "don't write code that relies on it" (https://devblogs.microsoft.com/oldnewthing/20080228-00/). `2 ** 31 - 1` is not a multiple of 4.
// - Linux: source only, not probed. `PID_MAX_LIMIT` is 4 * 1024 * 1024 (2^22) when `sizeof(long) > 4`, in `include/linux/threads.h`
//   (https://github.com/torvalds/linux/blob/master/include/linux/threads.h). The `/proc/sys/kernel/pid_max` read on a Linux runner is not done.
// - macOS: the 99999 limit is not probed here.
const OS_PID_CEILING = 2 ** 22;
const INT32_MAX = 2 ** 31 - 1;

// Usefulness: acceptance (#546, #557) — the dead owner is a valid pid above every OS pid limit, so a reusable pid of an exited process, `undefined`, or an out-of-range value fails here while `pidAlive` alone reads them as dead.
test("deadPid is a valid pid that no OS assigns and the production liveness check reads as dead", async () => {
  const pid = await deadPid();
  expect(pid).not.toBe(process.pid);
  expect(Number.isInteger(pid)).toBe(true);
  expect(pid).toBeGreaterThan(OS_PID_CEILING);
  expect(pid).toBeLessThanOrEqual(INT32_MAX);
  expect(pid % 4).not.toBe(0);
  expect(pidAlive(pid)).toBe(false);
});
