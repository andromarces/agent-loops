import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { mapInBatches } from "./batches.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { gitRead } from "./git-read.mjs";
import { logWarn } from "./log.mjs";

// Milliseconds that one ignore read waits before the watch reports no path.
const IGNORE_READ_BOUND_MS = 10_000;
// Changed paths that one turn keeps before the watch gives up the field.
const MAX_CANDIDATES = 500;
// Event paths that one turn queues before the watch gives up the field.
const MAX_PENDING = 500;
// Event paths that one `git check-ignore` call reads.
const IGNORE_BATCH_SIZE = 200;
// Candidate paths that one file check reads at a time.
const FILE_BATCH_SIZE = 32;

/**
 * Watches the main work tree of a linked run for the turn window. A filesystem event names a
 * candidate path, and `git check-ignore` drops an ignored path. Only a regular file or a symlink
 * stays a candidate, and the `.git` directory stays out. `take()` returns the candidates and then
 * stops the watch on every outcome. A failed watch, read, or bound returns `failed: true` and logs
 * a warning, so the caller reports no path. The options replace the ignore read and the pending
 * bound, for a test.
 * @param {string} root absolute main work tree root
 * @param {{ readIgnored?: (paths: string[], bound: { signal: AbortSignal }) => Promise<Set<string>>, maxPending?: number }} [options]
 * @returns {{ take: () => Promise<{ candidates: string[], failed: boolean }>, stop: () => Promise<void>, pendingCount: () => number } | null}
 */
export function startMainWorkTreeWatch(
  root,
  { readIgnored = null, maxPending = MAX_PENDING } = {},
) {
  let failed = false;
  let watcherClosed = false;
  let stopped = false;
  let flushing = null;
  const pending = [];
  const pendingSet = new Set();
  const candidates = new Set();
  const ignoredPrefixes = new Set();
  const reads = new Set();
  const controller = new AbortController();

  const fail = (err) => {
    if (failed) return;
    failed = true;
    pending.length = 0;
    pendingSet.clear();
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
    if (candidates.size >= MAX_CANDIDATES) {
      fail(new Error(`more than ${MAX_CANDIDATES} changed paths`));
      return;
    }
    candidates.add(path);
  };

  const readIgnoredFromGit = (paths, { signal }) => {
    const roots = new Set(paths.map((path) => path.split("/")[0]));
    const input = [...new Set([...paths, ...roots])].map((path) => `${path}\0`).join("");
    return gitRead(root, ["check-ignore", "-z", "--stdin"], {
      allowExit: [0, 1],
      timeoutMs: IGNORE_READ_BOUND_MS,
      signal,
      input,
      env: { GIT_OPTIONAL_LOCKS: "0" },
      stripFinalNewline: false,
    }).then((result) => new Set(result.stdout.split("\0").filter(Boolean)));
  };
  const ignoreReader = readIgnored ?? readIgnoredFromGit;

  const flush = async () => {
    while (pending.length > 0 && !stopped && !failed) {
      const batch = pending.splice(0, IGNORE_BATCH_SIZE);
      for (const path of batch) pendingSet.delete(path);
      const ignored = await track(ignoreReader(batch, { signal: controller.signal }));
      if (failed) return;
      for (const path of batch) {
        if (!ignored.has(path)) addCandidate(path);
        const rootName = path.split("/")[0];
        if (ignored.has(rootName)) ignoredPrefixes.add(rootName);
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
    while (!stopped && !failed && (pending.length > 0 || flushing !== null)) {
      await (flushing ?? schedule());
    }
    if (flushing !== null) await flushing.catch(() => {});
  };

  /** The candidates that are a regular file or a symlink now, in batches. */
  const fileCandidates = () =>
    mapInBatches([...candidates], FILE_BATCH_SIZE, async (path) => {
      if (stopped) return null;
      try {
        const entry = await track(lstat(join(root, path)));
        return entry.isFile() || entry.isSymbolicLink() ? path : null;
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
      }
    });

  const onEvent = (_type, filename) => {
    if (watcherClosed || failed) return;
    const path = relativePath(filename);
    if (path === null || path.split("/").includes(".git")) return;
    if (ignoredByPrefix(path) || pendingSet.has(path)) return;
    pending.push(path);
    pendingSet.add(path);
    if (pending.length > maxPending) {
      fail(new Error(`more than ${maxPending} queued events`));
      return;
    }
    if (pending.length >= IGNORE_BATCH_SIZE) schedule();
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
      await stop();
      return result;
    },
    stop,
    /** Number of event paths queued and not read yet. */
    pendingCount: () => pending.length,
  };
}
