import { getEventListeners } from "node:events";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { batchPaths, readLoop, readManifest, updateLoop } from "../../src/batch/store.mjs";
import { newBatchId, runBatch } from "../../src/batch/supervisor.mjs";
import { removePath } from "../fs-helpers.mjs";
import { pollUntil } from "../wait-helpers.mjs";
import {
  batchRepo,
  childDouble,
  deferred,
  fakeGh,
  fakeGitDeps,
  noNotify,
  preparedFor,
  waitForLaunch,
  valueAfter,
} from "./supervisor-helpers.mjs";

// A test arms one checkpoint write failure by file suffix. Every other write runs as before.
const checkpointWrite = vi.hoisted(() => ({ suffix: null, error: null, fired: false }));

vi.mock("../../src/lib/atomic-write.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileAtomic: async (file, text, options) => {
      const armed = checkpointWrite.suffix;
      if (!checkpointWrite.fired && armed !== null && String(file).endsWith(armed)) {
        checkpointWrite.fired = true;
        throw checkpointWrite.error;
      }
      return actual.writeFileAtomic(file, text, options);
    },
  };
});

function failCheckpointWrite(suffix, error) {
  checkpointWrite.suffix = suffix;
  checkpointWrite.error = error;
  checkpointWrite.fired = false;
}

