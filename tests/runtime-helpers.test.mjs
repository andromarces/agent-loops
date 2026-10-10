import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
