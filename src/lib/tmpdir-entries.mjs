import { lstat, open as openFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mapInBatches } from "./batches.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
import { readProcessTable } from "./process-ancestry.mjs";
import { isTurnTmpdirName } from "./turn-tmpdir.mjs";
import { isRegisteredTurnTmpdir } from "./turn-tmpdir-registry.mjs";
import { withTimeBound } from "./time-bound.mjs";

const REGISTERED_PREFIX = "registered/";
const READ_BATCH_SIZE = 32;
// A later read answers in milliseconds. The bound ends a read that hangs, and a read that reaches
// the bound keeps every recorded name (issue #1559).
const RE_READ_BOUND_MS = 5_000;
// A recorded name that holds one of these cannot name a direct entry, so the read keeps it. The
// colon keeps a Windows drive letter or stream name unsafe on every platform.
const UNSAFE_NAME = /[/\\:\0]/;
const REDACTED_NAME = /\[redacted:|\[\*\]/;
// A transient file, such as a GUID `.tmp` file, can be in the post-turn read and then be gone a
// moment later. The second read after this window keeps only the entries that still exist (issue
// #1542).
const SETTLE_MS = 250;
// A reported name can vanish minutes after the last reviewer turn. The re-check polls for this
// long and returns as soon as every checkable name is gone (issue #1569).
export const TMPDIR_SETTLE_BOUND_MS = 180_000;
// The fixed pause between two polls of the re-check. Tests inject another value (issue #1569).
export const TMPDIR_SETTLE_INTERVAL_MS = 2_000;
// libuv defines UV_FS_O_EXLOCK as this value on Windows. Node exposes no matching `fs.constants`
// entry in the supported releases, so the probe supplies the value (issue #1600).
const WINDOWS_EXCLUSIVE_SHARE = 0x10000000;
// A probe answers in milliseconds for a local file. The bound ends a probe that hangs, and a probe
// that reaches the bound keeps its name reported.
const PROBE_BOUND_MS = 5_000;
// The observed macOS names are a canonical UUID, a pid, a hex run, and the SQLite suffix.
const MACOS_SQLITE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([1-9][0-9]*)-[0-9a-f]+-(?:shm|wal)$/i;
// The process-table read that finds the ancestors answers in about a second. The bound keeps a
// stuck read from holding the re-check.
const ANCESTOR_READ_TIMEOUT_SECONDS = 5;

// Reads `os.tmpdir()` of this process, which is the inherited temporary directory of a turn. The
// `AGENT_LOOP_INHERITED_TMPDIR` list is read in `inherited-tmpdir.mjs`.

/**
 * Reads the entry names directly in the inherited temporary directory, or null, after a warning,
 * when it cannot be read.
 * @returns {Promise<Set<string> | null>}
 */
export async function snapshotInheritedTmpdir() {
  try {
    return new Set(await readdir(tmpdir()));
  } catch (err) {
    logWarn(`inherited temporary directory not read: ${firstErrorLine(readableErrorText(err))}`);
    return null;
  }
}

/**
 * Names the entries that appeared directly in the inherited temporary directory since `before`,
 * sorted, at most 20, each redacted like the test command output (ADR 0017), because a name is
 * chosen by the turn. The directories that this process created for a turn are left out by their
 * exact name, because the runtime removes them. Every other entry is listed, an `al-` name too. An
 * entry that is the turn directory that another agent-loop process registered carries the prefix
 * `registered/`, which no entry name can hold, so the parent can tell it apart (issue #1240). The
 * mark is a hint and never a reason to leave an entry out: a turn can write a registration too
 * (ADR 0069). A name that a second read after a short settle no longer holds is left out; the reads
 * establish no owner. A failed second read keeps it, since the list is advisory (issue #1542). The
 * names are advisory only: the directory is shared with every other process on the host, so the
 * runtime cannot attribute an entry to the turn and never deletes one (issue #1024). Returns [] when
 * either of the first two reads failed.
 * @param {Set<string> | null} before
 * @param {{ settle?: () => Promise<void> }} [options] `settle` replaces the default wait before the
 *   confirming read.
 * @returns {Promise<string[]>}
 */
export async function appearedInInheritedTmpdir(before, { settle = waitToSettle } = {}) {
  if (before === null) return [];
  const after = await snapshotInheritedTmpdir();
  if (after === null) return [];
  const appeared = [...after].filter((name) => !before.has(name) && !isTurnTmpdirName(name));
  if (appeared.length === 0) return [];
  const confirmed = await entriesAfterSettle(appeared, settle);
  if (confirmed.length === 0) return [];
  const parent = tmpdir();
  const registered = await mapInBatches(confirmed, READ_BATCH_SIZE, (name) =>
    isRegisteredTurnTmpdir(parent, name),
  );
  return reportedEntryNames(
    confirmed.map((name, i) => (registered[i] ? `${REGISTERED_PREFIX}${name}` : name)),
  );
}

async function waitToSettle() {
  await delay(SETTLE_MS);
}

// The names of `names` that a further read still holds after `settle`. A failed read keeps every
// name.
async function entriesAfterSettle(names, settle) {
  await settle();
  const settled = await snapshotInheritedTmpdir();
  return settled === null ? names : names.filter((name) => settled.has(name));
}

const carrier = entryCarrier("inheritedTmpdirEntries");

/**
 * Splits `names` into the names that a probe settled as no possible run leftover and the names
 * that stay listed. On Windows, a regular file that another process holds open is settled. On
 * macOS, a regular file with the observed SQLite name is settled when its embedded pid is alive.
 * Every other name stays listed, and a failed or over-bound probe keeps its name listed.
 * @param {Iterable<string>} names
 * @param {{
 *   platform?: string,
 *   probe?: (name: string) => Promise<"held" | "free" | "unknown">,
 *   pidAlive?: (pid: number) => boolean,
 *   statFile?: (path: string) => Promise<{ isFile: () => boolean }>,
 *   ancestors?: Iterable<number> | null,
 *   boundMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ leftovers: string[], settled: string[] }>}
 */
export async function settleInheritedTmpdirNames(
  names,
  {
    platform = process.platform,
    probe = probeHeldOpenWindows,
    pidAlive = pidIsAlive,
    statFile = (path) => lstat(path, { bigint: true }),
    ancestors = null,
    boundMs = PROBE_BOUND_MS,
    signal,
  } = {},
) {
  const recorded = [...new Set(names)].filter((name) => typeof name === "string" && name !== "");
  if (recorded.length === 0) return { leftovers: [], settled: [] };
  const settled = new Set();
  const ancestorPids = ancestors === null || ancestors === undefined ? null : new Set(ancestors);
  const canceled = cancelPromise(signal);
  try {
    await withTimeBound(
      Math.max(1, boundMs),
      `inherited temporary directory probe took over ${boundMs} ms`,
      async ({ signal: boundSignal, stopped }) => {
        for (const name of recorded) {
          if (boundSignal.aborted) break;
          if (signal?.aborted) throw canceledError();
          const settledName = await settlesName(name, {
            platform,
            probe,
            pidAlive,
            statFile,
            ancestors: ancestorPids,
            stopped,
            canceled: canceled.promise,
          });
          if (settledName) settled.add(name);
        }
      },
    );
  } catch (err) {
    if (err?.isCanceled) throw err;
  } finally {
    canceled.cleanup();
  }
  return {
    leftovers: recorded.filter((name) => !settled.has(name)),
    settled: recorded.filter((name) => settled.has(name)),
  };
}

async function settlesName(
  name,
  { platform, probe, pidAlive, statFile, ancestors, stopped, canceled },
) {
  if (!isCheckableName(name) || name.startsWith(REGISTERED_PREFIX)) return false;
  if (platform === "win32") {
    const outcome = await raceProbe(
      Promise.resolve().then(() => probe(name)),
      stopped,
      canceled,
    );
    return outcome === "held";
  }
  if (platform === "darwin") {
    return settlesMacosName(name, { pidAlive, statFile, ancestors, stopped, canceled });
  }
  return false;
}

async function settlesMacosName(name, { pidAlive, statFile, ancestors, stopped, canceled }) {
  const match = MACOS_SQLITE_NAME.exec(name);
  if (match === null) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid || ancestors === null || ancestors.has(pid)) return false;
  const base = name.slice(0, -4);
  const sibling = name.endsWith("-shm") ? `${base}-wal` : `${base}-shm`;
  if (!(await isRegularFile(name, statFile, stopped, canceled))) return false;
  if (!(await isRegularFile(sibling, statFile, stopped, canceled))) return false;
  let alive;
  try {
    alive = await Promise.race([Promise.resolve().then(() => pidAlive(pid)), stopped, canceled]);
  } catch (err) {
    if (err?.isCanceled) throw err;
    return false;
  }
  return alive === true;
}

