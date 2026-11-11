import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { pidAlive } from "../src/lib/process-identity.mjs";
import { BOUND_KILL_TEST_TIMEOUT_MS, expectBoundKillsShim } from "./process-helpers.mjs";
import { pollUntil } from "./wait-helpers.mjs";

// Usefulness: no other test reads the parent PATH or child env during a bound-kill call, so concurrent callers stay independent.
test.concurrent(
  "expectBoundKillsShim leaves the parent PATH unchanged and passes the shim in the child env",
  async () => {
    const before = process.env.PATH;
    let seen;
    await expectBoundKillsShim("env-shim", async (boundMs, { env, shimDir }) => {
      seen = { parent: process.env.PATH, env };
      const held = execa("env-shim", { reject: false, env });
      held.catch(() => {});
      await pollUntil(
        async () => (existsSync(join(shimDir, "started.txt")) ? true : undefined),
        10_000,
      );
    }).catch(() => {});
    expect(seen.parent).toBe(before);
    const key = Object.keys(seen.env).find((name) => name.toUpperCase() === "PATH");
    expect(seen.env[key].split(delimiter)[0]).toMatch(/hang-env-shim-/);
    expect(seen.env[key].split(delimiter).slice(1).join(delimiter)).toBe(before);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670) — cleanup after a failed kill check must end the shim child and free
// its directory. It must not return while the shim lives, and it must not signal a pid that a file
// supplied. A pid that a file names can belong to an unrelated process once the shim exits.
// A SIGKILL read from the record is therefore the defect.
test.concurrent(
  "expectBoundKillsShim ends a surviving shim without signalling a recorded pid",
  async () => {
    const kill = vi.spyOn(process, "kill");
    let held;
    let shimDir;
    let pid;
    try {
      const failure = await expectBoundKillsShim("leftover-shim", async (boundMs, shim) => {
        shimDir = shim.shimDir;
        held = execa("leftover-shim", { reject: false, env: shim.env });
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
// directory stays. A Windows lock on a file inside the directory leaves it in that state.
// The call under test deletes the keep file and nothing else, so the helper passes only if the shim
// exits on its own.
test.concurrent(
  "expectBoundKillsShim sees a shim end when its keep file is deleted and its directory stays",
  async () => {
    await expect(
      expectBoundKillsShim("keepless-shim", async (boundMs, { env, shimDir }) => {
        const held = execa("keepless-shim", { reject: false, env });
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

// Starts a shim whose `keep` file is replaced by a directory, so the shim stays alive.
// Cleanup cannot remove the keep file, and the shim cannot acknowledge an exit.
// `after` runs in the call under test.
async function blockedShimFailure(after) {
  let shimDir;
  const failure = await expectBoundKillsShim(
    "blocked-shim",
    async (boundMs, shim) => {
      shimDir = shim.shimDir;
      const held = execa("blocked-shim", { reject: false, env: shim.env });
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
    },
    undefined,
    { shimExitWaitMs: 100 },
  ).then(
    () => undefined,
    (error) => error,
  );
  return { failure, shimDir };
}

// Usefulness: acceptance (#670 review) — a failed test body must not hide a shim that survives
// cleanup, so both errors reach the report.
test.concurrent(
  "expectBoundKillsShim reports a shim that does not exit even when the test body failed",
  async () => {
    const { failure } = await blockedShimFailure(async () => {
      throw new Error("body failed first");
    });
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = failure.errors.map((error) => error.message);
    expect(messages).toContain("body failed first");
    // The injected cleanup wait is 100 ms, so the message must name that short bound (issue #1465).
    const survivor = messages.find((message) =>
      /did not exit within 100 ms of cleanup/.test(message),
    );
    expect(survivor).toMatch(/pid \d+/);
    expect(survivor).toMatch(/hard wall-clock deadline of \d+ s ends it/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — an error from removing the keep file must not skip the
// directory removal, and must itself be reported.
test.concurrent(
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

// Usefulness: acceptance (#670 review) — a missing pid record is not proof that the shim ended.
// The cleanup reports an unconfirmed exit instead of passing silently.
test.concurrent(
  "expectBoundKillsShim reports an unconfirmed exit when the pid record is missing",
  async () => {
    const failure = await expectBoundKillsShim("recordless-shim", async (boundMs, shim) => {
      const held = execa("recordless-shim", { reject: false, env: shim.env });
      held.catch(() => {});
      const started = join(shim.shimDir, "started.txt");
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
// code under test. The kill check must fail instead of accepting the exit as a kill.
// The call under test never kills the shim and returns only after the shim has gone.
test.concurrent(
  "expectBoundKillsShim fails when the shim exits on its ceiling instead of being killed",
  async () => {
    const failure = await expectBoundKillsShim(
      "ceiling-shim",
      async (boundMs, { env, shimDir }) => {
        const held = execa("ceiling-shim", { reject: false, env });
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

const CEILING_MS = 500;
const HARD_DEADLINE_MS = 8000;
// Usefulness: acceptance (#670 review) — a shim whose ceiling marker cannot be written must not
// exit silently. Otherwise the kill check reads its ceiling exit as a kill.
// The marker path is a directory, so the write fails.
// The shim must stay alive past its ceiling and the helper must report it.
test.concurrent(
  "expectBoundKillsShim fails when the ceiling marker cannot be written",
  async () => {
    const failure = await expectBoundKillsShim(
      "markerless-shim",
      async (boundMs, { env, shimDir }) => {
        await mkdir(join(shimDir, "ceiling"));
        const held = execa("markerless-shim", { reject: false, env });
        held.catch(() => {});
        const started = join(shimDir, "started.txt");
        await pollUntil(async () => (existsSync(started) ? true : undefined), 10_000);
        // Past the ceiling, while the hard exit bound leaves room for a slow runner.
        await delay(CEILING_MS + 200);
      },
      undefined,
      { ceilingMs: CEILING_MS, hardDeadlineMs: HARD_DEADLINE_MS },
    ).then(
      () => undefined,
      (error) => error,
    );
    expect(failure?.message).toMatch(/outlived the 1000 ms force-kill boundary/);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: acceptance (#670 review) — a shim that keeps failing to write its ceiling marker must
// still end on its own. Otherwise a survivor lives without limit.
// The marker path is a directory, so the write never succeeds.
// The shim must still exit at its hard deadline, never before its ceiling.
test.concurrent(
  "a shim whose ceiling marker cannot be written still ends at its hard deadline",
  async () => {
    let lived;
    await expectBoundKillsShim(
      "endless-shim",
      async (boundMs, { env, shimDir }) => {
        await mkdir(join(shimDir, "ceiling"));
        const held = execa("endless-shim", { reject: false, env });
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

// Usefulness: acceptance (#670 review) — an exit that is not proven to precede the shim's ceiling
// must not pass as a kill. The marker path is a directory, so a hard-deadline exit leaves no marker.
// The call returns only after that exit, as a delayed record read or a paused parent does.
test.concurrent(
  "expectBoundKillsShim fails when the shim exit is first observed after its ceiling",
  async () => {
    const failure = await expectBoundKillsShim(
      "late-shim",
      async (boundMs, { env, shimDir }) => {
        await mkdir(join(shimDir, "ceiling"));
        const held = execa("late-shim", { reject: false, env });
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
