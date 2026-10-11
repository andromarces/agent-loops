// Process-ancestry harness detection (#139). A nested harness inherits the
// parent's session variables, so no environment variable can identify the
// running harness. The nearest harness process above the shell command can.
// Returns null when the platform, the process table, or the ancestry is absent,
// so the Claude, Codex, and Antigravity skills refuse to start instead of
// registering the wrong parent.
import { exec } from "./exec.mjs";
import { harnessForCommand } from "./harnesses.mjs";

// Characters of decoded text per output stream of a process-table read.
const PROCESS_TABLE_MAX_BUFFER = 32 * 1024 * 1024;

export function harnessForProcessName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    return null;
  }
  const normalized = name
    .trim()
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, "");
  return harnessForCommand(normalized) ?? null;
}

// Seconds that a process-table read waits before it ends the process. The end signal is SIGTERM,
// and `exec` force-kills after execa's 5 s default delay, so a read that ignores SIGTERM ends about
// 35 s after the start on POSIX.
const PROCESS_READ_TIMEOUT_SECONDS = 30;

/**
 * Failure of a process-table read. The message and `reason` hold the reason class only: timeout,
 * cancel, exit code, signal termination, spawn failure, or unreadable output. They never hold output of the read,
 * because the process table carries the command lines of every process on the host, and those
 * lines can carry the secrets of other programs.
 */
export class ProcessReadError extends Error {
  constructor(reason, { isCanceled = false } = {}) {
    super(`process table read ${reason}`);
    this.name = "ProcessReadError";
    this.reason = reason;
    this.isCanceled = isCanceled;
  }
}

function readFailure(err, timeout) {
  if (err?.isCanceled) {
    return new ProcessReadError("was canceled", { isCanceled: true });
  }
  if (err?.timedOut) {
    return new ProcessReadError(`timed out after ${timeout} second${timeout === 1 ? "" : "s"}`);
  }
  if (Number.isInteger(err?.exitCode)) {
    return new ProcessReadError(`exited with code ${err.exitCode}`);
  }
  if (err?.isTerminated) {
    return new ProcessReadError("was killed by a signal");
  }
  return new ProcessReadError("failed to start");
}

// Each column has its `ps` keyword and its `Win32_Process` property. A numeric column is a pid.
const PROCESS_COLUMNS = {
  pid: { ps: "pid=", win: "ProcessId", numeric: true },
  ppid: { ps: "ppid=", win: "ParentProcessId", numeric: true },
  name: { ps: "comm=", win: "Name" },
  command: { ps: "command=", win: "CommandLine" },
};

/**
 * Reads the process table with the named columns. The read runs through `exec`, so `signal` cancels
 * it and `timeout` (seconds) bounds it. `columns` lists the numeric columns first and one text
 * column last, for example `["pid", "ppid", "name"]`. Every failure rejects with a
 * `ProcessReadError`, whose `isCanceled` is true for a cancel.
 * @param {(keyof typeof PROCESS_COLUMNS)[]} columns
 * @param {{ signal?: AbortSignal, timeout?: number }} [options]
 * @returns {Promise<Record<string, string | number>[]>}
 */
async function readProcessColumns(
  columns,
  { signal, timeout = PROCESS_READ_TIMEOUT_SECONDS } = {},
) {
  const windows = process.platform === "win32";
  const specs = columns.map((column) => PROCESS_COLUMNS[column]);
  const [command, args] = windows
    ? [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process | Select-Object ${specs.map((spec) => spec.win).join(",")} | ConvertTo-Json -Compress`,
        ],
      ]
    : ["ps", ["-eo", specs.map((spec) => spec.ps).join(",")]];
  let stdout;
  try {
    ({ stdout } = await exec(command, args, {
      signal,
      timeout,
      maxBuffer: PROCESS_TABLE_MAX_BUFFER,
    }));
  } catch (err) {
    throw readFailure(err, timeout);
  }
  if (windows) {
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim() || "[]");
    } catch {
      throw new ProcessReadError("returned output that is not JSON");
    }
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) =>
      Object.fromEntries(
        columns.map((column) => [
          column,
          row[PROCESS_COLUMNS[column].win] ?? (column === "command" ? "" : undefined),
        ]),
      ),
    );
  }
  const line = new RegExp(
    `^\\s*${specs.map((spec) => (spec.numeric ? "(\\d+)\\s+" : "(.*)")).join("")}$`,
  );
  return stdout
    .split("\n")
    .map((text) => text.match(line))
    .filter(Boolean)
    .map((match) =>
      Object.fromEntries(
        columns.map((column, index) => [
          column,
          PROCESS_COLUMNS[column].numeric ? Number(match[index + 1]) : match[index + 1],
        ]),
      ),
    );
}

/**
 * Lists every process with its full command line, for a check that needs the arguments.
 * @param {{ signal?: AbortSignal, timeout?: number }} [options]
 * @returns {Promise<{ pid: number, command: string }[]>}
 */
export function readProcessCommands(options) {
  return readProcessColumns(["pid", "command"], options);
}

/**
 * Lists every process with its parent and name, for the ancestry walk.
 * @param {{ signal?: AbortSignal, timeout?: number }} [options]
 * @returns {Promise<{ pid: number, ppid: number, name: string }[]>}
 */
export function readProcessTable(options) {
  return readProcessColumns(["pid", "ppid", "name"], options);
}

/**
 * Walks from `startPid` to the first process that is a known harness.
 * @returns {Promise<string|null>} the harness id, or null when ancestry is absent
 */
export async function nearestHarness({
  startPid = process.ppid,
  readProcesses = readProcessTable,
  signal,
} = {}) {
  if (!Number.isInteger(Number(startPid)) || Number(startPid) <= 0) {
    return null;
  }
  const byPid = new Map();
  for (const entry of await readProcesses({ signal })) {
    byPid.set(String(entry.pid), entry);
  }

  const seen = new Set();
  let pid = String(startPid);
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const entry = byPid.get(pid);
    if (!entry) {
      return null;
    }
    const harness = harnessForProcessName(entry.name);
    if (harness) {
      return harness;
    }
    if (entry.ppid === undefined || entry.ppid === null) {
      return null;
    }
    pid = String(entry.ppid);
    if (pid === "0" || pid === "1") {
      return null;
    }
  }
  return null;
}
