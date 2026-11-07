import { lstat, open as openFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mapInBatches } from "./batches.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
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
 * macOS, an orphaned SQLite `-shm` and `-wal` pair whose main file is absent is settled. Every
 * other name stays listed, and a failed or over-bound probe keeps its name listed.
 * @param {Iterable<string>} names
 * @param {{
 *   platform?: string,
 *   probe?: (name: string) => Promise<"held" | "free" | "unknown">,
 *   entries?: Iterable<string> | null,
 *   boundMs?: number,
 * }} [options]
 * @returns {Promise<{ leftovers: string[], settled: string[] }>}
 */
export async function settleInheritedTmpdirNames(
  names,
  {
    platform = process.platform,
    probe = probeHeldOpenWindows,
    entries = null,
    boundMs = PROBE_BOUND_MS,
  } = {},
) {
  const recorded = [...new Set(names)].filter((name) => typeof name === "string" && name !== "");
  if (recorded.length === 0) return { leftovers: [], settled: [] };
  const settled = new Set();
  const listed = entries === null ? null : new Set(entries);
  try {
    await withTimeBound(
      Math.max(1, boundMs),
      `inherited temporary directory probe took over ${boundMs} ms`,
      async ({ signal, stopped }) => {
        for (const name of recorded) {
          if (signal.aborted) break;
          if (await settlesName(name, { platform, probe, listed, stopped })) settled.add(name);
        }
      },
    );
  } catch {}
  return {
    leftovers: recorded.filter((name) => !settled.has(name)),
    settled: recorded.filter((name) => settled.has(name)),
  };
}

async function settlesName(name, { platform, probe, listed, stopped }) {
  if (!isCheckableName(name) || name.startsWith(REGISTERED_PREFIX)) return false;
  if (platform === "win32") {
    let outcome;
    try {
      outcome = await Promise.race([probe(name), stopped]);
    } catch {
      return false;
    }
    return outcome === "held";
  }
  if (platform === "darwin" && listed !== null) return isOrphanedSqlitePair(name, listed);
  return false;
}

function isOrphanedSqlitePair(name, listed) {
  const match = /^(.+)-(?:shm|wal)$/.exec(name);
  if (match === null) return false;
  const base = match[1];
  return listed.has(`${base}-shm`) && listed.has(`${base}-wal`) && !listed.has(base);
}

// A Windows open with exclusive sharing fails with EBUSY while another handle is open. The open
// reads no byte, and the handle closes on every path.
async function probeHeldOpenWindows(name) {
  const path = join(tmpdir(), name);
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return "unknown";
    handle = await openFile(path, WINDOWS_EXCLUSIVE_SHARE);
    return "free";
  } catch (err) {
    return err?.code === "EBUSY" ? "held" : "unknown";
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
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
 *   probeBoundMs?: number,
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
    probeBoundMs = RE_READ_BOUND_MS,
  } = {},
) {
  const recorded = [...new Set(names)].filter((name) => typeof name === "string" && name !== "");
  if (recorded.length === 0) return { present: [], settled: [] };
  if (settle === null) {
    const entries = await readNames(read, boundMs);
    const present = entries === null ? recorded : heldNames(recorded, entries);
    return settlePresent(present, { probe, platform, entries, boundMs: probeBoundMs });
  }
  return settledNames(recorded, {
    read,
    readBoundMs: boundMs,
    probe,
    platform,
    probeBoundMs,
    ...settle,
  });
}

async function settlePresent(present, { probe, platform, entries, boundMs }) {
  const { leftovers, settled } = await settleInheritedTmpdirNames(present, {
    ...(probe ? { probe } : {}),
    ...(platform ? { platform } : {}),
    ...(entries === null || entries === undefined ? {} : { entries }),
    boundMs,
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
    const result = await settleInheritedTmpdirNames(toCheck, {
      ...(probe ? { probe } : {}),
      ...(platform ? { platform } : {}),
      ...(last === null ? {} : { entries: last }),
      boundMs: Math.max(1, Math.min(probeBoundMs, Math.floor(available))),
    });
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
      if (entries !== null) last = entries;
      await classify();
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
    }
    first = false;
    await classify();
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
