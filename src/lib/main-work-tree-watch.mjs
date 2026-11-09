import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { mapInBatches } from "./batches.mjs";
import { execBounded } from "./exec.mjs";
import { errorLine } from "./error-message.mjs";
import { logWarn } from "./log.mjs";

// Milliseconds that one ignore read waits before the watch reports no path (10_000).
const IGNORE_READ_BOUND_MS = 10_000;
// Milliseconds that the end-of-turn drain runs before the watch reports no path (1000).
export const DRAIN_DEADLINE_MS = 1_000;
// Milliseconds that the macOS watch `ready` promise gets before the watch reports no path (1000).
const ARM_DEADLINE_MS = 1_000;
// Keys that one event-grown structure keeps before the watch gives up the field (500).
const MAX_KEYS = 500;
// Reads in flight that one turn keeps before the watch gives up the field (500).
const MAX_READS = 500;
// Event paths that one `git check-ignore` call reads (200).
const IGNORE_BATCH_SIZE = 200;
// Candidate paths that one file check reads at a time (32).
const FILE_BATCH_SIZE = 32;
// Milliseconds before the window start within which a modification time still counts as a write
// (2000). Two seconds covers a coarse file system clock and a small skew, and reports a write that
// it cannot separate from the window.
const MTIME_MARGIN_MS = 2_000;

/**
 * Starts a recursive watch and returns it with a `ready` promise for the watch factory. In the
 * saved probe, a write right after `watch` missed 1 in 10,000. One event-loop turn missed 0 in
 * 5,000, so the macOS `ready` resolves after one turn. The other platforms return no `ready`, so
 * their event handling does not change.
 * @param {string} root
 * @param {(type: string, filename: string | Buffer) => void} onEvent
 * @returns {{ watcher: import("node:fs").FSWatcher, ready: Promise<void> | null }}
 */
function watchRecursive(root, onEvent) {
  const watcher = watch(root, { recursive: true }, onEvent);
  const ready =
    process.platform === "darwin" ? new Promise((resolve) => setImmediate(resolve)) : null;
  return { watcher, ready };
}

/**
 * Waits for the `ready` promise under one monotonic deadline. A missed deadline fails the watch,
 * and a turn abort ends the wait. The promise never rejects.
 * @param {Promise<void> | null} ready
 * @param {{ armDeadlineMs: number, signal: AbortSignal | null, armWait: Promise<void>, fail: (err: unknown) => void }} bound
 */
