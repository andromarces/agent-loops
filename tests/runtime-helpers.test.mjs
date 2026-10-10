import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { pidAlive } from "../src/lib/runstate.mjs";
import {
  BOUND_KILL_TEST_TIMEOUT_MS,
  cleanRepoGit,
  createPsShim,
  deadPid,
  expectBoundKillsShim,
  pollUntil,
  untrackedFilesGit,
  within,
} from "./runtime-helpers.mjs";

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

// Usefulness: a probe that never settles must not hold the wait past its deadline (#647 review).
// No other test covers the polling helper.
test("pollUntil rejects at its deadline when a probe never settles", async () => {
  const started = performance.now();
  await expect(pollUntil(() => new Promise(() => {}), 100)).rejects.toThrow(
    /not met within 100 ms/,
  );
  expect(performance.now() - started).toBeLessThan(2000);
  await expect(pollUntil(async () => 7, 100)).resolves.toBe(7);
});

// Usefulness: a probe result that arrives after the deadline must be rejected, even when the timer
// callback has not run yet (#647 review). The probe blocks the event loop past the deadline, so the
// timer cannot fire first.
test("pollUntil rejects a probe result that arrives after the deadline", async () => {
  const late = () => {
    const until = performance.now() + 150;
    while (performance.now() < until) {
      // Busy wait: the result is ready only after the 100 ms deadline.
    }
    return 7;
  };
  await expect(pollUntil(late, 100)).rejects.toThrow(/not met within 100 ms/);
});

// Usefulness: the shim readiness reader must never accept a partial heartbeat, and its wait must
// end at its own deadline.
test("createPsShim.ready accepts only a complete newline-terminated heartbeat", async () => {
  const shim = await createPsShim("exit 0");
  try {
    await writeFile(join(shim.dir, "beat"), "1");
    await expect(shim.ready(100)).rejects.toThrow(/not met within 100 ms/);
    await writeFile(join(shim.dir, "beat"), "1\n");
    await expect(shim.ready(100)).resolves.toBe(1);
  } finally {
    await shim.cleanup();
  }
});

// Usefulness: the shim must end by itself at its wall-clock ceiling, so a failed test cannot leave
// it running, and the helper must tell an early end from a run to the ceiling without a signal.
// The test owns the child handle and ends it through that handle if the shim does not exit.
test.skipIf(process.platform === "win32")(
  "createPsShim stalls only until its ceiling and reports how it ended",
  async () => {
    const shim = await createPsShim("trap '' TERM\n__STALL__", { ceilingSeconds: 1 });
    const child = spawn(join(shim.dir, "ps"), [], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      await shim.ready();
      expect(await within(exited, 10_000, "The shim exit")).toBe(0);
      expect(await shim.heartbeatStopped()).toBe(false);
      expect(await readFile(join(shim.dir, "done"), "utf8")).toBe("done\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await shim.cleanup();
    }
  },
  30_000,
);

// Usefulness: acceptance (#670) — cleanup after a failed kill check must end the shim child and free
// its directory, and must not return while the shim lives, without a signal to a pid that a file supplied. A pid that a file names can belong to
// an unrelated process once the shim exits, so a SIGKILL read from the record is the defect.
test(
  "expectBoundKillsShim ends a surviving shim without signalling a recorded pid",
  async () => {
    const kill = vi.spyOn(process, "kill");
    let held;
    let shimDir;
    let pid;
    try {
      const failure = await expectBoundKillsShim("leftover-shim", async () => {
        shimDir = process.env.PATH.split(delimiter)[0];
        held = execa("leftover-shim", { reject: false });
        pid = await pollUntil(async () => {
          const text = await readFile(join(shimDir, "started.txt"), "utf8").catch(() => "");
          return text === "" ? undefined : Number(text);
        }, 10_000);
      }).then(
        () => undefined,
        (error) => error,
      );
      expect(failure?.message).toMatch(/outlived the 1000 ms force-kill boundary/);
      const signals = kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined);
      expect(signals).toEqual([]);
      // No wait: the helper must not return while the shim is alive.
      expect(pidAlive(pid)).toBe(false);
      expect(existsSync(shimDir)).toBe(false);
    } finally {
      kill.mockRestore();
      // The shim ends itself on the stop file, so the handle is only released here. It is not
      // awaited: a killed wrapper can leave its pipes open.
      held?.catch(() => {});
      held?.kill("SIGKILL");
    }
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — a shim must end when its stop request is deleted while its
// directory stays, as a Windows lock on a file inside the directory leaves it. The call under test
// deletes the keep file and nothing else, so the helper passes only if the shim exits on its own.
test(
  "expectBoundKillsShim sees a shim end when its keep file is deleted and its directory stays",
  async () => {
    await expect(
      expectBoundKillsShim("keepless-shim", async () => {
        const shimDir = process.env.PATH.split(delimiter)[0];
        const held = execa("keepless-shim", { reject: false });
        held.catch(() => {});
        await pollUntil(
          async () => (existsSync(join(shimDir, "started.txt")) ? true : undefined),
          10_000,
        );
        await rm(join(shimDir, "keep"));
      }),
    ).resolves.toBeUndefined();
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);