async function isRegularFile(name, statFile, stopped, canceled) {
  try {
    const info = await Promise.race([statFile(join(tmpdir(), name)), stopped, canceled]);
    return info?.isFile?.() === true;
  } catch (err) {
    if (err?.isCanceled) throw err;
    return false;
  }
}

async function raceProbe(promise, stopped, canceled) {
  try {
    return await Promise.race([promise, stopped, canceled]);
  } catch (err) {
    if (err?.isCanceled) throw err;
    return "unknown";
  }
}

// A Windows open with exclusive sharing fails with EBUSY while another handle is open. The open
// reads no byte, and the handle closes on every path.
export async function probeHeldOpenWindows(
  name,
  {
    lstatFile = (path) => lstat(path, { bigint: true }),
    openHandle = (path, flags) => openFile(path, flags),
  } = {},
) {
  const path = join(tmpdir(), name);
  let handle;
  try {
    const before = await lstatFile(path);
    if (!before.isFile()) return "unknown";
    handle = await openHandle(path, WINDOWS_EXCLUSIVE_SHARE);
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino) return "unknown";
    return "free";
  } catch (err) {
    return err?.code === "EBUSY" ? "held" : "unknown";
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}

/** Whether `pid` is alive: a signal 0 succeeds or fails with EPERM. Every other error is dead. */
export function pidIsAlive(pid, { kill = process.kill } = {}) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// The pids of this process and its ancestors. A failed read returns null, so no macOS name is
// settled on an ancestry that the read cannot prove.
async function readAncestorPids({ signal, timeout = ANCESTOR_READ_TIMEOUT_SECONDS } = {}) {
  let table;
  try {
    table = await readProcessTable({ signal, timeout });
  } catch (err) {
    if (err?.isCanceled) throw canceledError();
    return null;
  }
  const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  const seen = new Set([process.pid]);
  let pid = process.pid;
  for (let depth = 0; depth < 1000; depth += 1) {
    const ppid = parents.get(pid);
    if (!Number.isInteger(ppid)) return null;
    if (ppid <= 1) return seen;
    if (seen.has(ppid)) return null;
    seen.add(ppid);
    pid = ppid;
  }
  return null;
}

