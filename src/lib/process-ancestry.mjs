// Process-ancestry harness detection (#139). A nested harness inherits the
// parent's session variables, so no environment variable can identify the
// running harness. The nearest harness process above the shell command can.
// Returns null when the platform, the process table, or the ancestry is absent,
// so the Codex and Antigravity skills refuse to start instead of registering
// the wrong parent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Process basename (lowercased, extension stripped) to harness id.
const HARNESS_BY_PROCESS = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["copilot", "copilot"],
  ["opencode", "opencode"],
  ["agy", "antigravity"],
  ["antigravity", "antigravity"],
]);

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
  return HARNESS_BY_PROCESS.get(normalized) ?? null;
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