describe("bounded batch reads", () => {
  let prepared;
  beforeAll(async () => {
    prepared = await preparedFor(await batchRepo(), [1]);
  });

  const runsRootFor = (name) => join(prepared.workTreeRoot, `runs-${name}`);
  const replyOnAbort =
    (reply) =>
    (args, cwd, options = {}) =>
      new Promise((resolve) => {
        const end = () => resolve(reply);
        if (options.signal?.aborted) end();
        else options.signal?.addEventListener("abort", end, { once: true });
      });

  // Usefulness: a gh read that never returns ends at the bound, so the batch cannot hang.
  test("a gh read that never returns ends at the bound", async () => {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: runsRootFor("bound"),
      gh: replyOnAbort({ status: null, stdout: "", stderr: "", timedOut: true }),
      deps: { notifier: noNotify, installSignal: false, ghTimeoutMs: 20 },
    });
    expect(exitCode).toBe(0);
    expect(summary.loops[0].skipReason).toBe("eligibility-unverified");
    expect(summary.loops[0].reason).toContain("timed out after 20ms");
  });

  // Usefulness: a refused preflight removes its SIGINT and abort listeners.
  test("a refused preflight removes its listeners", async () => {
    const signal = new AbortController().signal;
    const before = process.listenerCount("SIGINT");
    const { exitCode } = await runBatch({
      prepared,
      runsRoot: runsRootFor("listeners-refused"),
      gh: replyOnAbort({ status: null, stdout: "", stderr: "", timedOut: true }),
      deps: { notifier: noNotify, ghTimeoutMs: 20, signal },
    });
    expect(exitCode).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  // Usefulness: an already-aborted run signal ends the batch interrupted with exit 130.
  test("an already-aborted run signal ends the batch interrupted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("stopped before preflight"));
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: runsRootFor("aborted-before"),
      gh: replyOnAbort({ status: 0, stdout: JSON.stringify({ number: 1 }), stderr: "" }),
      deps: { notifier: noNotify, installSignal: false, signal: abort.signal },
    });
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
  });

  // Usefulness: an abort during a hung preflight read ends interrupted with exit 130.
  test("an abort during a hung preflight read ends interrupted", async () => {
    const abort = new AbortController();
    const before = process.listenerCount("SIGINT");
    let started = false;
    const gh = (args, cwd, options = {}) => {
      if (!started) {
        started = true;
        setTimeout(() => abort.abort(new Error("stopped in preflight")), 10);
      }
      return replyOnAbort({ status: 0, stdout: JSON.stringify({ number: 1 }), stderr: "" })(
        args,
        cwd,
        options,
      );
    };
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: runsRootFor("aborted-during"),
      gh,
      deps: { notifier: noNotify, signal: abort.signal, ghTimeoutMs: 60_000 },
    });
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  // Usefulness: an interrupt during the second preflight keeps the refused and aborted entries.
  test("an interrupt during the second preflight keeps both entries", async () => {
    const four = {
      ...prepared,
      id: newBatchId(),
      issues: [1, 2, 3, 4],
      items: [1, 2, 3, 4].map((number) => ({
        kind: "issue",
        number,
        key: number,
        mode: "work-first",
        task: null,
      })),
      loops: 4,
    };
    const abort = new AbortController();
    const gh = (args, cwd, options = {}) => {
      if (args[0] === "pr" && args[1] === "view") {
        const number = Number(args[2]);
        if (number === 2) {
          setTimeout(() => abort.abort(new Error("stopped in preflight")), 10);
          return replyOnAbort({ status: 0, stdout: JSON.stringify({ number }), stderr: "" })(
            args,
            cwd,
            options,
          );
        }
        return { status: 0, stdout: JSON.stringify({ number }), stderr: "" };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    const { exitCode, summary } = await runBatch({
      prepared: four,
      runsRoot: runsRootFor("interrupt-second"),
      gh,
      deps: {
        notifier: noNotify,
        installSignal: false,
        signal: abort.signal,
        ghTimeoutMs: 60_000,
      },
    });
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(summary.loops).toHaveLength(2);
    expect(summary.loops[0]).toMatchObject({ issue: 1, skipReason: "is-pull-request" });
    expect(summary.loops[1]).toMatchObject({ issue: 2, skipReason: "eligibility-unverified" });
  });

  // Usefulness: out-of-order freeze replies keep the input item order.
  test("out-of-order freeze replies keep the item order", async () => {
    const prItems = [1, 2, 3].map((number) => ({
      kind: "pr",
      number,
      key: `pr-${number}`,
      mode: "review-first",
      task: null,
      head: null,
    }));
    const three = {
      ...prepared,
      id: newBatchId(),
      issues: prItems.map((item) => item.key),
      items: prItems,
      loops: 3,
    };
    const gh = (args) =>
      new Promise((resolve) => {
        const number = Number(args[2]);
        setTimeout(
          () =>
            resolve({
              status: 0,
              stdout: JSON.stringify({ state: "OPEN", headRefName: `branch-${number}` }),
              stderr: "",
            }),
          (4 - number) * 20,
        );
      });
    const { summary } = await runBatch({
      prepared: three,
      runsRoot: runsRootFor("freeze-order"),
      gh,
      deps: { notifier: noNotify, installSignal: false },
    });
    expect(summary.loops.map((loop) => loop.number)).toEqual([1, 2, 3]);
  });

  // Usefulness: a cancel during freeze returns the origin/main interrupted result.
  test("a cancel during freeze returns the interrupted result", async () => {
    const prItems = [1, 2, 3].map((number) => ({
      kind: "pr",
      number,
      key: `pr-${number}`,
      mode: "review-first",
      task: null,
      head: null,
    }));
    const three = {
      ...prepared,
      id: newBatchId(),
      issues: prItems.map((item) => item.key),
      items: prItems,
      loops: 3,
    };
    const abort = new AbortController();
    let started = 0;
    const gh = (args, cwd, options = {}) => {
      started += 1;
      if (started === 1) setTimeout(() => abort.abort(new Error("stopped in freeze")), 10);
      return replyOnAbort({
        status: 0,
        stdout: JSON.stringify({ state: "OPEN", headRefName: "branch" }),
        stderr: "",
      })(args, cwd, options);
    };
    const { exitCode, summary } = await runBatch({
      prepared: three,
      runsRoot: runsRootFor("freeze-cancel"),
      gh,
      deps: {
        notifier: noNotify,
        installSignal: false,
        signal: abort.signal,
        ghTimeoutMs: 60_000,
      },
    });
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(summary.loops).toEqual([]);
  });

  // Usefulness: a fetch failure removes the SIGINT and abort listeners before it rejects.
  test("a preflight throw removes its listeners", async () => {
    const signal = new AbortController().signal;
    const before = process.listenerCount("SIGINT");
    const head = "a".repeat(40);
    const item = {
      kind: "pr",
      number: 7,
      key: "pr-7",
      mode: "review-first",
      task: null,
      head,
      headRefName: "pr-7",
      foreign: false,
    };
    const gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: head,
            headRefName: "pr-7",
            isCrossRepository: false,
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    await expect(
      runBatch({
        prepared,
        runsRoot: runsRootFor("fetch-throw"),
        gh,
        deps: {
          notifier: noNotify,
          signal,
          freezeItems: async () => [item],
          planPrWorkTree: async () => {
            throw new Error("the git fetch failed");
          },
        },
      }),
    ).rejects.toThrow("the git fetch failed");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  // Seeds two queued loops, with a recorded work tree on issue 2, so a resume stops there.
  async function seedThrowState(two, runsRoot) {
    await runBatch({
      prepared: two,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const recorded = {
      path: join(prepared.workTreeRoot, "issue-2"),
      canonicalPath: join(prepared.workTreeRoot, "issue-2"),
      dev: "1",
      ino: "1",
      branch: `batch/${two.id}/2`,
    };
    for (const issue of [1, 2]) {
      await removePath(batchPaths(runsRoot).transcript(two.id, issue));
      await updateLoop(runsRoot, two.id, issue, (loop) => ({
        ...loop,
        status: "queued",
        attempts: 0,
        pid: null,
        startTime: null,
        workTree: issue === 2 ? recorded : null,
        cleanup: null,
      }));
    }
    return recorded;
  }

  // Usefulness: a throw with one live child forwards SIGINT, records interrupted, and a resume
  // continues that loop from its transcript.
  test("a throw with a live child stops it and a resume continues it", async () => {
    const two = { ...prepared, id: newBatchId(), issues: [1, 2], loops: 2 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${two.id}`);
    const makeTree = async ({ workTree, branch }) => {
      await mkdir(workTree, { recursive: true });
      return { path: workTree, canonicalPath: workTree, dev: "1", ino: "1", branch };
    };
    await seedThrowState(two, runsRoot);
    const child = childDouble({ steps: 3, hold: true });
    const stops = [];
    const spawn = async (options) => {
      const started = await child.spawn(options);
      return {
        ...started,
        kill: (signal) => {
          stops.push(signal);
          started.kill(signal);
        },
      };
    };
    const abort = new AbortController();
    const failure = new Error("the git fetch failed");
    const before = process.listenerCount("SIGINT");
    const run = runBatch({
      prepared: { ...two, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        signal: abort.signal,
        createWorkTree: makeTree,
        verifyWorkTree: async (loop) => {
          if (loop.issue === 2) throw failure;
          return null;
        },
      },
    });
    await expect(run).rejects.toBe(failure);
    expect(stops).toEqual(["SIGINT"]);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    const loop = await readLoop(runsRoot, two.id, 1);
    expect(loop.status).toBe("interrupted");
    expect(loop.reason).toBe("interrupted");
    expect((await readManifest(runsRoot, two.id)).status).toBe("interrupted");
    expect((await stat(loop.workTree.path)).isDirectory()).toBe(true);
    const claim = batchPaths(runsRoot).claim(two.repoKey, 1);
    expect((await stat(claim)).isFile()).toBe(true);

    await updateLoop(runsRoot, two.id, 2, (current) => ({
      ...current,
      status: "skipped",
      skipReason: "test",
      reason: null,
    }));
    const childResume = childDouble({ steps: 2 });
    const resumed = await runBatch({
      prepared: { ...two, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childResume.spawn,
        installSignal: false,
      },
    });
    expect(childResume.calls).toHaveLength(1);
    expect(childResume.calls[0].args).toContain("--continue-from");
    expect(valueAfter(childResume.calls[0].args, "--continue-from")).toBe(loop.transcript);
    expect(childResume.calls[0].transcript).toBe(loop.transcript);
    expect(childResume.calls[0].maxSteps).toBe("7");
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  });

  // Usefulness: a throw at the PID checkpoint write stops that unregistered child and marks its loop.
  test("a throw at the PID checkpoint write stops the unregistered child", async () => {
    const one = { ...prepared, id: newBatchId(), issues: [1], loops: 1 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${one.id}`);
    const child = childDouble({ hold: true });
    const stops = [];
    const failure = new Error("the pid checkpoint write failed");
    const spawn = async (options) => {
      const started = await child.spawn(options);
      return {
        ...started,
        pid: {
          toJSON() {
            throw failure;
          },
        },
        kill: (signal) => {
          stops.push(signal);
          started.kill(signal);
        },
      };
    };
    const run = runBatch({
      prepared: one,
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    await expect(run).rejects.toBe(failure);
    expect(stops).toEqual(["SIGINT"]);
    const loop = await readLoop(runsRoot, one.id, 1);
    expect(loop.status).toBe("interrupted");
    expect(loop.reason).toBe("interrupted");
  });

  // Usefulness: a second SIGINT during the throw cleanup ends the wait and still rethrows the error.
  test("a second SIGINT during the throw cleanup ends the wait", async () => {
    const two = { ...prepared, id: newBatchId(), issues: [1, 2], loops: 2 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${two.id}`);
    await seedThrowState(two, runsRoot);
    const stops = [];
    const sigintSeen = deferred();
    const never = new Promise(() => {});
    const spawn = async () => ({
      pid: process.pid,
      startTime: null,
      done: never,
      kill: (signal) => {
        stops.push(signal);
        sigintSeen.resolve();
      },
      hardKill: () => {
        stops.push("SIGKILL");
      },
      close: () => {},
    });
    const failure = new Error("the git fetch failed");
    const before = new Set(getEventListeners(process, "SIGINT"));
    try {
      const run = runBatch({
        prepared: { ...two, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn,
          verifyWorkTree: async (loop) => {
            if (loop.issue === 2) throw failure;
            return null;
          },
        },
      });
      await sigintSeen.promise;
      process.emit("SIGINT");
      await expect(run).rejects.toBe(failure);
      expect(stops).toEqual(["SIGINT", "SIGKILL"]);
      expect(process.listenerCount("SIGINT")).toBe(before.size + 1);
    } finally {
      for (const listener of getEventListeners(process, "SIGINT")) {
        if (!before.has(listener)) process.removeListener("SIGINT", listener);
      }
    }
  });

  // Usefulness: a failed settle checkpoint write leaves no unhandled rejection and the loop running.
  test("a settle checkpoint write failure is handled", async () => {
    const one = { ...prepared, id: newBatchId(), issues: [901], loops: 1 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${one.id}`);
    const child = childDouble({ hold: true });
    const failure = Object.assign(new Error("the checkpoint write failed"), { code: "EPERM" });
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = runBatch({
        prepared: one,
        runsRoot,
        gh: fakeGh(),
        deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
      });
      await waitForLaunch(child);
      await pollUntil(async () => {
        const loop = await readLoop(runsRoot, one.id, 901);
        return loop?.pid != null ? loop : undefined;
      }, 10_000);
      failCheckpointWrite("issue-901.json", failure);
      child.pending[0].resolve({ exitCode: 0 });
      await expect(run).rejects.toBe(failure);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      const loop = await readLoop(runsRoot, one.id, 901);
      expect(loop.status).toBe("running");
    } finally {
      checkpointWrite.suffix = null;
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // Usefulness: a late settle write failure after a second SIGINT is logged once.
  test("a late settle write failure after a second SIGINT is logged once", async () => {
    const one = { ...prepared, id: newBatchId(), issues: [902], loops: 1 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${one.id}`);
    const stops = [];
    const sigintSeen = deferred();
    const gate = deferred();
    const pidFailure = Object.assign(new Error("the pid checkpoint write failed"), {
      code: "EPERM",
    });
    const writeFailure = Object.assign(new Error("the checkpoint write failed"), {
      code: "EPERM",
    });
    const spawn = async () => ({
      pid: {
        toJSON() {
          throw pidFailure;
        },
      },
      startTime: null,
      done: gate.promise,
      kill: (signal) => {
        stops.push(signal);
        sigintSeen.resolve();
      },
      hardKill: () => {
        stops.push("SIGKILL");
      },
      close: () => {},
    });
    const lines = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    const before = new Set(getEventListeners(process, "SIGINT"));
    try {
      const run = runBatch({
        prepared: one,
        runsRoot,
        gh: fakeGh(),
        deps: { ...fakeGitDeps, notifier: noNotify, spawn },
      });
      await sigintSeen.promise;
      process.emit("SIGINT");
      await expect(run).rejects.toBe(pidFailure);
      expect(stops).toEqual(["SIGINT", "SIGKILL"]);
      failCheckpointWrite("issue-902.json", writeFailure);
      gate.resolve({ exitCode: 0 });
      await pollUntil(() => {
        const text = lines.join("\n");
        return text.includes("error") && text.includes(writeFailure.message) ? true : undefined;
      }, 10_000);
      await new Promise((resolve) => setImmediate(resolve));
      const errorLines = lines.filter(
        (line) => line.includes("error") && line.includes(writeFailure.message),
      );
      expect(errorLines).toHaveLength(1);
    } finally {
      checkpointWrite.suffix = null;
      spy.mockRestore();
      for (const listener of getEventListeners(process, "SIGINT")) {
        if (!before.has(listener)) process.removeListener("SIGINT", listener);
      }
    }
  });

  // Usefulness: a throw with no live child adds no checkpoint, manifest, or log write.
  test("a throw with no live child writes no extra state", async () => {
    const one = { ...prepared, id: newBatchId(), issues: [1], loops: 1 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${one.id}`);
    await runBatch({
      prepared: one,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await removePath(batchPaths(runsRoot).transcript(one.id, 1));
    await updateLoop(runsRoot, one.id, 1, (loop) => ({
      ...loop,
      status: "queued",
      attempts: 0,
      cleanup: null,
    }));
    const file = batchPaths(runsRoot).loop(one.id, 1);
    const before = await stat(file, { bigint: true });
    const lines = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const failure = new Error("the work tree check failed");
      const run = runBatch({
        prepared: { ...one, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          installSignal: false,
          verifyWorkTree: async () => {
            throw failure;
          },
        },
      });
      await expect(run).rejects.toBe(failure);
      const manifest = await readManifest(runsRoot, one.id);
      expect(manifest.status).toBe("running");
      const loop = await readLoop(runsRoot, one.id, 1);
      expect(loop.status).toBe("queued");
      const after = await stat(file, { bigint: true });
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(lines.some((line) => /interrupt|cleanup failed/i.test(line))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
