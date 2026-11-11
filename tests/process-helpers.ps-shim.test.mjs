import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { pidAlive } from "../src/lib/process-identity.mjs";
import {
  BOUND_KILL_TEST_TIMEOUT_MS,
  createPsShim,
  deadPid,
  endOwnedProcess,
  expectBoundKillsShim,
} from "./process-helpers.mjs";
import { within } from "./wait-helpers.mjs";

// Largest pid limit of a supported OS: Linux `pid_max` is at most 2^22. macOS (99999) is lower, and a Windows pid is a multiple of 4.
// Status of these assumptions (#571):
// - Windows: probed on Windows 11 build 26220 with Node 26.8.1. All 383 live ids from `Get-Process` and `Get-CimInstance Win32_Process`,
//   387 from `tasklist`, and 300 ids of spawned Node children were multiples of 4. Not a guarantee: Microsoft calls it an implementation
//   detail, "don't write code that relies on it" (https://devblogs.microsoft.com/oldnewthing/20080228-00/). `2 ** 31 - 1` is not a multiple of 4.
// - Linux: source only, not probed. `PID_MAX_LIMIT` is 4 * 1024 * 1024 (2^22) when `sizeof(long) > 4`, in `include/linux/threads.h`
//   (https://github.com/torvalds/linux/blob/master/include/linux/threads.h). The `/proc/sys/kernel/pid_max` read on a Linux runner is not done.
// - macOS: `PID_MAX` is 99999 in `bsd/sys/proc_internal.h` of XNU (https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_internal.h).
//   Probed on macOS 27.2 (Darwin 27.2.0, arm64) with Node 26.11.1 on 2026-10-10: 25214 sequential `spawnSync` children of `/usr/bin/true`.
//   The probe started above pid 74248. The highest id was 99998, and the next id was 100. No id reached 100000. One host, one build.
const OS_PID_CEILING = 2 ** 22;
const INT32_MAX = 2 ** 31 - 1;

// Usefulness: acceptance (#546, #557) — the dead owner is a valid pid above every OS pid limit, so a reusable pid of an exited process, `undefined`, or an out-of-range value fails here while `pidAlive` alone reads them as dead.
test.concurrent("deadPid is a valid pid that no OS assigns and the production liveness check reads as dead", async () => {
  const pid = await deadPid();
  expect(pid).not.toBe(process.pid);
  expect(Number.isInteger(pid)).toBe(true);
  expect(pid).toBeGreaterThan(OS_PID_CEILING);
  expect(pid).toBeLessThanOrEqual(INT32_MAX);
  expect(pid % 4).not.toBe(0);
  expect(pidAlive(pid)).toBe(false);
});

// Usefulness: the shim readiness reader must never accept a partial heartbeat, and its wait must
// end at its own deadline.
test.concurrent("createPsShim.ready accepts only a complete newline-terminated heartbeat", async () => {
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

// Process: the case runs the shim as a child script, so its ceiling end and exit code are read here.
// Usefulness: the shim must end by itself at its wall-clock ceiling, so a failed test cannot leave
// it running, and the helper must tell an early end from a run to the ceiling without a signal.
// The test owns the child handle and ends it through that handle if the shim does not exit.
test.concurrent.skipIf(process.platform === "win32")(
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

// Usefulness: #986 — a start read and a ceiling read that straddle a second boundary must still leave
// one heartbeat, or `ready()` times out on a shim that already ended. The body replaces `date` so the
// first read is 100 and every later read is 101, which is that straddle with no real clock.
test.concurrent.skipIf(process.platform === "win32")(
  "createPsShim writes a heartbeat even when its first two clock reads differ by the ceiling",
  async () => {
    const shim = await createPsShim(
      [
        "date() {",
        "  n=$(cat __DIR__/clock 2>/dev/null || echo 0)",
        "  echo $((n + 1)) > __DIR__/clock",
        '  if [ "$n" -eq 0 ]; then echo 100; else echo 101; fi',
        "}",
        "__STALL__",
      ].join("\n"),
      { ceilingSeconds: 1 },
    );
    const child = spawn(join(shim.dir, "ps"), [], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      expect(await within(exited, 10_000, "The shim exit")).toBe(0);
      await expect(shim.ready(2000)).resolves.toBeGreaterThanOrEqual(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await shim.cleanup();
    }
  },
  30_000,
);

// Usefulness: verifies the cleanup helper signals only the process that carries its marker, so a
// stale or reused pid of another process is never killed by a test cleanup (#729).
test.concurrent.skipIf(process.platform === "win32")(
  "endOwnedProcess ends a process with the marker and leaves another process alone",
  async () => {
    const idle = "setTimeout(() => {}, 30000)";
    const owned = spawn(process.execPath, ["-e", idle, "owned-marker-7d2c"], { stdio: "ignore" });
    const foreign = spawn(process.execPath, ["-e", idle], { stdio: "ignore" });
    try {
      await vi.waitFor(() => expect(Boolean(owned.pid && foreign.pid)).toBe(true));
      expect(await endOwnedProcess(foreign.pid, "owned-marker-7d2c")).toBe(false);
      expect(foreign.signalCode).toBeNull();
      expect(await endOwnedProcess(owned.pid, "owned-marker-7d2c")).toBe(true);
      await vi.waitFor(() => expect(owned.signalCode).toBe("SIGKILL"), { timeout: 5000 });
      expect(foreign.signalCode).toBeNull();
    } finally {
      owned.kill("SIGKILL");
      foreign.kill("SIGKILL");
    }
  },
);

// Usefulness: verifies the cleanup helper reads the process table under a short bound, so a hung
// `ps` ends the cleanup at the bound and signals nothing (#729).
test.concurrent.skipIf(process.platform === "win32")(
  "endOwnedProcess ends a hung process-table read at its bound and signals nothing",
  async () => {
    const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "never-marked"], {
      stdio: "ignore",
    });
    try {
      const sent = await expectBoundKillsShim("ps", (timeoutMs, { env }) =>
        endOwnedProcess(foreign.pid, "never-marked", { timeoutMs, env }),
      );
      expect(sent).toBe(false);
      expect(foreign.signalCode).toBeNull();
    } finally {
      foreign.kill("SIGKILL");
    }
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);
