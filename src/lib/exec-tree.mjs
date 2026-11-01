import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { logDebug, logWarn } from "./log.mjs";

const TASKKILL_TIMEOUT_MS = 5000;
// `taskkill` reports 128 when no process has the pid. It is neither a failure nor a confirmed kill.
const TASKKILL_NO_SUCH_PROCESS = 128;

// Bound on one process-table read of a tree end. A read that passes it is ended, so a hung `ps`
// cannot hold the parent exit past this bound.
const TREE_READ_TIMEOUT_MS = 2000;
const TREE_READ_MAX_BUFFER = 16 * 1024 * 1024;

const liveRuns = new Set();
// POSIX only: children whose descendants a parent signal ends with a process-table walk.
const commandTrees = new Set();
let exitHandlerInstalled = false;
let sigTermHandlerInstalled = false;

// Same root test as execa: a drive-absolute directory, so the exit handler never runs a
// `taskkill` that a relative path or a `PATH` lookup resolves.
function taskkillFile() {
  const root = [process.env.SystemRoot, process.env.windir].find(
    (dir) => dir && isAbsolute(dir) && /^[a-z]:/i.test(dir),
  );
  return root === undefined ? undefined : join(root, "System32", "taskkill.exe");
}

/**
 * Parses `ps -eo pid=,ppid=,lstart=` output into a map of pid to its parent pid and start stamp.
 * The stamp is the text that `ps` printed, so two reads of one process compare equal.
 * @param {string} text
 * @returns {Map<number, { pid: number, ppid: number, start: string }>}
 */
export function processTableRows(text) {
  const rows = new Map();
  for (const line of String(text).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid)) {
      rows.set(pid, { pid, ppid: Number(match[2]), start: match[3].trim() });
    }
  }
  return rows;
}

/**
 * Returns the rows of `table` below any pid in `roots`, keyed by pid, by parent links only. A row
 * whose parent chain does not reach a root is not a descendant, so a process of another run is
 * never in the result. A pid is visited once, so a malformed cycle ends the walk.
 * @param {Map<number, { pid: number, ppid: number, start: string }>} table
 * @param {number[]} roots
 */
export function descendantRows(table, roots) {
  const children = new Map();
  for (const row of table.values()) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const found = new Map();
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    for (const row of children.get(queue.shift()) ?? []) {
      if (seen.has(row.pid) || row.pid <= 1) continue;
      seen.add(row.pid);
      found.set(row.pid, row);
      queue.push(row.pid);
    }
  }
  return found;
}

/** Reads the process table with each pid's parent and start stamp, or null when the read fails. */
function readProcessTableSync() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: TREE_READ_TIMEOUT_MS,
    maxBuffer: TREE_READ_MAX_BUFFER,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  return result.error || result.status !== 0 ? null : processTableRows(result.stdout);
}

/**
 * Ends with SIGKILL every process whose parent chain reaches a pid in `roots`. The set comes from
 * one table read. A second read drops a pid that is gone or whose start stamp changed, so a pid
 * reused between the two reads is never signaled. A failed, timed-out, or null read ends the walk
 * with no kill, and the caller is never held past `TREE_READ_TIMEOUT_MS` per read.
 * @param {{ roots?: number[],
 *   readTable?: () => Map<number, { pid: number, ppid: number, start: string }> | null,
 *   kill?: (pid: number) => void }} [options]
 * @returns {number[]} the pids that the kill call accepted
 */
export function endDescendantTrees({ roots = [], readTable = readProcessTableSync, kill } = {}) {
  const liveRoots = [...new Set(roots)].filter((pid) => Number.isInteger(pid) && pid > 1);
  if (liveRoots.length === 0) return [];
  let first;
  let second;
  try {
    first = readTable();
    if (!first) return [];
    const targets = descendantRows(first, liveRoots);
    if (targets.size === 0) return [];
    second = readTable();
    if (!second) return [];
    const ended = [];
    for (const row of targets.values()) {
      if (second.get(row.pid)?.start !== row.start) continue;
      try {
        if (kill) kill(row.pid);
        else process.kill(row.pid, "SIGKILL");
        ended.push(row.pid);
      } catch {
        // A process that ended between the read and the signal needs no end.
      }
    }
    return ended;
  } catch (error) {
    logWarn(`process tree end: the process table read failed: ${error?.code ?? error?.message}`);
    return [];
  }
}

/**
 * Ends the descendants of every live child that registered a tree end. A child that settled is
 * skipped, so a pid that the OS reassigned is never walked. Returns the pids that were signaled.
 * @returns {number[]}
 */
