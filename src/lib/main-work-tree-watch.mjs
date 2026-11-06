import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { mapInBatches } from "./batches.mjs";
import { execBounded } from "./exec.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";

// Milliseconds that one ignore read waits before the watch reports no path.
const IGNORE_READ_BOUND_MS = 10_000;
// Keys that one event-grown structure keeps before the watch gives up the field.
const MAX_KEYS = 500;
// Event paths that one `git check-ignore` call reads.
const IGNORE_BATCH_SIZE = 200;
// Candidate paths that one file check reads at a time.
const FILE_BATCH_SIZE = 32;

/**
 * Watches the main work tree of a linked run for the turn window. One `Map` holds every pending
 * path, with its merged event kinds. `git check-ignore` drops an ignored path, an in-window lstat
 * records a file, and the `.git` directory stays out. `take()` returns the candidates and then
 * stops the watch on every outcome. A failed watch, read, or bound returns `failed: true` and logs
 * a warning, so the caller reports no path. The options lower the bounds and hold the ignore input,
 * for a test.
 * @param {string} root absolute main work tree root
 * @param {{ maxPending?: number, maxSeenFiles?: number, maxCandidates?: number, beforeIgnoreInputEnds?: (bound: { pid: number }) => Promise<void> }} [options]
 * @returns {{ take: () => Promise<{ candidates: string[], failed: boolean }>, stop: () => Promise<void>, pendingCount: () => number, seenFileCount: () => number } | null}
 */
export function startMainWorkTreeWatch(
  root,
  {
    maxPending = MAX_KEYS,
    maxSeenFiles = MAX_KEYS,
    maxCandidates = MAX_KEYS,
    beforeIgnoreInputEnds = null,
  } = {},
) {
  let failed = false;
  let watcherClosed = false;
  let stopped = false;
  let done = false;
  let flushing = null;
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

  /** Stops the watch and waits for every read in flight to settle. Never throws. */
  const stop = async () => {
    closeWatcher();
    if (!done && !failed) {
      fail(new Error("the watch stopped before the turn read it"));
    }
    if (!stopped) {
      stopped = true;
      controller.abort();
    }
    while (reads.size > 0) await Promise.allSettled(reads);
    if (flushing !== null) await flushing.catch(() => {});
  };

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
      if (beforeIgnoreInputEnds !== null) await beforeIgnoreInputEnds({ pid: subprocess.pid });
      subprocess.stdin.end();
      const result = await subprocess;
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
      const batch = [...pending.keys()].slice(0, IGNORE_BATCH_SIZE);
      const ignored = await track(readIgnored(batch, { signal: controller.signal }));
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

  /** Drains the queued paths, and ends at once when a read already failed. */
  const drain = async () => {
    while (!stopped && !failed && (pending.size > 0 || flushing !== null)) {
      await (flushing ?? schedule());
    }
    if (flushing !== null) await flushing.catch(() => {});
  };

  /** The candidates that an in-window read or the end read sees as a file. */
  const fileCandidates = () =>
    mapInBatches([...candidates], FILE_BATCH_SIZE, async (path) => {
      if (seenFiles.has(path)) return path;
      if (stopped) return null;
      try {
        const entry = await track(lstat(join(root, path)));
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
    if (reads.size >= maxPending) {
      fail(new Error(`more than ${maxPending} reads`));
      return;
    }
    pending.set(path, { kinds: new Set([type]) });
    void checkKind(path);
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
      await drain();
      closeWatcher();
      await drain();
      let paths = [];
      if (!stopped && !failed) {
        try {
          paths = (await fileCandidates()).filter((path) => path !== null);
        } catch (err) {
          fail(err);
        }
      }
      const result = { candidates: failed || stopped ? [] : paths, failed: failed || stopped };
      done = true;
      await stop();
      return result;
    },
    stop,
    /** Number of paths queued and not read yet. */
    pendingCount: () => pending.size,
    /** Number of queued paths that an in-window read saw as a file. */
    seenFileCount: () => seenFiles.size,
  };
}