async function arm(ready, { armDeadlineMs, signal, armWait, fail }) {
  if (ready === null || ready === undefined) return;
  const deadlineAt = performance.now() + armDeadlineMs;
  let timer = null;
  let onAbort = null;
  const waits = [
    Promise.resolve(ready).catch((err) => fail(err)),
    new Promise((resolve) => {
      timer = setTimeout(
        () => {
          fail(new Error(`the main work tree watch did not arm within ${armDeadlineMs} ms`));
          resolve();
        },
        Math.max(0, deadlineAt - performance.now()),
      );
      timer.unref?.();
    }),
    armWait,
  ];
  if (signal !== null) {
    waits.push(
      new Promise((resolve) => {
        onAbort = resolve;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  try {
    await Promise.race(waits);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Watches the main work tree for the turn window with one `Map` of pending paths and merged event
 * kinds, and keeps `.git` out. `git check-ignore` drops an ignored path, and an in-window lstat
 * records a file. A recorded file is a read-only access and stays out when its modification time
 * predates the window start minus the margin. It also stays out when its change time is at most the
 * window start plus a one-millisecond guard. `take()` returns the candidates and stops the watch on
 * every outcome, and the options lower the bounds and hold the ignore input for a test. A failed
 * watch, read, or bound returns `failed: true`, logs a warning, and reports no path.
 * @param {string} root absolute main work tree root
 * @param {{ maxPending?: number, maxSeenFiles?: number, maxCandidates?: number, maxReads?: number, drainDeadlineMs?: number, armDeadlineMs?: number, wallClock?: () => number, signal?: AbortSignal, watchFactory?: (root: string, onEvent: (type: string, filename: string | Buffer) => void) => { watcher: import("node:fs").FSWatcher, ready: Promise<void> | null }, beforeIgnoreInputEnds?: (bound: { pid: number, signal: AbortSignal }) => Promise<void>, beforeFileKind?: (bound: { signal: AbortSignal }) => Promise<void> }} [options]
 * @returns {Promise<{ take: () => Promise<{ candidates: string[], failed: boolean }>, stop: () => Promise<void>, pendingCount: () => number, seenFileCount: () => number } | null>}
 */
export async function startMainWorkTreeWatch(
  root,
  {
    maxPending = MAX_KEYS,
    maxSeenFiles = MAX_KEYS,
    maxCandidates = MAX_KEYS,
    maxReads = MAX_READS,
    drainDeadlineMs = DRAIN_DEADLINE_MS,
    armDeadlineMs = ARM_DEADLINE_MS,
    wallClock = () => Date.now(),
    signal = null,
    beforeIgnoreInputEnds = null,
    beforeFileKind = null,
    watchFactory = watchRecursive,
  } = {},
) {
  // The turn starts before the child call can write, so a later write moves the modification time
  // past this instant. A read leaves it before. The file system stamps the change time from the
  // system clock. The performance clock's wall time can sit a per-process millisecond or more away
  // from it on Windows, so the start comes from the system clock.
  const windowStart = wallClock();
  // A change time is a write only when it is strictly later than the start plus this one-millisecond
  // guard. A file system stamp can lead the whole-millisecond system clock by less than one
  // millisecond, so a timestamp-preserving change made before the start stays out.
  const changeTimeAfterStart = windowStart + 1;
  let failed = false;
  let watcherClosed = false;
  let stopped = false;
  let done = false;
  let flushing = null;
  let deadlineAt = Number.POSITIVE_INFINITY;
  let drainController = null;
  const pending = new Map();
  const candidates = new Set();
  const seenFiles = new Set();
  const ignoredPrefixes = new Set();
  const reads = new Set();
  const controller = new AbortController();
  let resolveArm = null;
  // Resolves when `ready` settles, or when the watch fails, stops, or closes.
  const armWait = new Promise((resolve) => {
    resolveArm = resolve;
  });

  const fail = (err) => {
    if (failed) return;
    failed = true;
    pending.clear();
    logWarn(`worker: the main work tree watch failed: ${errorLine(err)}`);
    closeWatcher();
    resolveArm();
  };

  /** Closes the watcher, so no later event joins the queue. */
  const closeWatcher = () => {
    if (watcherClosed) return;
    watcherClosed = true;
    try {
      watcher.close();
    } catch {}
  };

  /** Reports a watch that closed before the turn read it, and ends the `ready` wait. */
  const onWatcherClose = () => {
    resolveArm();
    if (watcherClosed || failed || done) return;
    fail(new Error("the main work tree watch closed before the turn read it"));
  };

  /** True once the end-of-turn drain passes its deadline. */
  const expired = () => performance.now() >= deadlineAt;

  /** Stops the watch and waits for every read in flight to settle. Never throws. */
  const stop = async () => {
    closeWatcher();
    resolveArm();
    if (!done && !failed) {
      fail(new Error("the watch stopped before the turn read it"));
    }
    if (!stopped && !done) {
      stopped = true;
      controller.abort();
      drainController?.abort();
    }
    while (reads.size > 0) {
      await Promise.allSettled(reads);
      if (expired()) expire();
    }
    if (flushing !== null) {
      await flushing.catch(() => {});
      if (expired()) expire();
    }
  };

  /** Ends the drain at its deadline and stops every read in flight. */
  const expire = () => {
    fail(new Error(`the main work tree watch drain passed its ${drainDeadlineMs} ms deadline`));
    if (!stopped) {
      stopped = true;
      controller.abort();
      drainController?.abort();
    }
  };

  /** The signal of the end-of-turn drain, or of the watch before it closes. */
  const readSignal = () => drainController?.signal ?? controller.signal;

  /** Keeps a read in `reads` until it settles, so `stop` can wait for it. */
  const track = (promise) => {
    const settled = promise.then(
      (value) => {
        reads.delete(settled);
        return value;
      },
      (err) => {
        reads.delete(settled);
        throw err;
      },
    );
    reads.add(settled);
    settled.catch(() => {});
    return settled;
  };

  const relativePath = (filename) => {
    if (typeof filename !== "string" || filename.length === 0) return null;
    const native = isAbsolute(filename) ? relative(root, filename) : filename;
    if (native.length === 0 || native === ".." || native.startsWith(`..${sep}`)) return null;
    if (isAbsolute(native)) return null;
    return native.split(sep).join("/");
  };

  const ignoredByPrefix = (path) => {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (ignoredPrefixes.has(parts.slice(0, index).join("/"))) return true;
    }
    return false;
  };

  const addCandidate = (path) => {
    if (failed || ignoredByPrefix(path) || candidates.has(path)) return;
    if (candidates.size >= maxCandidates) {
      fail(new Error(`more than ${maxCandidates} changed paths`));
      return;
    }
    candidates.add(path);
  };

  /** Records a path that an in-window read sees as a regular file or a symlink. */
  const checkKind = async (path) => {
    try {
      const entry = await track(lstat(join(root, path)));
      if (beforeFileKind !== null) await beforeFileKind({ signal: readSignal() });
      if (expired()) expire();
      if (stopped || failed) return;
      if (!entry.isFile() && !entry.isSymbolicLink()) return;
      if (seenFiles.size >= maxSeenFiles) {
        fail(new Error(`more than ${maxSeenFiles} seen files`));
        return;
      }
      seenFiles.add(path);
    } catch (err) {
      if (err?.code !== "ENOENT") fail(err);
    }
  };

  const readIgnored = async (paths, { signal }) => {
    const roots = new Set(paths.map((path) => path.split("/")[0]));
    const input = [...new Set([...paths, ...roots])].map((path) => `${path}\0`).join("");
    const subprocess = execBounded("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      timeoutMs: IGNORE_READ_BOUND_MS,
      signal,
      stdin: "pipe",
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    const stopInput = () => subprocess.stdin?.destroy();
    signal.addEventListener("abort", stopInput, { once: true });
    try {
      subprocess.stdin.write(input);
      if (beforeIgnoreInputEnds !== null) {
        await beforeIgnoreInputEnds({ pid: subprocess.pid, signal });
      }
      if (signal.aborted || expired()) {
        throw Object.assign(new Error("git check-ignore was canceled"), { isCanceled: true });
      }
      subprocess.stdin.end();
      const result = await subprocess;
      if (signal.aborted || expired()) {
        throw Object.assign(new Error("git check-ignore was canceled"), { isCanceled: true });
      }
      if (result.isCanceled) {
        throw Object.assign(new Error("git check-ignore was canceled"), { isCanceled: true });
      }
      if (result.timedOut) throw new Error("git check-ignore timed out");
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`git check-ignore failed (exit ${result.exitCode})`);
      }
      return new Set(result.stdout.split("\0").filter(Boolean));
    } finally {
      signal.removeEventListener("abort", stopInput);
    }
  };

  const flush = async () => {
    while (pending.size > 0 && !stopped && !failed) {
      if (reads.size >= maxReads) {
        fail(new Error(`more than ${maxReads} reads`));
        return;
      }
      if (expired()) {
        expire();
        return;
      }
      const batch = [...pending.keys()].slice(0, IGNORE_BATCH_SIZE);
      const ignored = await track(readIgnored(batch, { signal: readSignal() }));
      if (expired()) {
        expire();
        return;
      }
      if (failed) return;
      for (const path of batch) {
        pending.delete(path);
        if (!ignored.has(path)) addCandidate(path);
        const rootName = path.split("/")[0];
        if (ignored.has(rootName) && !ignoredPrefixes.has(rootName)) {
          if (ignoredPrefixes.size >= maxPending) {
            fail(new Error(`more than ${maxPending} ignored prefixes`));
            return;
          }
          ignoredPrefixes.add(rootName);
        }
      }
    }
  };

  const schedule = () => {
    if (flushing !== null) return flushing;
    flushing = flush()
      .catch((err) => fail(err))
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  /** Drains the queued paths under the drain deadline, and ends when a read failed. */
  const drain = async () => {
    while (!stopped && !failed && (pending.size > 0 || flushing !== null)) {
      if (expired()) {
        expire();
        break;
      }
      await (flushing ?? schedule());
      if (expired()) {
        expire();
        break;
      }
    }
    if (flushing !== null) await flushing.catch(() => {});
  };

  /** The candidates that the turn may have written: an end file with a window-time modification or
   * change time, or one that an in-window read saw before the turn removed it. A read moves only
   * the access time, so both times stay before the window; a write that restores the modification
   * time still moves the change time past the window start. */
  const fileCandidates = () =>
    mapInBatches([...candidates], FILE_BATCH_SIZE, async (path) => {
      if (stopped) return null;
      if (reads.size >= maxReads) {
        fail(new Error(`more than ${maxReads} reads`));
        return null;
      }
      if (expired()) {
        expire();
        return null;
      }
      try {
        const entry = await track(lstat(join(root, path)));
        if (expired()) {
          expire();
          return null;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) return null;
        // A write moves the modification time to the write time, so a path that ends before the
        // window start was only read, which moves no modification or change time. The margin keeps
        // a write that a coarse timestamp or a small skew places before the start reported. A copy
        // that preserves the modification time still moves the change time past the guard, and
        // stays reported. A change time inside the guard after the start could belong to a
        // timestamp-preserving change made before the turn, so it never reports the path alone.
        if (
          entry.mtimeMs < windowStart - MTIME_MARGIN_MS &&
          entry.ctimeMs <= changeTimeAfterStart
        ) {
          return null;
        }
        return path;
      } catch (err) {
        if (err?.code === "ENOENT") return seenFiles.has(path) ? path : null;
        throw err;
      }
    });

  const onEvent = (type, filename) => {
    if (watcherClosed || failed) return;
    const path = relativePath(filename);
    if (path === null || path.split("/").includes(".git")) return;
    if (ignoredByPrefix(path)) return;
    const entry = pending.get(path);
    if (entry) {
      entry.kinds.add(type);
      return;
    }
    if (pending.size >= maxPending) {
      fail(new Error(`more than ${maxPending} queued paths`));
      return;
    }
    if (reads.size >= maxReads) {
      fail(new Error(`more than ${maxReads} reads`));
      return;
    }
    pending.set(path, { kinds: new Set([type]) });
    void track(checkKind(path));
  };

  let watcher;
  let ready = null;
  try {
    const started = watchFactory(root, onEvent);
    watcher = started.watcher;
    ready = started.ready ?? null;
  } catch (err) {
    logWarn(`worker: the main work tree watch failed to start: ${errorLine(err)}`);
    return null;
  }
  watcher.on("error", fail);
  watcher.on("close", onWatcherClose);
  if (signal?.aborted) {
    closeWatcher();
    return null;
  }
  // In the saved probe a write right after `watch` missed, so the child call waits for `ready`.
  await arm(ready, { armDeadlineMs, signal, armWait, fail });
  if (signal?.aborted) {
    closeWatcher();
    return null;
  }

  return {
    async take() {
      // Two event-loop turns let a queued watch event reach the callback before the read.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      closeWatcher();
      drainController = new AbortController();
      deadlineAt = performance.now() + drainDeadlineMs;
      const timer = setTimeout(expire, drainDeadlineMs);
      timer.unref?.();
      try {
        await drain();
        let paths = [];
        if (!stopped && !failed) {
          try {
            paths = (await fileCandidates()).filter((path) => path !== null);
          } catch (err) {
            fail(err);
          }
        }
        done = true;
        await stop();
        const result = { candidates: failed ? [] : paths, failed };
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    stop,
    /** Number of paths queued and not read yet. */
    pendingCount: () => pending.size,
    /** Number of queued paths that an in-window read saw as a file. */
    seenFileCount: () => seenFiles.size,
  };
}
