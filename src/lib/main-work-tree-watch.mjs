import { watch } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { gitRead } from "./git-read.mjs";
import { logWarn } from "./log.mjs";

// Milliseconds that one ignore read waits before the watch reports no path.
const IGNORE_READ_BOUND_MS = 10_000;
// Changed paths that one turn keeps before the watch gives up the field.
const MAX_CANDIDATES = 500;
// Event paths that one `git check-ignore` call reads.
const IGNORE_BATCH_SIZE = 200;

/**
 * Watches the main work tree of a linked run for the turn window. A filesystem event names a
 * candidate path. `git check-ignore` drops an ignored path, and the `.git` directory stays out.
 * `take()` returns the candidates and stops the watch, on every outcome. A failed watch or read
 * returns `failed: true` and logs a warning, so the caller reports no path.
 * @param {string} root absolute main work tree root
 * @returns {{ take: () => Promise<{ candidates: string[], failed: boolean }>, stop: () => void } | null}
 */
export function startMainWorkTreeWatch(root) {
  let failed = false;
  let closed = false;
  let flushing = null;
  const pending = [];
  const pendingSet = new Set();
  const candidates = new Set();
  const ignoredPrefixes = new Set();

  const fail = (err) => {
    if (failed || closed) return;
    failed = true;
    logWarn(`worker: the main work tree watch failed: ${firstErrorLine(readableErrorText(err))}`);
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    try {
      watcher.close();
    } catch {}
  };

  const relativePath = (filename) => {
    if (typeof filename !== "string" || filename.length === 0) return null;
    const native = isAbsolute(filename) ? relative(root, filename) : filename;
    if (native.length === 0 || native === ".." || native.startsWith(`..${sep}`)) return null;
    if (isAbsolute(native)) return null;
    return native.split(/[\\/]/).join("/");
  };

  const ignoredByPrefix = (path) => {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (ignoredPrefixes.has(parts.slice(0, index).join("/"))) return true;
    }
    return false;
  };

  const addCandidate = (path) => {
    if (ignoredByPrefix(path) || candidates.has(path)) return;
    if (candidates.size >= MAX_CANDIDATES) {
      fail(new Error(`more than ${MAX_CANDIDATES} changed paths`));
      return;
    }
    candidates.add(path);
  };

  const readIgnored = async (paths) => {
    const roots = new Set(paths.map((path) => path.split("/")[0]));
    const input = [...new Set([...paths, ...roots])].map((path) => `${path}\0`).join("");
    const result = await gitRead(root, ["check-ignore", "-z", "--stdin"], {
      allowExit: [0, 1],
      timeoutMs: IGNORE_READ_BOUND_MS,
      input,
      env: { GIT_OPTIONAL_LOCKS: "0" },
      stripFinalNewline: false,
    });
    return new Set(result.stdout.split("\0").filter(Boolean));
  };

  const flush = async () => {
    while (pending.length > 0) {
      const batch = pending.splice(0, IGNORE_BATCH_SIZE);
      for (const path of batch) pendingSet.delete(path);
      const ignored = await readIgnored(batch);
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

  const onEvent = (_type, filename) => {
    if (closed) return;
    const path = relativePath(filename);
    if (path === null || path.split("/").includes(".git")) return;
    if (ignoredByPrefix(path) || pendingSet.has(path)) return;
    pending.push(path);
    pendingSet.add(path);
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
      while (pending.length > 0 || flushing !== null) {
        await (flushing ?? schedule());
      }
      stop();
      return { candidates: [...candidates], failed };
    },
    stop,
  };
}
