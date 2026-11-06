import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { mapInBatches } from "./batches.mjs";
import { execBounded } from "./exec.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";

// Milliseconds that one ignore read waits before the watch reports no path (10_000).
const IGNORE_READ_BOUND_MS = 10_000;
// Milliseconds that the end-of-turn drain runs before the watch reports no path (1000).
export const DRAIN_DEADLINE_MS = 1_000;
// Keys that one event-grown structure keeps before the watch gives up the field (500).
const MAX_KEYS = 500;
// Reads in flight that one turn keeps before the watch gives up the field (500).
const MAX_READS = 500;
// Event paths that one `git check-ignore` call reads (200).
const IGNORE_BATCH_SIZE = 200;
// Candidate paths that one file check reads at a time (32).
const FILE_BATCH_SIZE = 32;

/**
 * Watches the main work tree of a linked run for the turn window. One `Map` holds every pending
 * path, with its merged event kinds. `git check-ignore` drops an ignored path, an in-window lstat
 * records a file, and the `.git` directory stays out. `take()` returns the candidates and then
 * stops the watch on every outcome. A failed watch, read, or bound returns `failed: true` and logs
 * a warning, so the caller reports no path. The options lower the bounds and hold the ignore input,
 * for a test.
 * @param {string} root absolute main work tree root
 * @param {{ maxPending?: number, maxSeenFiles?: number, maxCandidates?: number, maxReads?: number, drainDeadlineMs?: number, beforeIgnoreInputEnds?: (bound: { pid: number, signal: AbortSignal }) => Promise<void>, beforeFileKind?: (bound: { signal: AbortSignal }) => Promise<void> }} [options]
 * @returns {{ take: () => Promise<{ candidates: string[], failed: boolean }>, stop: () => Promise<void>, pendingCount: () => number, seenFileCount: () => number } | null}
 */
export function startMainWorkTreeWatch(
  root,
  {
    maxPending = MAX_KEYS,
    maxSeenFiles = MAX_KEYS,
    maxCandidates = MAX_KEYS,
    maxReads = MAX_READS,
    drainDeadlineMs = DRAIN_DEADLINE_MS,
    beforeIgnoreInputEnds = null,
    beforeFileKind = null,
  } = {},
) {
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

  const fail = (err) => {
    if (failed) return;
    failed = true;
    pending.clear();
    logWarn(`worker: the main work tree watch failed: ${firstErrorLine(readableErrorText(err))}`);
    closeWatcher();
  };

  /** Closes the watcher, so no later event joins the queue. */
  const closeWatcher = () => {
    if (watcherClosed) return;
    watcherClosed = true;
    try {
      watcher.close();
    } catch {}
  };

  /** True once the end-of-turn drain passes its deadline. */
  const expired = () => performance.now() >= deadlineAt;

  /** Stops the watch and waits for every read in flight to settle. Never throws. */
  const stop = async () => {
    closeWatcher();
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

  /** The candidates that an in-window read or the end read sees as a file. */
  const fileCandidates = () =>
    mapInBatches([...candidates], FILE_BATCH_SIZE, async (path) => {
      if (seenFiles.has(path)) return path;
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
        return entry.isFile() || entry.isSymbolicLink() ? path : null;
      } catch (err) {
        if (err?.code === "ENOENT") return null;
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
  try {
    watcher = watch(root, { recursive: true }, onEvent);
  } catch (err) {
    logWarn(
      `worker: the main work tree watch failed to start: ${firstErrorLine(readableErrorText(err))}`,
    );
    return null;
  }
  watcher.on("error", fail);

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
