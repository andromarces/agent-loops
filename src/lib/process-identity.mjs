// Process identity: liveness of a pid and its start-time stamp, which tells a live owner from a
// reused pid (#498, ADR 0020). Reads the process table or /proc.
import { readFile, readlink } from "node:fs/promises";
import { execBounded } from "./exec.mjs";

/**
 * Reports whether `pid` names a live process. `EPERM` counts as alive, because the process exists
 * but belongs to another user.
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/;

// Epoch seconds of a `ps -o lstart=` line read under TZ=UTC and LC_ALL=C, or null
// when the line is not in that format or names a date that does not exist (the 31st
// of a 30-day month): `Date.UTC` normalizes such fields, so each must round-trip.
function parseLstart(text) {
  const match = LSTART.exec(text);
  const month = match === null ? -1 : MONTHS.indexOf(match[1]);
  if (month < 0) {
    return null;
  }
  const [day, hour, minute, second, year] = match.slice(2).map(Number);
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(ms);
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? ms / 1000 : null;
}

// Upper bound on one `ps` or PowerShell query, so a hung one cannot hold a lock
// acquisition. The Linux read of /proc spawns nothing and has no bound.
const START_TIME_QUERY_MS = 5000;

// Output of `command` run under TZ=UTC and LC_ALL=C, trimmed; "" when the command
// fails, times out after START_TIME_QUERY_MS, overflows its output buffer (a cut
// read, which execa can report with exit code 0), or prints nothing.
async function queryOutput(command, args, timeoutMs = START_TIME_QUERY_MS) {
  const result = await execBounded(command, args, {
    env: { TZ: "UTC", LC_ALL: "C" },
    timeoutMs,
    windowsHide: true,
  });
  return result.exitCode === 0 && !result.timedOut && !result.isCanceled && !result.isMaxBuffer
    ? String(result.stdout ?? "").trim()
    : "";
}

// Reads a process constant (the NSpid view, the PID namespace, the boot id) once per process, so a
// waiting wrapper does not repeat the read on every lock poll. Concurrent callers share the read in
// flight. The value is kept only when `isValid` accepts it: a failed, empty, or malformed read is
// dropped, so the next call reads again, a source that recovers is used, and a bad read never turns
// the stamp off for the rest of the process.
function memoizeRead(read, isValid) {
  let pending;
  return () => {
    if (pending === undefined) {
      const attempt = read().then(
        (value) => {
          if (!isValid(value)) {
            pending = undefined;
          }
          return value;
        },
        (err) => {
          pending = undefined;
          throw err;
        },
      );
      pending = attempt;
    }
    return pending;
  };
}

// Field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat, joined with the
// PID namespace of this process and the boot id. Ticks and boot id are independent of
// the wall clock, so a clock step (NTP, a manual set, a suspend) never changes the
// stamp of a running process, and the boot id keeps the ticks of one boot from
// matching another. The namespace (the inode in the target of /proc/self/ns/pid) keeps
// a pid of another PID namespace, such as a container that shares the runs root, from
// being compared with a process of this one. The command name (field 2) can hold
// spaces and parentheses, so fields count from the last ")".
// The /proc mount must be a view of the PID namespace of this process, the one that
// `process.kill(pid, 0)` and the lock content use: in a mount of an ancestor namespace,
// /proc/<pid>/stat can describe an unrelated process, because pids are allocated per
// namespace (and a /proc/self link can equal `process.pid` there by coincidence).
// `ownProcView` checks the NSpid line of /proc/self/status. proc_pid_status(5) (man7.org,
// "NSpid", since Linux 4.1) states that the entries are the pid in each PID namespace of
// which the process is a member, the leftmost with respect to the namespace of the process
// that mounted the procfs, followed by the value in each nested inner namespace. A single
// entry therefore means the mount's namespace is the namespace of this process, and the
// entry is the pid in it. The check is on the writer (own stamp) and the reader (stamp of
// the owner pid) alike. It proves that the namespace of the mounter equals the namespace of
// this process, and nothing more: it does not prove that `pid` in /proc is the lock owner
// (that is the stamp comparison), and it does not cover a kernel that lacks NSpid.
// A missing NSpid line, an unreadable status, and any other form give no stamp, and the
// owner reads as alive (the pid-only check).
const ownProcView = memoizeRead(
  async () => {
    const status = await readFile("/proc/self/status", "utf8");
    const entries = /^NSpid:[ \t]*(.*)$/m.exec(status)?.[1].trim().split(/\s+/);
    return entries?.length === 1 && entries[0] === String(process.pid);
  },
  (inOwnView) => inOwnView === true,
);

const readPidNamespace = memoizeRead(
  async () => /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))?.[1],
  (namespace) => namespace !== undefined,
);

const readBootId = memoizeRead(
  async () => (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
  (bootId) => BOOT_ID.test(bootId),
);

// The PID namespace inode of this process (the target of /proc/self/ns/pid), or
// undefined when it cannot be read or does not parse.
async function readerPidNamespace() {
  try {
    return await readPidNamespace();
  } catch {
    return undefined;
  }
}

async function linuxProcStamp(pid) {
  if (!(await ownProcView())) {
    return null;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const bootId = await readBootId();
  const namespace = await readerPidNamespace();
  const stamp = `linux-proc:${namespace}:${bootId}:${fields[19]}`;
  return parseStamp(stamp) === null ? null : stamp;
}

/**
 * Start-time stamp of the process `pid` as `<kind>:<value>`, or null when it cannot be read.
 * A missing platform source, and a failed, timed-out, empty, or unparseable read, give null.
 * Callers compare only stamps of one kind, which the platform chooses. `linux-proc` uses /proc stat
 * ticks, the boot id, and the PID namespace, with no spawn and no clock dependence.
 * `darwin-lstart` and `win32-creation` hold epoch seconds from a fixed-at-creation source, so a
 * later clock step does not change them. Any other platform has no stamp, its locks read as alive,
 * and no native dependency is used.
 */