/**
 * Re-reads the inherited temporary directory and returns the recorded names that it still holds,
 * in the recorded order, and reads once without `settle`. With `settle` it polls to the bound and
 * reports the names held by the last read. A failed first read keeps every name, and a later failed
 * poll keeps the names of the last successful read. An uncheckable name stays listed. The read
 * lists names only and deletes nothing, with no wait for an empty name list.
 * @param {Iterable<string>} names the names that the reviewer turns reported
 * @param {object} [options] an injected read, read bound, and settle settings, for a test.
 * @returns {Promise<string[]>}
 */
// The settle object holds `boundMs`, `intervalMs`, `now`, `sleep`, and `signal`.
export async function presentInheritedTmpdir(names, options) {
  return (await presentInheritedTmpdirReport(names, options)).present;
}

/**
 * Runs the re-read of `presentInheritedTmpdir` and also returns the names that a probe settled as
 * no possible run leftover. The settle bound covers the probes too, and a probe that reaches its
 * bound keeps its name present.
 * @param {Iterable<string>} names
 * @param {{
 *   read?: () => Promise<string[]>,
 *   boundMs?: number,
 *   settle?: object | null,
 *   probe?: (name: string) => Promise<"held" | "free" | "unknown">,
 *   platform?: string,
 *   pidAlive?: (pid: number) => boolean,
 *   statFile?: (path: string) => Promise<{ isFile: () => boolean }>,
 *   ancestors?: Iterable<number> | null,
 *   readAncestors?: (options: object) => Promise<Set<number> | null>,
 *   probeBoundMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ present: string[], settled: string[] }>}
 */
