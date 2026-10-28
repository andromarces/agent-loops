// Process identity: liveness of a pid and its start-time stamp, which tells a live owner from a
// reused pid (#173, ADR 0020). Reads the process table or /proc; the state lock only calls it.
import { readFile, readlink } from "node:fs/promises";
import { execBounded } from "./exec.mjs";

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
async function queryOutput(command, args) {
  const result = await execBounded(command, args, {
    env: { TZ: "UTC", LC_ALL: "C" },
    timeoutMs: START_TIME_QUERY_MS,
    windowsHide: true,
  });
  return result.exitCode === 0 && !result.timedOut && !result.isCanceled && !result.isMaxBuffer
    ? String(result.stdout ?? "").trim()
    : "";
}

// Reads a process constant (the NSpid view, the PID namespace, the boot id) once per process,
// so a waiting wrapper does not repeat the read on every lock poll. A failed read is not kept:
// the next call retries it, so a transient failure never turns the stamp off for good.
function memoizeRead(read) {
  let pending;
  return () =>
    (pending ??= read().catch((err) => {
      pending = undefined;
      throw err;
    }));
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
const ownProcView = memoizeRead(async () => {
  const status = await readFile("/proc/self/status", "utf8");
  const entries = /^NSpid:[ \t]*(.*)$/m.exec(status)?.[1].trim().split(/\s+/);
  return entries?.length === 1 && entries[0] === String(process.pid);
});

const readPidNamespace = memoizeRead(
  async () => /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))?.[1],
);

const readBootId = memoizeRead(async () =>
  (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
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
 * Start-time stamp of the process `pid`, `<kind>:<value>`, or null when it cannot
 * be read (a missing platform source, or a failed, timed-out, empty, or unparseable
 * read). Callers compare only stamps of one kind. The kind is chosen by platform:
 * - `linux-proc`: /proc stat ticks, boot id, and PID namespace (no spawn, clock
 *   independent).
 * - `darwin-lstart`: epoch seconds of `ps -o lstart=` under TZ=UTC and LC_ALL=C. The
 *   kernel stores the start time (`p_starttime`) once at process creation and `ps`
 *   formats it, so a clock step afterward does not change it (from the XNU source;
 *   not exercised here, since the test machine cannot step its clock).
 * - `win32-creation`: epoch seconds of the process creation time, from PowerShell
 *   (`Process.StartTime`, the creation FILETIME that Windows stores at creation;
 *   likewise not exercised under a clock step).
 * Any other platform has no stamp, and its locks read as alive. No native dependency.
 */
export async function processStartTime(pid) {
  try {
    if (process.platform === "linux") {
      return await linuxProcStamp(pid);
    }
    if (process.platform === "darwin") {
      const time = parseLstart(await queryOutput("ps", ["-o", "lstart=", "-p", String(pid)]));
      return time === null ? null : `darwin-lstart:${time}`;
    }
    if (process.platform === "win32") {
      const text = await queryOutput("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[DateTimeOffset]::new([System.Diagnostics.Process]::GetProcessById(${pid}).StartTime).ToUnixTimeSeconds()`,
      ]);
      return /^\d{1,15}$/.test(text) ? `win32-creation:${text}` : null;
    }
  } catch {
    // An unreadable source has no stamp.
  }
  return null;
}

let ownStartTimeQuery;

// The start time stamp of this process, read once on the first lock creation: the
// lock content of every acquisition carries it. Linux reads /proc; macOS spawns one
// `ps`; Windows spawns one PowerShell (a startup of about 0.8 s on a loaded 16-CPU Windows host, 2026-10-23, bounded by
// START_TIME_QUERY_MS). Node has no cheaper source of the OS start time:
// `process.uptime()` stops during a system sleep on POSIX, so `Date.now()` minus it
// is not the start time.
// known-limit: the Windows spawn is paid once by each process that takes a lock.
export function ownStartTime() {
  ownStartTimeQuery ??= processStartTime(process.pid).then((stamp) => stamp ?? undefined);
  return ownStartTimeQuery;
}

// Two reads of one process on the fixed-at-creation sources differ by at most this
// many seconds: it covers their one-second resolution only, not a clock step.
const START_TIME_TOLERANCE_S = 2;

const EPOCH_STAMP = {
  "darwin-lstart": /^darwin-lstart:(\d{1,15})$/,
  "win32-creation": /^win32-creation:(\d{1,15})$/,
};
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

// True when the owner of a lock or claim still runs. Checks in order:
// 1. A valid `linux-proc` stamp whose PID namespace differs from the reader, or any
//    valid `linux-proc` stamp while the reader namespace cannot be read, reads as alive
//    before the pid probe, whether its pid is alive here or not. A differing namespace
//    means the recorded pid belongs to another namespace (a container that shares the
//    runs root), so `pidAlive` cannot say whether that owner runs. An unreadable
//    reader namespace means the reader cannot tell whether the stamp namespace is its
//    own, so it keeps the lock. Other stamp kinds skip this step.
// 2. A dead pid reads as dead, with any stamp or none (the pid-only check).
// 3. A live pid reads as dead only when its recorded stamp and the stamp of the process
//    now at that pid are valid, of one kind, and differ (see `startTimesDiffer`): the
//    pid was reused. Every other live pid reads as alive: no recorded stamp (an older
//    version, or an owner that could not read its own), an invalid stamp, a kind
//    mismatch, and a current read that is null (failed, timed out, empty, or
//    unparseable).
// known-limit: step 1 never takes a lock over, even when its owner is dead: a crashed
// owner of another namespace, and a crashed owner of this namespace when the reader
// cannot read its own PID namespace, keep the lock until a person checks that the owner
// is gone and removes the lock file (and any `.reap.<digest>` claim beside it).
export async function ownerAlive(owner) {
  const recorded = parseStamp(owner.startTime);
  if (recorded?.kind === "linux-proc" && recorded.namespace !== (await readerPidNamespace())) {
    return true;
  }
  if (!pidAlive(owner.pid)) {
    return false;
  }
  if (typeof owner.startTime !== "string") {
    return true;
  }
  const current = await processStartTime(owner.pid);
  return current === null || !startTimesDiffer(owner.startTime, current);
}
