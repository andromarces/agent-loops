import { spawnSync } from "node:child_process";
import { join } from "node:path";

const liveTrees = new Set();
let exitHandlerInstalled = false;

function killLiveTrees() {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:/Windows";
  for (const pid of liveTrees) {
    spawnSync(join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
}

/**
 * Ends the process tree of `subprocess` when this process exits while the subprocess is live.
 * Returns `subprocess`. Only Windows needs it: execa `cleanup` starts `taskkill` without waiting,
 * and `taskkill /T` cannot find the descendants of a process that already exited, so a tree
 * outlived a parent that called `process.exit` (issue #612). A synchronous `taskkill` in the
 * `exit` event finishes before the parent ends. A parent that a hard kill ends runs no handler,
 * so its tree can survive (ADR 0028).
 */
export function killTreeOnExit(subprocess) {
  const pid = subprocess?.pid;
  if (process.platform !== "win32" || typeof pid !== "number") {
    return subprocess;
  }
  liveTrees.add(pid);
  // The pid leaves the set when the run settles, so a reused pid is never killed.
  const release = () => liveTrees.delete(pid);
  subprocess.then(release, release);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on("exit", killLiveTrees);
  }
  return subprocess;
}
