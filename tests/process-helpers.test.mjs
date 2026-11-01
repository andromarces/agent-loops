import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { pidAlive } from "../src/lib/process-identity.mjs";
import {
  BOUND_KILL_TEST_TIMEOUT_MS,
  createPsShim,
  deadPid,
  endOwnedProcess,
  expectBoundKillsShim,
  shimCallRecords,
  shimCallSteps,
  shimStartPids,
  withGitHangingAfter,
} from "./process-helpers.mjs";
import { pollUntil, within } from "./wait-helpers.mjs";

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
test("deadPid is a valid pid that no OS assigns and the production liveness check reads as dead", async () => {
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

// Usefulness: #986 — a start read and a ceiling read that straddle a second boundary must still leave
// one heartbeat, or `ready()` times out on a shim that already ended. The body replaces `date` so the
// first read is 100 and every later read is 101, which is that straddle with no real clock.
test.skipIf(process.platform === "win32")(
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
          return text === "" ? undefined : Number(text.split(" ")[0]);
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

// Starts a shim whose `keep` file is replaced by a directory: the shim stays alive, cleanup cannot
// remove the keep file, and the shim cannot acknowledge an exit. `after` runs in the call under test.
async function blockedShimFailure(after) {
  let shimDir;
  const failure = await expectBoundKillsShim("blocked-shim", async () => {
    shimDir = process.env.PATH.split(delimiter)[0];
    const held = execa("blocked-shim", { reject: false });
    held.catch(() => {});
    await pollUntil(
      async () => (existsSync(join(shimDir, "started.txt")) ? true : undefined),
      10_000,
    );
    // The hold file stays until the directory goes, so the shim sees `keep` or `hold` throughout.
    await writeFile(join(shimDir, "hold"), "");
    await rm(join(shimDir, "keep"));
    await mkdir(join(shimDir, "keep"));
    await after();
  }).then(
    () => undefined,
    (error) => error,
  );
  return { failure, shimDir };
}

// Usefulness: acceptance (#670 review) — a failed test body must not hide a shim that survives
// cleanup, so both errors reach the report.
test(
  "expectBoundKillsShim reports a shim that does not exit even when the test body failed",
  async () => {
    const { failure } = await blockedShimFailure(async () => {
      throw new Error("body failed first");
    });
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = failure.errors.map((error) => error.message);
    expect(messages).toContain("body failed first");
    const survivor = messages.find((message) =>
      /did not exit within \d+ ms of cleanup/.test(message),
    );
    expect(survivor).toMatch(/pid \d+/);
    expect(survivor).toMatch(/hard wall-clock deadline of \d+ s ends it/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — an error from removing the keep file must not skip the
// directory removal, and must itself be reported.
test(
  "expectBoundKillsShim removes the directory and reports the error when the keep file cannot be removed",
  async () => {
    const { failure, shimDir } = await blockedShimFailure(async () => {});
    expect(existsSync(shimDir)).toBe(false);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      failure.errors.some((error) => error.syscall === "rm" || /EISDIR|EPERM/.test(error.code)),
    ).toBe(true);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — a pid record that is missing is not proof that the shim
// ended, so the cleanup reports an unconfirmed exit instead of passing silently.
test(
  "expectBoundKillsShim reports an unconfirmed exit when the pid record is missing",
  async () => {
    const failure = await expectBoundKillsShim("recordless-shim", async () => {
      const shimDir = process.env.PATH.split(delimiter)[0];
      const held = execa("recordless-shim", { reject: false });
      held.catch(() => {});
      const started = join(shimDir, "started.txt");
      await pollUntil(async () => (existsSync(started) ? true : undefined), 10_000);
      await rm(started);
    }).then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.some((error) => /exit is unconfirmed/.test(error.message))).toBe(true);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — a shim that ends on its own ceiling was not killed by the
// code under test, so the kill check must fail instead of accepting the exit as a kill. The call
// under test never kills the shim and returns only after the shim has gone.
test(
  "expectBoundKillsShim fails when the shim exits on its ceiling instead of being killed",
  async () => {
    const failure = await expectBoundKillsShim(
      "ceiling-shim",
      async () => {
        const shimDir = process.env.PATH.split(delimiter)[0];
        const held = execa("ceiling-shim", { reject: false });
        held.catch(() => {});
        const started = join(shimDir, "started.txt");
        await pollUntil(async () => (existsSync(started) ? true : undefined), 10_000);
        const pid = Number((await readFile(started, "utf8")).split(" ")[0]);
        await pollUntil(() => (pidAlive(pid) ? undefined : true), 10_000);
      },
      undefined,
      { ceilingMs: 500 },
    ).then(
      () => undefined,
      (error) => error,
    );
    expect(failure?.message).toMatch(/exited on its wall-clock ceiling/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — a shim whose ceiling marker cannot be written must not exit
// silently, or the kill check reads its ceiling exit as a kill. The marker path is a directory, so
// the write fails; the shim must stay alive past its ceiling and the helper must report it.
const CEILING_MS = 4000;
test(
  "expectBoundKillsShim fails when the ceiling marker cannot be written",
  async () => {
    const failure = await expectBoundKillsShim(
      "markerless-shim",
      async () => {
        const shimDir = process.env.PATH.split(delimiter)[0];
        await mkdir(join(shimDir, "ceiling"));
        const held = execa("markerless-shim", { reject: false });
        held.catch(() => {});
        const started = join(shimDir, "started.txt");
        await pollUntil(async () => (existsSync(started) ? true : undefined), 10_000);
        // Past the ceiling, and early enough that the kill check ends before the hard deadline
        // (twice the ceiling), as it does with the real ceilings.
        await delay(CEILING_MS + 200);
      },
      undefined,
      { ceilingMs: CEILING_MS },
    ).then(
      () => undefined,
      (error) => error,
    );
    expect(failure?.message).toMatch(/outlived the 1000 ms force-kill boundary/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — a shim that keeps failing to write its ceiling marker must
// still end on its own, or a survivor lives without limit. The marker path is a directory, so the
// write never succeeds; the shim must still exit at its hard deadline, never before its ceiling.
test(
  "a shim whose ceiling marker cannot be written still ends at its hard deadline",
  async () => {
    let lived;
    await expectBoundKillsShim(
      "endless-shim",
      async () => {
        const shimDir = process.env.PATH.split(delimiter)[0];
        await mkdir(join(shimDir, "ceiling"));
        const held = execa("endless-shim", { reject: false });
        held.catch(() => {});
        const started = join(shimDir, "started.txt");
        await pollUntil(async () => (existsSync(started) ? true : undefined), 10_000);
        const [pid, startMs] = (await readFile(started, "utf8")).split(" ").map(Number);
        await pollUntil(() => (pidAlive(pid) ? undefined : true), 10_000);
        lived = Date.now() - startMs;
      },
      undefined,
      { ceilingMs: 500 },
    ).catch(() => {});
    expect(lived).toBeGreaterThanOrEqual(400);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — an exit that is not proven to precede the shim's ceiling must
// not pass as a kill. The marker path is a directory, so a hard-deadline exit leaves no marker, and
// the call returns only after that exit, as a delayed record read or a paused parent would.
test(
  "expectBoundKillsShim fails when the shim exit is first observed after its ceiling",
  async () => {
    const failure = await expectBoundKillsShim(
      "late-shim",
      async () => {
        const shimDir = process.env.PATH.split(delimiter)[0];
        await mkdir(join(shimDir, "ceiling"));
        const held = execa("late-shim", { reject: false });
        held.catch(() => {});
        const started = join(shimDir, "started.txt");
        await pollUntil(async () => (existsSync(started) ? true : undefined), 10_000);
        const pid = Number((await readFile(started, "utf8")).split(" ")[0]);
        await pollUntil(() => (pidAlive(pid) ? undefined : true), 10_000);
      },
      undefined,
      { ceilingMs: 500 },
    ).then(
      () => undefined,
      (error) => error,
    );
    expect(failure?.message).toMatch(/cannot prove a runtime kill/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies the cleanup helper signals only the process that carries its marker, so a
// stale or reused pid of another process is never killed by a test cleanup (#729).
test.skipIf(process.platform === "win32")(
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
test.skipIf(process.platform === "win32")(
  "endOwnedProcess ends a hung process-table read at its bound and signals nothing",
  async () => {
    const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "never-marked"], {
      stdio: "ignore",
    });
    try {
      const sent = await expectBoundKillsShim("ps", (timeoutMs) =>
        endOwnedProcess(foreign.pid, "never-marked", { timeoutMs }),
      );
      expect(sent).toBe(false);
      expect(foreign.signalCode).toBeNull();
    } finally {
      foreign.kill("SIGKILL");
    }
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies each shim call leaves a record with its claimed number and pid, so a
// failed run can say how many calls never reached the shim (issue #1258); no other test reads it.
test.skipIf(process.platform === "win32")(
  "withGitHangingAfter records the claimed number and pid of each call",
  async () => {
    await withGitHangingAfter(2, async ({ shimDir }) => {
      for (let call = 0; call < 2; call += 1) {
        await execa("git", ["--version"]);
      }
      const found = await shimCallRecords(shimDir);
      expect(found.map((record) => record.number).sort((a, b) => a - b)).toEqual([0, 1]);
      expect(found.every((record) => Number.isInteger(record.pid) && record.pid > 0)).toBe(true);
    });
  },
  30_000,
);

// Usefulness: verifies the shim writes a marker named by the pid of the call. The failure message
// of the 60-call test (issue #1258) reads the markers, and the record test does not cover them.
test.skipIf(process.platform === "win32")(
  "withGitHangingAfter marks the start of each shim call with the pid of the call",
  async () => {
    await withGitHangingAfter(1, async ({ shimDir }) => {
      const call = execa("git", ["--version"]);
      const { pid } = call;
      await call;
      expect(await shimStartPids(shimDir)).toEqual([pid]);
    });
  },
  30_000,
);

// Usefulness: verifies a marker that cannot be written leaves the claim unchanged (issue #1258).
// A diagnostic must not alter the path of a call, and the marker test above writes it.
test.skipIf(process.platform === "win32")(
  "withGitHangingAfter still claims a number when the start marker cannot be written",
  async () => {
    await withGitHangingAfter(1, async ({ shimDir }) => {
      await rm(join(shimDir, "started"), { recursive: true });
      await writeFile(join(shimDir, "started"), "");
      const call = await execa("git", ["--version"], { reject: false, timeout: 5000 });
      expect(call.exitCode).toBe(0);
      expect((await shimCallRecords(shimDir)).map((record) => record.number)).toEqual([0]);
    });
  },
  30_000,
);

// Usefulness: verifies each call writes its start and claim steps, so a failure can name the last
// step a call recorded (issue #1258). The record test reads the claim only, and no other test
// reads the steps.
test.skipIf(process.platform === "win32")(
  "withGitHangingAfter records the start and the claim of each call",
  async () => {
    await withGitHangingAfter(2, async ({ shimDir }) => {
      const calls = [execa("git", ["--version"]), execa("git", ["--version"])];
      const pids = calls.map((call) => call.pid);
      await Promise.all(calls);
      const steps = await shimCallSteps(shimDir);
      expect([...steps.keys()].sort((a, b) => a - b)).toEqual([...pids].sort((a, b) => a - b));
      for (const pid of pids) {
        expect(steps.get(pid)).toHaveLength(2);
        expect(steps.get(pid)[0]).toMatch(/^start \d+$/);
        expect(steps.get(pid)[1]).toMatch(/^claimed \d+$/);
      }
    });
  },
  30_000,
);

// Usefulness: verifies a call counts a number only when its own directory and record exist. The
// test injects one `mkdir` that reports success without the directory. An exit-0 call without its
// record fails here (issue #1258).
test.skipIf(process.platform === "win32")(
  "withGitHangingAfter claims a number only when its call directory holds its record",
  async () => {
    await withGitHangingAfter(1, async ({ shimDir }) => {
      // The shim resolves `mkdir` through `shimDir` first. The first call to create call-0 is told
      // that it succeeded without a directory, and every later call gets the real `mkdir`. The
      // noclobber create makes exactly one call take the lie, also when calls start at once.
      const realMkdir = existsSync("/bin/mkdir") ? "/bin/mkdir" : "/usr/bin/mkdir";
      await writeFile(
        join(shimDir, "mkdir"),
        [
          "#!/bin/sh",
          `if [ "$1" = '${shimDir}/call-0' ] && (set -C; : > '${shimDir}/lied') 2>/dev/null; then`,
          "  exit 0",
          "fi",
          `exec '${realMkdir}' "$@"`,
        ].join("\n"),
        { mode: 0o755 },
      );
      const calls = await Promise.all([
        execa("git", ["--version"], { reject: false, timeout: 5000 }),
        execa("git", ["--version"], { reject: false, timeout: 5000 }),
      ]);
      const records = await shimCallRecords(shimDir);
      expect(calls.filter((call) => call.exitCode === 0)).toHaveLength(1);
      expect(records.map((record) => record.number).sort((a, b) => a - b)).toEqual([0, 1]);
    });
  },
  30_000,
);

// Usefulness: verifies the shim of withGitHangingAfter lets exactly `passes` calls through when
// calls start at once, as the concurrent reads of one snapshot do. A call counter that is not
// atomic loses updates and can read a half-written count, so a snapshot read that must pass hangs,
// or one that must hang passes (the CI failure of "a second cancel ends a hung evidence snapshot").
test.skipIf(process.platform === "win32")(
  "withGitHangingAfter passes exactly the requested number of concurrent calls",
  async () => {
    const passes = 30;
    await withGitHangingAfter(passes, async ({ shimDir }) => {
      // GIT_TRACE2_EVENT makes a real `git` write `trace-<index>`, with or without the shim.
      const running = Array.from({ length: 2 * passes }, (_, index) =>
        execa("git", ["--version"], {
          reject: false,
          timeout: 5000,
          env: { GIT_TRACE2_EVENT: join(shimDir, `trace-${index}`) },
        }),
      );
      const pids = running.map((call) => call.pid);
      const calls = await Promise.all(running);
      // The message names the call-* counts, the marker and step counts, and each exit code. It also
      // names the steps of each call without a record, so a CI recurrence records them. The reads
      // never throw, so the assertion below always runs. A timed-out call shows as "timeout".
      const names = await readdir(shimDir).catch(() => undefined);
      const claimed = names?.filter((name) => name.startsWith("call-")).length;
      const records = await shimCallRecords(shimDir).catch(() => undefined);
      const markers = await shimStartPids(shimDir).catch(() => undefined);
      const steps = await shimCallSteps(shimDir).catch(() => undefined);
      const codes = calls.map((call) => call.exitCode ?? (call.timedOut ? "timeout" : "undefined"));
      const loggedClaims =
        steps === undefined
          ? "unreadable"
          : [...steps.values()].filter((lines) => lines.some((line) => line.startsWith("claimed ")))
              .length;
      // Each call without a record shows as index:pid:exit code:marker state:trace state:steps. Each
      // state is what the read found: present, absent, or unreadable. An absent file is an
      // observation only.
      const state = (found) => (found === undefined ? "unreadable" : found ? "present" : "absent");
      const unrecorded = calls
        .map((_, index) => index)
        .filter((index) => !records?.some((record) => record.pid === pids[index]))
        .map((index) => {
          const marker = state(markers?.includes(pids[index]));
          const trace = state(names?.includes(`trace-${index}`));
          const reached =
            steps === undefined ? "unreadable" : (steps.get(pids[index]) ?? ["absent"]).join("|");
          return `${index}:${pids[index]}:exit ${codes[index]}:marker ${marker}:trace ${trace}:steps ${reached}`;
        });
      const message = records
        ? `call-* directories: ${claimed}; call-* directories without a record: ${claimed - records.length}; start markers: ${markers?.length}; step records: ${steps?.size}; claims logged: ${loggedClaims}; calls without a shim record: ${unrecorded.length} [${unrecorded.join(" ")}]; exit codes: ${codes.join(",")}`
        : `the shim records or directory were unreadable; exit codes: ${codes.join(",")}`;
      expect(
        calls.filter((call) => call.exitCode === 0),
        message,
      ).toHaveLength(passes);
    });
  },
  30_000,
);
