import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { DRAIN_DEADLINE_MS, startMainWorkTreeWatch } from "../../src/lib/main-work-tree-watch.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { processExists } from "../process-helpers.mjs";

let dir;
afterEach(async () => {
  if (dir) await removePath(dir);
  dir = undefined;
});

// Usefulness: verifies requirement "a write after a reopened watch is reported" (issue #1628).
// A dropped first event leaves the restored path out of the field.
test("a write after a reopened watch is reported", async () => {
  dir = await createTempRepo();
  // The first watch models the watch that the previous turn closed.
  const first = await startMainWorkTreeWatch(dir);
  await first.take();
  const fake = createArmingWatch();
  const handle = await startMainWorkTreeWatch(dir, { watchFactory: fake.factory });
  writeFileSync(join(dir, "one.txt"), "written\n");
  fake.deliver("change", "one.txt");
  const result = await handle.take();
  expect(result).toEqual({ candidates: ["one.txt"], failed: false });
});

// Usefulness: verifies requirement "a cancel during the ready wait reports no field" (issue
// #1628). A cancel must end the wait and close the watch without a path.
test("a cancel during the ready wait returns no handle", async () => {
  dir = await createTempRepo();
  const fake = createControlledWatch();
  const abort = new AbortController();
  const starting = startMainWorkTreeWatch(dir, {
    watchFactory: fake.factory,
    signal: abort.signal,
  });
  abort.abort();
  await expect(starting).resolves.toBeNull();
  expect(fake.closed()).toBe(true);
});

// Usefulness: verifies requirement "a watch error before ready reports no field and warns" (issue
// #1628). A silent error reads as no main work tree change.
test("a watch error before ready reports no field and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const fake = createControlledWatch();
  const starting = startMainWorkTreeWatch(dir, { watchFactory: fake.factory });
  fake.emitError(new Error("stream failed"));
  const handle = await starting;
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "a watch close before ready reports no field and warns" (issue
// #1628). A watch that ends before the turn read it must not report a path.
test("a watch close before ready reports no field and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const fake = createControlledWatch();
  const starting = startMainWorkTreeWatch(dir, { watchFactory: fake.factory });
  fake.emitClose();
  const handle = await starting;
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "a missed arm deadline reports no field and warns" (issue
// #1628). A `ready` promise that never resolves must not hold the turn or report a path.
test("a missed arm deadline reports no field and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const fake = createControlledWatch();
  const handle = await startMainWorkTreeWatch(dir, {
    watchFactory: fake.factory,
    armDeadlineMs: 20,
  });
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => /arm/i.test(String(call[0])))).toBe(true);
});

// Usefulness: verifies requirement "a turn that writes nothing reports no candidate" (issue
// #1628). The ready wait must not need a write or turn an idle turn into a failure.
test("a turn that writes nothing reports no candidate", async () => {
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir);
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: false });
});

/** A fake watch whose `ready` never resolves, so only a failure, close, or cancel ends the wait. */
function createControlledWatch() {
  const watcher = new EventEmitter();
  let closed = false;
  watcher.close = () => {
    closed = true;
  };
  const ready = new Promise(() => {});
  return {
    factory: (_root, onEvent) => {
      watcher.on("change", onEvent);
      return { watcher, ready };
    },
    closed: () => closed,
    emitError: (err) => watcher.emit("error", err),
    emitClose: () => watcher.emit("close"),
  };
}

/** A fake watch that drops every event until its `ready` resolves on the next turn. */
function createArmingWatch() {
  let fake;
  const factory = (_root, onEvent) => {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    watcher.on("change", onEvent);
    let armed = false;
    const ready = new Promise((resolve) => {
      setImmediate(() => {
        armed = true;
        resolve();
      });
    });
    fake = {
      watcher,
      deliver: (type, filename) => {
        if (armed) watcher.emit("change", type, filename);
      },
    };
    return { watcher, ready };
  };
  return { factory, deliver: (type, filename) => fake.deliver(type, filename) };
}

// Usefulness: verifies requirement "a watch that fails to start reports no field and warns" (issue
// #1556). A silent start failure reads as no main work tree change.
test("a watch that fails to start warns and returns no handle", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "main-watch-"));
  const handle = await startMainWorkTreeWatch(join(dir, "missing"));
  expect(handle).toBeNull();
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "a pending overflow reports no field and warns" (issue #1556).
// An unbounded queue can grow with a large write burst and outlive the turn.
test("a pending overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "main-watch-"));
  const handle = await startMainWorkTreeWatch(dir, { maxPending: 0 });
  await vi.waitFor(
    async () => {
      await writeFile(join(dir, "one.txt"), "one\n");
      expect(warn.mock.calls.some((call) => /queued paths/i.test(String(call[0])))).toBe(true);
    },
    { timeout: 5_000 },
  );
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
});

