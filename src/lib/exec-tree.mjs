import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { logDebug, logWarn } from "./log.mjs";

const TASKKILL_TIMEOUT_MS = 5000;
// `taskkill` reports 128 when no process has the pid. It is neither a failure nor a confirmed kill.
const TASKKILL_NO_SUCH_PROCESS = 128;

const liveRuns = new Set();
let exitHandlerInstalled = false;

// Same root test as execa: a drive-absolute directory, so the exit handler never runs a
// `taskkill` that a relative path or a `PATH` lookup resolves.
function taskkillFile() {
  const root = [process.env.SystemRoot, process.env.windir].find(
    (dir) => dir && isAbsolute(dir) && /^[a-z]:/i.test(dir),
  );
  return root === undefined ? undefined : join(root, "System32", "taskkill.exe");
}

function killTree(subprocess) {
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

// An exit handler must not throw: the remaining runs still need their kill.
function killLiveTrees() {
  for (const subprocess of liveRuns) {
    try {
      killTree(subprocess);
    } catch (error) {
      logWarn(`process tree of pid ${subprocess.pid} not ended on exit: ${error?.code ?? error}`);
    }
  }
}

/**
 * Ends the process tree of `subprocess` when this process exits while the subprocess is live.
 * Returns `subprocess`. Only Windows needs it: execa `cleanup` starts `taskkill` without waiting,
 * and `taskkill /T` cannot find the descendants of a process that already exited, so a tree
 * outlived a parent that called `process.exit` (issue #612). A `taskkill` that finishes inside
 * the `exit` event ends the tree before the parent ends. The handler skips a child that exited,
 * a pid that is not a positive integer, and a run that settled, and it runs `taskkill` from the
 * `SystemRoot` directory only. A failure is logged and never thrown. A parent that a hard kill
 * ends runs no handler, so its tree can survive (ADR 0028).
 */
export function killTreeOnExit(subprocess) {
  const pid = subprocess?.pid;
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return subprocess;
  }
  liveRuns.add(subprocess);
  const release = () => liveRuns.delete(subprocess);
  subprocess.then(release, release);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on("exit", killLiveTrees);
  }
  return subprocess;
}