export async function presentInheritedTmpdirReport(
  names,
  {
    read = readInheritedTmpdirNames,
    boundMs = RE_READ_BOUND_MS,
    settle = null,
    probe,
    platform,
    pidAlive,
    statFile,
    ancestors,
    readAncestors = readAncestorPids,
    probeBoundMs = RE_READ_BOUND_MS,
    signal,
  } = {},
) {
  const recorded = [...new Set(names)].filter((name) => typeof name === "string" && name !== "");
  if (recorded.length === 0) return { present: [], settled: [] };
  const platformName = platform ?? process.platform;
  const needsAncestors =
    platformName === "darwin" && recorded.some((name) => MACOS_SQLITE_NAME.test(bareName(name)));
  let ancestorPids = ancestors;
  let ancestorsResolved = ancestors !== undefined || !needsAncestors;
  const resolveAncestors = async (boundMs) => {
    if (ancestorsResolved) return ancestorPids ?? null;
    ancestorsResolved = true;
    try {
      ancestorPids = await withTimeBound(
        Math.max(1, boundMs),
        `inherited temporary directory ancestry read took over ${boundMs} ms`,
        ({ stopped }) => Promise.race([readAncestors({ signal }), stopped]),
      );
    } catch (err) {
      if (err?.isCanceled) throw err;
      ancestorPids = null;
    }
    return ancestorPids;
  };
  const settleOptions = {
    ...(probe ? { probe } : {}),
    platform: platformName,
    ...(pidAlive ? { pidAlive } : {}),
    ...(statFile ? { statFile } : {}),
    signal,
  };
  if (settle === null) {
    const entries = await readNames(read, boundMs, { signal });
    if (entries === null) return { present: recorded, settled: [] };
    const present = heldNames(recorded, entries);
    const resolved = await resolveAncestors(probeBoundMs);
    return settlePresent(present, {
      ...settleOptions,
      ancestors: resolved,
      boundMs: probeBoundMs,
    });
  }
  return settledNames(recorded, {
    read,
    readBoundMs: boundMs,
    ...settleOptions,
    resolveAncestors,
    probeBoundMs,
    ...settle,
  });
}

async function settlePresent(
  present,
  { probe, platform, pidAlive, statFile, ancestors, boundMs, signal },
) {
  const { leftovers, settled } = await settleInheritedTmpdirNames(present, {
    ...(probe ? { probe } : {}),
    ...(platform ? { platform } : {}),
    ...(pidAlive ? { pidAlive } : {}),
    ...(statFile ? { statFile } : {}),
    ancestors,
    boundMs,
    signal,
  });
  return { present: leftovers, settled };
}

// The names that the read still holds. A failed read is null.
async function readNames(read, boundMs, { signal, warn = true } = {}) {
  try {
    const entries = await withTimeBound(
      Math.max(1, boundMs),
      `inherited temporary directory re-read took over ${boundMs} ms`,
      ({ stopped }) => {
        // The read cannot be canceled, so the wait ends at the bound too.
        const pending = read();
        pending.catch(() => {});
        return Promise.race([withCancelRace(pending, signal), stopped]);
      },
    );
    return Array.isArray(entries) ? entries : null;
  } catch (err) {
    if (err?.isCanceled === true) throw err;
    if (warn) {
      logWarn(
        `inherited temporary directory not re-read: ${firstErrorLine(readableErrorText(err))}`,
      );
    }
    return null;
  }
}

