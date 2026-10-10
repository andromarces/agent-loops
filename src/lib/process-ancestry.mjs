// Process-ancestry harness detection (#139). A nested harness inherits the
// parent's session variables, so no environment variable can identify the
// running harness. The nearest harness process above the shell command can.
// Returns null when the platform, the process table, or the ancestry is absent,
// so the Claude, Codex, and Antigravity skills refuse to start instead of
// registering the wrong parent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exec } from "./exec.mjs";
import { harnessForCommand } from "./harnesses.mjs";

const execFileAsync = promisify(execFile);

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

async function readWindowsProcesses() {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout.trim() || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    name: row.Name,
  }));
}

async function readPosixProcesses() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm="], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3] }));
}

// Seconds that the command-line read waits before it ends the process. The end signal is SIGTERM,
// and `exec` force-kills after execa's 5 s default delay, so a read that ignores SIGTERM ends about
// 35 s after the start on POSIX.
const COMMANDS_READ_TIMEOUT_SECONDS = 30;

/**
 * Failure of the command-line read. The message and `reason` hold the reason class only: timeout,
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

/**
 * Lists every process with its full command line, for a check that needs the arguments. The read
 * runs through `exec`, so `signal` cancels it and `timeout` (seconds) bounds it. Every failure
 * rejects with a `ProcessReadError`, whose `isCanceled` is true for a cancel.
 * @param {{ signal?: AbortSignal, timeout?: number }} [options]
 * @returns {Promise<{ pid: number, command: string }[]>}
 */
export async function readProcessCommands({
  signal,
  timeout = COMMANDS_READ_TIMEOUT_SECONDS,
} = {}) {
  const windows = process.platform === "win32";
  const [command, args] = windows
    ? [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
      ]
    : ["ps", ["-eo", "pid=,command="]];
  let stdout;
  try {
    ({ stdout } = await exec(command, args, { signal, timeout, maxBuffer: 32 * 1024 * 1024 }));
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
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: row.ProcessId,
      command: row.CommandLine ?? "",
    }));
  }
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

export async function readProcessTable() {
  return process.platform === "win32" ? readWindowsProcesses() : readPosixProcesses();
}

/**
 * Walks from `startPid` to the first process that is a known harness.
 * @returns {Promise<string|null>} the harness id, or null when ancestry is absent
 */
export async function nearestHarness({
  startPid = process.ppid,
  readProcesses = readProcessTable,
} = {}) {
  if (!Number.isInteger(Number(startPid)) || Number(startPid) <= 0) {
    return null;
  }
  const byPid = new Map();
  for (const entry of await readProcesses()) {
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