// Usefulness: verifies requirement "a seen-file overflow reports no field and warns" (issue #1556).
// A silent drop loses a path that an in-window read saw.
test("a seen-file overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir, { maxSeenFiles: 0 });
  await vi.waitFor(
    async () => {
      await writeFile(join(dir, "one.txt"), "one\n");
      expect(warn.mock.calls.some((call) => /seen files/i.test(String(call[0])))).toBe(true);
    },
    { timeout: 5_000 },
  );
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
});

// Usefulness: verifies requirement "a candidate overflow reports no field and warns" (issue #1556).
// A silent drop of a non-ignored path leaves the field incomplete.
test("a candidate overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir, { maxCandidates: 0 });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const result = await handle.take();
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => /changed paths/i.test(String(call[0])))).toBe(true);
});

// Usefulness: verifies requirement "a read overflow reports no field and warns" (issue #1556). A
// silent drop of an unread path leaves the field incomplete.
test("a read overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir, { maxReads: 0 });
  await vi.waitFor(
    async () => {
      await writeFile(join(dir, "one.txt"), "one\n");
      expect(warn.mock.calls.some((call) => /reads/i.test(String(call[0])))).toBe(true);
    },
    { timeout: 5_000 },
  );
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
});

/** Writes `path` until the watch queues the event, so a late watch start cannot miss the write. */
async function writeUntilQueued(handle, path) {
  await vi.waitFor(
    async () => {
      await writeFile(path, "queued\n");
      expect(handle.pendingCount()).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
}

// Usefulness: verifies requirement "a file created and removed inside the window is reported"
// (issue #1556). An in-window read saw the file, so its path belongs in the field.
test("a file created and removed inside the window is reported", async () => {
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir, { drainDeadlineMs: 60_000 });
  await writeUntilQueued(handle, join(dir, "scratch.txt"));
  await vi.waitFor(() => expect(handle.seenFileCount()).toBeGreaterThan(0), { timeout: 2_000 });
  await rm(join(dir, "scratch.txt"), { force: true });
  const result = await handle.take();
  expect(result).toEqual({ candidates: ["scratch.txt"], failed: false });
});

// Usefulness: verifies requirement "a restored edit that preserves the modification time is
// reported" (issue #1712). A copy that preserves times leaves the modification time before the
// window, so a rule that reads the modification time alone drops the path. The change time still
// records the in-window write.
test("a restored edit that preserves the modification time is reported", async () => {
  dir = await createTempRepo();
  const file = join(dir, "init.txt");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(file, old, old);
  const handle = await startMainWorkTreeWatch(dir, { drainDeadlineMs: 60_000 });
  await vi.waitFor(
    async () => {
      await writeFile(file, "changed\n");
      await writeFile(file, "hello\n");
      await utimes(file, old, old);
      expect(handle.seenFileCount()).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
  const result = await handle.take();
  expect(result).toEqual({ candidates: ["init.txt"], failed: false });
});

// Usefulness: verifies requirement "a direct stop before take reports a failure and warns" (issue
// #1556). A stop that no read failure explains must still log the watch warning.
test("a direct stop before take reports a failure and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir);
  await writeUntilQueued(handle, join(dir, "one.txt"));
  await handle.stop();
  const result = await handle.take();
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies that a timestamp-preserving change made just before the watch starts is not
// reported by a later read-only access (issue #1712 review). The file system change time has
// sub-millisecond precision and can lead the whole-millisecond Date.now(), so a change completed
// before the start can carry a change time after it. The loop repeats the start, because a single
// start can land after the change by more than the guard.
test("a timestamp-preserving change in the start millisecond reports no candidate", async () => {
  dir = await createTempRepo();
  const file = join(dir, "init.txt");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  let reported = false;
  for (let attempt = 0; attempt < 20 && !reported; attempt++) {
    // A copy that preserves times completes immediately before the watch starts.
    await writeFile(file, "copied\n");
    await writeFile(file, "hello\n");
    await utimes(file, old, old);
    const fake = createArmingWatch();
    const handle = await startMainWorkTreeWatch(dir, {
      drainDeadlineMs: 60_000,
      watchFactory: fake.factory,
    });
    // A read-only access moves only the access time.
    fake.deliver("change", "init.txt");
    await vi.waitFor(() => expect(handle.seenFileCount()).toBeGreaterThan(0), {
      timeout: 5_000,
      interval: 1,
    });
    const result = await handle.take();
    reported = result.candidates.includes("init.txt");
  }
  expect(reported).toBe(false);
});

// Usefulness: verifies acceptance "On Windows, a read of a main work tree file inside a turn
// window does not appear in mainWorkTreeChangedInTurn" (issue #1583). A read moves only the access
// time, so the state, size, modification time, and change time stay equal and the watch must report
// no path. The delivered event models the Windows access-time event, because a test that resets the
// access time inside the window would itself move the change time.
test("a read-only access of a watched file reports no candidate", async () => {
  dir = await createTempRepo();
  const file = join(dir, "init.txt");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(file, old, old);
  const fake = createArmingWatch();
  const handle = await startMainWorkTreeWatch(dir, {
    drainDeadlineMs: 60_000,
    watchFactory: fake.factory,
  });
  fake.deliver("change", "init.txt");
  await vi.waitFor(() => expect(handle.seenFileCount()).toBeGreaterThan(0), { timeout: 5_000 });
  const result = await handle.take();
  expect(result).toEqual({ candidates: [], failed: false });
});

// Usefulness: verifies requirement "repeated events for one path queue one read" (issue #1556). A
// burst for one open path must not grow the queue or repeat the real Git read.
test("repeated events for one path queue one read", async () => {
  dir = await createTempRepo();
  let reads = 0;
  const handle = await startMainWorkTreeWatch(dir, {
    drainDeadlineMs: 60_000,
    beforeIgnoreInputEnds: async () => {
      reads++;
    },
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  for (let index = 0; index < 50; index++) {
    await writeFile(join(dir, "one.txt"), `change-${index}\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(handle.pendingCount()).toBe(1);
  const result = await handle.take();
  expect(reads).toBe(1);
  expect(result).toEqual({ candidates: ["one.txt"], failed: false });
});

// Usefulness: verifies requirement "a writer cannot extend the turn" (issue #1556). A build writer
// that rewrites ignored output must not refill the queue after the turn ends.
test("a writer that rewrites ignored files cannot extend the turn", async () => {
  dir = await createTempRepo();
  await writeFile(join(dir, ".git", "info", "exclude"), "ignored-*\n");
  const handle = await startMainWorkTreeWatch(dir);
  await writeUntilQueued(handle, join(dir, "ignored-0.txt"));
  let running = true;
  const writeLoop = async () => {
    let index = 1;
    while (running) {
      await writeFile(join(dir, `ignored-${index++}.txt`), "write\n").catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const writing = writeLoop();
  try {
    const started = performance.now();
    const result = await handle.take();
    expect(performance.now() - started).toBeLessThan(DRAIN_DEADLINE_MS + 1_000);
    expect(result).toEqual({ candidates: [], failed: false });
  } finally {
    running = false;
    await writing;
    await handle.stop();
  }
});

// Usefulness: verifies requirement "a write after the turn end is not reported" (issue #1556). The
// watcher closes first, so a later write cannot join the drain.
test("a write after the turn end is not reported", async () => {
  dir = await createTempRepo();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  const handle = await startMainWorkTreeWatch(dir, {
    drainDeadlineMs: 60_000,
    beforeIgnoreInputEnds: async () => {
      started();
      await hold;
    },
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const taking = handle.take();
  try {
    await startedP;
    const queued = handle.pendingCount();
    await writeFile(join(dir, "late-new.txt"), "late\n");
    const until = performance.now() + 500;
    while (performance.now() < until && handle.pendingCount() === queued) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(handle.pendingCount()).toBe(queued);
  } finally {
    release();
  }
  const result = await taking;
  expect(result.failed).toBe(false);
});

// Usefulness: verifies requirement "a missed drain deadline reports no field and warns" (issue
// #1556). A read that never settles must not hold the turn past its bound.
test("a missed drain deadline reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = await startMainWorkTreeWatch(dir, {
    beforeIgnoreInputEnds: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const started = performance.now();
  const result = await handle.take();
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(DRAIN_DEADLINE_MS - 100);
  expect(elapsed).toBeLessThan(DRAIN_DEADLINE_MS + 1_000);
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "the drain deadline covers a held file read" (issue #1556). A
// classification read that never settles must not hold the turn past the deadline.
test("the drain deadline covers a held file read", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  const handle = await startMainWorkTreeWatch(dir, {
    beforeFileKind: async ({ signal }) => {
      started();
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  await startedP;
  const startedAt = performance.now();
  const result = await handle.take();
  const elapsed = performance.now() - startedAt;
  expect(elapsed).toBeGreaterThanOrEqual(DRAIN_DEADLINE_MS - 100);
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "stop ends a real Git child held in flight" (issue #1556). A
// read that outlives the turn can hold a handle or a child after the turn ends.
test("stop ends a real Git child held in flight", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let pid;
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  const handle = await startMainWorkTreeWatch(dir, {
    beforeIgnoreInputEnds: async ({ pid: childPid }) => {
      pid = childPid;
      started();
      await hold;
    },
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const taking = handle.take();
  try {
    await startedP;
    expect(processExists(pid)).toBe(true);
    const stopping = handle.stop();
    await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 2_000 });
    release();
    await stopping;
    const result = await taking;
    expect(result).toEqual({ candidates: [], failed: true });
    expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
      true,
    );
  } finally {
    release();
  }
});