// Races `promise` against the abort signal, so a cancel ends an in-flight read at once.
function withCancelRace(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(canceledError());
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(canceledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, canceled]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

async function settledNames(
  recorded,
  {
    read,
    readBoundMs,
    boundMs = TMPDIR_SETTLE_BOUND_MS,
    intervalMs = TMPDIR_SETTLE_INTERVAL_MS,
    now = () => performance.now(),
    sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
    signal,
    probe,
    platform,
    pidAlive,
    statFile,
    resolveAncestors,
    probeBoundMs = RE_READ_BOUND_MS,
  },
) {
  const deadline = now() + boundMs;
  // The final read starts one read bound before the deadline, so every read ends by the bound.
  const readBound = Math.max(1, Math.min(readBoundMs, Math.floor(boundMs / 2) || 1));
  const finalStart = deadline - readBound;
  let last = null;
  let first = true;
  let warnedFailure = false;
  const settled = new Set();
  const present = () => (last === null ? recorded : heldNames(recorded, last));
  const leftovers = () => present().filter((name) => !settled.has(name));
  const report = () => ({
    present: leftovers(),
    settled: recorded.filter((name) => settled.has(name)),
  });
  // A settled name no longer holds the wait, and the remaining budget bounds the probes.
  const classify = async () => {
    const toCheck = leftovers();
    if (toCheck.length === 0) return;
    const available = deadline - now();
    if (available < 1) return;
    const resolved = await resolveAncestors(
      Math.max(1, Math.min(probeBoundMs, Math.floor(available))),
    );
    throwIfCanceled(signal);
    const remaining = deadline - now();
    if (remaining < 1) return;
    const result = await settleInheritedTmpdirNames(toCheck, {
      ...(probe ? { probe } : {}),
      ...(platform ? { platform } : {}),
      ...(pidAlive ? { pidAlive } : {}),
      ...(statFile ? { statFile } : {}),
      ancestors: resolved,
      boundMs: Math.max(1, Math.min(probeBoundMs, Math.floor(remaining))),
      signal,
    });
    throwIfCanceled(signal);
    for (const name of result.settled) settled.add(name);
  };
  while (true) {
    throwIfCanceled(signal);
    const startedAt = now();
    const available = deadline - startedAt;
    // A late read cannot end by the deadline, so the last completed read supplies the report.
    if (available < 1) return report();
    if (!first && startedAt >= finalStart) {
      const entries = await readNames(read, Math.floor(available), {
        signal,
        warn: !warnedFailure,
      });
      throwIfCanceled(signal);
      // A failed read proves no name gone and settles no name.
      if (entries !== null) {
        last = entries;
        await classify();
      }
      return report();
    }
    const entries = await readNames(read, Math.max(1, Math.min(readBound, Math.floor(available))), {
      signal,
      warn: !warnedFailure,
    });
    throwIfCanceled(signal);
    if (entries === null) {
      warnedFailure = true;
      // A first failed read cannot check any name, and no later read can prove one gone.
      if (first) return report();
    } else {
      last = entries;
      await classify();
    }
    first = false;
    // Every read checks every recorded name. A name that one read missed stays eligible, so a
    // name that another process created again reaches the report (issue #1569).
    const current = leftovers();
    // An uncheckable name stays listed, but it never changes, so it adds no wait.
    if (!current.some(isCheckableName)) return report();
    const nowAt = now();
    if (nowAt >= deadline) return report();
    const pause = Math.min(intervalMs, finalStart - nowAt);
    if (pause <= 0) continue;
    try {
      // The sleep is abortable, so a cancel ends the wait at once.
      await sleep(pause, signal);
    } catch (err) {
      if (signal?.aborted) throw canceledError();
      throw err;
    }
  }
}

const heldNames = (names, entries) => {
  const present = new Set(entries);
  return names.filter((name) => stillHeld(name, present));
};

function throwIfCanceled(signal) {
  if (signal?.aborted) throw canceledError();
}

const canceledError = () => Object.assign(new Error("Interrupted by SIGINT"), { isCanceled: true });

function cancelPromise(signal) {
  if (!signal) return { promise: new Promise(() => {}), cleanup: () => {} };
  if (signal.aborted) {
    const promise = Promise.reject(canceledError());
    promise.catch(() => {});
    return { promise, cleanup: () => {} };
  }
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(canceledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) };
}

async function readInheritedTmpdirNames() {
  return readdir(tmpdir());
}

// Whether an entry still holds `name`. A name that cannot be checked stays present, because a lost
// name can hide a leftover.
function stillHeld(name, present) {
  if (!isCheckableName(name)) return true;
  return present.has(bareName(name));
}

// Whether the read can establish that `name` is gone. A registered mark is not part of the entry.
function isCheckableName(name) {
  const bare = bareName(name);
  if (bare === "" || bare === "." || bare === "..") return false;
  return !UNSAFE_NAME.test(bare) && !REDACTED_NAME.test(bare);
}

function bareName(name) {
  return name.startsWith(REGISTERED_PREFIX) ? name.slice(REGISTERED_PREFIX.length) : name;
}

/**
 * Carries the list on a fatal error as `err.inheritedTmpdirEntries`. A frozen error or a throwing
 * setter keeps the original error, and the list stays readable through
 * `failedInheritedTmpdirEntries`.
 */
export const carryInheritedTmpdirEntries = carrier.carry;

/** Returns the list a fatal error carries, or `undefined` when it carries none. */
export const failedInheritedTmpdirEntries = carrier.failed;