export async function processStartTime(pid, { timeoutMs = START_TIME_QUERY_MS } = {}) {
  // Injectable so a test can shorten the query bound; production keeps the 5000 ms default.
  try {
    if (process.platform === "linux") {
      // `linux-proc` needs no spawn and no clock: /proc stat ticks, the boot id, and this PID namespace.
      return await linuxProcStamp(pid);
    }
    if (process.platform === "darwin") {
      // `ps -o lstart=` runs under TZ=UTC and LC_ALL=C. The kernel stores the start time
      // (`p_starttime`) once at creation, so a later clock step does not change it (ADR 0020).
      const time = parseLstart(
        await queryOutput("ps", ["-o", "lstart=", "-p", String(pid)], timeoutMs),
      );
      return time === null ? null : `darwin-lstart:${time}`;
    }
    if (process.platform === "win32") {
      // The PowerShell `Process.StartTime` reads the creation FILETIME, which a clock step does
      // not change (ADR 0020).
      const text = await queryOutput(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[DateTimeOffset]::new([System.Diagnostics.Process]::GetProcessById(${pid}).StartTime).ToUnixTimeSeconds()`,
        ],
        timeoutMs,
      );
      return /^\d{1,15}$/.test(text) ? `win32-creation:${text}` : null;
    }
  } catch {
    // An unreadable source has no stamp.
  }
  return null;
}

let ownStartTimeQuery;

/**
 * The start time stamp of this process, read once on the first lock creation, because every
 * acquisition carries it in the lock content. Linux reads /proc, macOS spawns one `ps`, and Windows
 * spawns one PowerShell. The PowerShell spawn is bounded by `START_TIME_QUERY_MS`, and its measured
 * cost is in ADR 0020. Node has no cheaper source of the OS start time, because `process.uptime()`
 * stops during a system sleep on POSIX. `Date.now()` minus that value is then not the start time.
 * known-limit: the Windows spawn is paid once by each process that takes a lock.
 */
export function ownStartTime() {
  ownStartTimeQuery ??= processStartTime(process.pid).then((stamp) => stamp ?? undefined);
  return ownStartTimeQuery;
}

// Longest time one cached start-time stamp is used before a fresh probe. It bounds the
// window in which a pid reuse reads as the recorded owner.
export const START_TIME_CACHE_MAX_AGE_MS = 5000;

/**
 * A start-time probe cache for one wait. `probe` defaults to `processStartTime`, and
 * `monotonic` defaults to the monotonic `performance.now`. An entry is keyed by pid and
 * recorded stamp, and it expires after `START_TIME_CACHE_MAX_AGE_MS`. A null result is not
 * cached, and `forget` drops a pid's entries. A wall-clock step cannot extend an entry, because
 * age never reads the wall clock. known-limit: a pid reused within the age reads as its recorded
 * owner until the next probe.
 */
export function startTimeCache({
  probe = processStartTime,
  monotonic = () => performance.now(),
} = {}) {
  const entries = new Map();
  return {
    async probe(pid, recorded) {
      const key = `${pid}\u0000${recorded}`;
      const hit = entries.get(key);
      if (hit !== undefined && monotonic() - hit.at < START_TIME_CACHE_MAX_AGE_MS) {
        return hit.stamp;
      }
      const stamp = await probe(pid);
      if (stamp === null) {
        entries.delete(key);
      } else {
        entries.set(key, { stamp, at: monotonic() });
      }
      return stamp;
    },
    forget(pid) {
      const prefix = `${pid}\u0000`;
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
        }
      }
    },
  };
}

// Two reads of one process on the fixed-at-creation sources differ by at most this
// many seconds: it covers their one-second resolution only, not a clock step.
const START_TIME_TOLERANCE_S = 2;

const EPOCH_STAMP = {
  "darwin-lstart": /^darwin-lstart:(\d{1,15})$/,
  "win32-creation": /^win32-creation:(\d{1,15})$/,
};
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINUX_STAMP =
  /^linux-proc:(\d{1,20}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,20})$/i;

// The structure of a stamp, or null when it is not exactly one of the known forms:
// `linux-proc:<namespace>:<boot id>:<ticks>`, or `<darwin-lstart|win32-creation>:
// <epoch seconds>` with plain digits, so a value that is empty, signed, fractional,
// exponential, or not finite never parses.
function parseStamp(text) {
  if (typeof text !== "string") {
    return null;
  }
  const linux = LINUX_STAMP.exec(text);
  if (linux !== null) {
    return {
      kind: "linux-proc",
      namespace: linux[1],
      boot: linux[2].toLowerCase(),
      ticks: linux[3],
    };
  }
  for (const [kind, pattern] of Object.entries(EPOCH_STAMP)) {
    const match = pattern.exec(text);
    if (match !== null) {
      return { kind, seconds: Number(match[1]) };
    }
  }
  return null;
}

// True when two stamps name different processes. Anything that is not a plain
// mismatch of one structure is not different, and the caller reads it as alive: a
// stamp that does not parse (either one), a kind mismatch, and a `linux-proc` pair of
// different PID namespaces, where the pid of the recorded owner means another process
// here and no stamp comparison is meaningful.
function startTimesDiffer(recorded, current) {
  const a = parseStamp(recorded);
  const b = parseStamp(current);
  if (a === null || b === null || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "linux-proc") {
    return a.namespace === b.namespace && (a.boot !== b.boot || a.ticks !== b.ticks);
  }
  return Math.abs(a.seconds - b.seconds) > START_TIME_TOLERANCE_S;
}

/**
 * True when the owner of a lock or claim still runs, checked in three steps.
 * A `linux-proc` stamp whose PID namespace differs from the reader reads as alive before the pid
 * probe. So does any valid `linux-proc` stamp when the reader cannot read its own namespace.
 * A dead pid reads as dead, and a live pid reads as dead only on a valid stamp pair of one kind
 * that differs. Every other live pid reads as alive, with no recorded stamp, an invalid stamp, a
 * kind mismatch, or a null current read. known-limit: step 1 never takes a lock over, even when its
 * owner is dead.
 */
export async function ownerAlive(owner, cache) {
  const recorded = parseStamp(owner.startTime);
  if (recorded?.kind === "linux-proc" && recorded.namespace !== (await readerPidNamespace())) {
    // A differing namespace means the recorded pid belongs to another namespace, such as a container
    // that shares the runs root.
    // `pidAlive` cannot say whether that owner runs, so the read stays alive.
    // An unreadable reader namespace keeps the lock, because the reader cannot tell whose stamp it is, and other stamp kinds skip this step.
    // A crashed owner of another namespace keeps the lock, and so does a crashed owner here when the reader cannot read its namespace.
    // A person then checks that the owner is gone and removes the lock file, plus any `.reap.<digest>` claim beside it.
    return true;
  }
  if (!pidAlive(owner.pid)) {
    // A dead pid reads as dead with any stamp or none, the pid-only check.
    // A dead pid frees its slot at once, and no stale entry waits to match a reused pid.
    cache?.forget(owner.pid);
    return false;
  }
  if (typeof owner.startTime !== "string") {
    // An older version, or an owner with no readable stamp of its own, leaves no recorded stamp.
    return true;
  }
  // Without a cache, the own stamp is memoized after a good read, so a lock of this process needs
  // no query per check. A memoized failure still probes, so a recovered source frees the lock.
  // The pid was reused only when both stamps are valid, of one kind, and differ (see `startTimesDiffer`).
  // A null current read comes from a failed, timed-out, empty, or unparseable read, and reads as alive.
  let current;
  if (owner.pid === process.pid && cache === undefined) {
    current = (await ownStartTime()) ?? (await processStartTime(process.pid));
  } else if (cache) {
    current = await cache.probe(owner.pid, owner.startTime);
  } else {
    current = await processStartTime(owner.pid);
  }
  return current === null || !startTimesDiffer(owner.startTime, current);
}