export function endCommandTrees() {
  if (process.platform === "win32") return [];
  const roots = [];
  for (const subprocess of commandTrees) {
    const child = subprocess.nodeChildProcess ?? subprocess;
    if (
      Number.isInteger(child.pid) &&
      child.pid > 1 &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      roots.push(child.pid);
    }
  }
  if (roots.length === 0) return [];
  const ended = endDescendantTrees({ roots });
  if (ended.length > 0) {
    logDebug(`process tree end: ended ${ended.length} descendant(s) of ${roots.join(", ")}`);
  }
  return ended;
}

// A SIGTERM listener keeps signal-exit from re-sending the signal while other listeners exist.
// This listener walks the trees, removes itself, and re-sends SIGTERM. The parent still ends by
// SIGTERM, and the walk is synchronous and bounded.
function onParentSigTerm() {
  try {
    endCommandTrees();
  } catch (error) {
    logWarn(`process tree end failed on SIGTERM: ${error?.code ?? error?.message}`);
  }
  process.removeListener("SIGTERM", onParentSigTerm);
  process.kill(process.pid, "SIGTERM");
}

function killTree(subprocess) {
  if (process.platform !== "win32") {
    // execa signals the process group when the run set `killDescendants`, else the direct child.
    // It returns false, and never throws, when the signal reaches no process.
    if (!subprocess.kill("SIGKILL")) {
      logWarn(`process tree of pid ${subprocess.pid} not ended: SIGKILL was not delivered`);
    }
    return;
  }
  // execa keeps the exit state on the Node child process that it wraps.
  const { pid, exitCode, signalCode } = subprocess.nodeChildProcess ?? subprocess;
  // A child that exited can leave a pid that the OS reassigned, so its tree is never signaled.
  if (!Number.isInteger(pid) || pid <= 0 || exitCode !== null || signalCode !== null) {
    return;
  }
  const file = taskkillFile();
  if (file === undefined) {
    logWarn(`process tree of pid ${pid} not ended: no absolute SystemRoot, killing the child only`);
    subprocess.kill();
    return;
  }
  const result = spawnSync(file, ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
  });
  if (result.error || (result.status !== 0 && result.status !== TASKKILL_NO_SUCH_PROCESS)) {
    const reason = result.error?.code ?? `exit code ${result.status}`;
    logWarn(`process tree of pid ${pid} not ended on exit: taskkill failed (${reason})`);
  } else if (result.status === TASKKILL_NO_SUCH_PROCESS) {
    // The root ended between the exit check and the kill. `taskkill /T` walks parent links from a
    // live root, so nothing shows that its descendants ended.
    logDebug(`taskkill found no process with pid ${pid} on exit: descendants not checked`);
  } else {
    logDebug(`process tree of pid ${pid} ended on exit`);
  }
}

/**
 * Force-kills the process tree of every live run at once, on every platform: SIGKILL to the process
 * group on POSIX, and `taskkill /T /F` on Windows. It never throws, so the remaining runs still get
 * their kill, and it blocks for up to one `taskkill` bound per live run on Windows.
 */
export function killLiveTrees() {
  for (const subprocess of liveRuns) {
    try {
      killTree(subprocess);
    } catch (error) {
      logWarn(`process tree of pid ${subprocess.pid} not ended on exit: ${error?.code ?? error}`);
    }
  }
}

/**
 * Records `subprocess` for `killLiveTrees` on every platform, and ends its process tree when this
 * process exits while the subprocess is live. Returns `subprocess`. Only Windows needs the exit
 * handler: execa `cleanup` starts `taskkill` without waiting,
 * and `taskkill /T` cannot find the descendants of a process that already exited, so a tree
 * outlived a parent that called `process.exit` (issue #612). A `taskkill` that finishes inside
 * the `exit` event ends the tree before the parent ends. The handler skips a child that exited,
 * a pid that is not a positive integer, and a run that settled, and it runs `taskkill` from the
 * `SystemRoot` directory only. A failure is logged and never thrown. A parent that a hard kill
 * ends runs no handler, so its tree can survive (ADR 0028).
 *
 * With `treeEnd` on POSIX, a parent signal also walks the child. Its descendants that left its
 * process group are ended by pid before the parent ends (ADR 0071).
 */
export function killTreeOnExit(subprocess, { treeEnd = false } = {}) {
  const pid = subprocess?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return subprocess;
  }
  liveRuns.add(subprocess);
  if (treeEnd) {
    commandTrees.add(subprocess);
    if (process.platform !== "win32" && !sigTermHandlerInstalled) {
      sigTermHandlerInstalled = true;
      process.on("SIGTERM", onParentSigTerm);
    }
  }
  const release = () => {
    liveRuns.delete(subprocess);
    commandTrees.delete(subprocess);
  };
  subprocess.then(release, release);
  if (process.platform === "win32" && !exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on("exit", killLiveTrees);
  }
  return subprocess;
}
