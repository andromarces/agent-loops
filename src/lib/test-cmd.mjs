import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { logInfo } from "./log.mjs";
import { diffSnapshots, snapshot } from "./snapshot.mjs";

// ADR 0017. The command is the operator's `--test-cmd`, run by the runtime in
// the run's work tree before each reviewer turn, outside every CLI sandbox.
export const DEFAULT_TEST_CMD_TIMEOUT_SECONDS = 600;
// A kill walks the process table at most this many times to catch children that a
// descendant started while the tree was being stopped.
const MAX_KILL_ROUNDS = 5;
// Bytes kept while the command runs: twice the tail the reviewer sees, so a
// secret cut at the left edge of the window never reaches the final tail.
const CAPTURE_WINDOW_BYTES = 16 * 1024;
export const TAIL_CHARS = 8 * 1024;
const MAX_CHANGED_PATHS = 20;
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;

/**
 * Replaces every occurrence of the value of a secret-named environment variable
 * with `[redacted:NAME]`. Exact-value match only: a secret that the command
 * derives, encodes, or reads from a file is not found.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      out = out.split(value).join(`[redacted:${name}]`);
    }
  }
  return out;
}

// Control characters other than newline and tab never help a reviewer and can
// hide text in a terminal, so they are dropped.
function stripControl(text) {
  return [...text.replaceAll("\r\n", "\n")]
    .filter((c) => c === "\n" || c === "\t" || c >= " ")
    .join("");
}

// Every descendant of `rootPid`, from one read of the process table. POSIX only.
async function listDescendants(rootPid) {
  const table = await execa("ps", ["-A", "-o", "pid=,ppid="], { reject: false });
  const children = new Map();
  for (const line of String(table.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) ?? []) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

const signalPid = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    // The process already exited.
  }
};

// The command and every process it starts inherit this variable, so a process whose
// parent already exited, and which sits in a group of its own, is still found by it.
const TAG_VAR = "AGENT_LOOP_TEST_RUN";

// Every process that carries `tag` in its environment, except this one. POSIX only.
// Linux reads /proc. macOS has no /proc, so it reads the environment that `ps -E`
// prints, which the system hides for a platform binary that System Integrity
// Protection restricts, such as /bin/sh.
async function listTagged(tag) {
  const needle = `${TAG_VAR}=${tag}`;
  const found = [];
  if (process.platform === "linux") {
    for (const name of await readdir("/proc").catch(() => [])) {
      const pid = Number(name);
      if (Number.isInteger(pid) && pid !== process.pid) {
        const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
        if (environ.split("\0").includes(needle)) {
          found.push(pid);
        }
      }
    }
    return found;
  }
  const table = await execa("ps", ["-Eww", "-A", "-o", "pid=,command="], { reject: false });
  for (const line of String(table.stdout ?? "").split("\n")) {
    const pid = Number.parseInt(line, 10);
    if (Number.isInteger(pid) && pid !== process.pid && line.includes(needle)) {
      found.push(pid);
    }
  }
  return found;
}

/**
 * Kills the command and every descendant, an orphan included. A process group
 * signal misses a descendant that started its own group, and a walk of the parent
 * links misses one whose parent exited. On POSIX the runtime therefore takes the
 * union of the parent walk and the processes that carry the run tag in their
 * environment, stops them with SIGSTOP so they start no more children, repeats
 * until no new process appears, then sends SIGKILL to each and to the process group.
 * On Windows execa runs `taskkill /T /F`, which walks the parent links. Limits: on
 * Windows, and on macOS for a platform binary whose environment the system hides, an
 * orphan outside the process group of the command is not found, and neither Node nor
 * execa exposes a job object that would reach it. A process that clears its
 * environment and loses its parent is not found on any platform.
 */
async function killTree(subprocess, tag) {
  if (subprocess.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    subprocess.kill();
    return;
  }
  const known = new Set([subprocess.pid]);
  for (let round = 0; round < MAX_KILL_ROUNDS; round++) {
    const seen = [...(await listDescendants(subprocess.pid)), ...(await listTagged(tag))];
    const fresh = [...new Set(seen)].filter((pid) => !known.has(pid));
    for (const pid of fresh) {
      known.add(pid);
    }
    for (const pid of round === 0 ? known : fresh) {
      signalPid(pid, "SIGSTOP");
    }
    if (fresh.length === 0) {
      break;
    }
  }
  for (const pid of known) {
    signalPid(pid, "SIGKILL");
  }
  // The group signal covers a process the table reads missed.
  subprocess.kill("SIGKILL");
}

/**
 * Runs `command` through the platform shell (`/bin/sh -c` on POSIX, `cmd.exe`
 * on Windows) in `cwd`, so the command is written in the syntax of the shell
 * that runs it and the runtime adds no quoting. The command and its child
 * processes are killed when the bound expires, which reports `timed-out` with
 * `exitCode: null`, whatever code the killed command exited with.
 * Output is read as a rolling window, so a noisy command cannot exhaust memory.
 * The work tree is compared before and after the command; the caller takes its
 * reviewer snapshot after this returns, so the changes are reported here and are
 * not a mutation by the reviewer. A snapshot failure throws. A cancel kills the
 * tree, takes the same after snapshot, and throws an error with `isCanceled` and the
 * result, `status: "canceled"`, as `testRun`, so a write made before the cancel is
 * reported. Every other failure of the command is a result.
 * @param {{ command: string, timeoutSeconds?: number, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<object>} the advisory result: `status` is `pass`, `fail`, `timed-out`, `error`, or `canceled` (thrown)
 */
export async function runTestCmd({
  command,
  timeoutSeconds = DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
  cwd,
  signal,
}) {
  const before = await snapshot(cwd);
  const tag = randomUUID();
  const startedAt = Date.now();
  logInfo(`test command started (bound ${timeoutSeconds}s)`);

  const subprocess = execa(command, {
    cwd,
    shell: true,
    reject: false,
    stdin: "ignore",
    all: true,
    buffer: false,
    cleanup: true,
    killDescendants: true,
    env: { [TAG_VAR]: tag },
  });
  // The runtime owns the bound and the cancel, so both reach the whole tree.
  let timedOut = false;
  let canceled = false;
  let killing = null;
  const kill = () => {
    killing ??= killTree(subprocess, tag);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutSeconds * 1000);
  const onAbort = () => {
    canceled = true;
    kill();
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  let window = Buffer.alloc(0);
  let total = 0;
  subprocess.all.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    window = Buffer.concat([window, bytes]);
    if (window.length > CAPTURE_WINDOW_BYTES * 2) {
      window = window.subarray(window.length - CAPTURE_WINDOW_BYTES);
    }
  });
  let result;
  try {
    result = await subprocess;
    // The kill outlives the command it stopped, so the result waits for the sweep.
    await killing;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const durationMs = Date.now() - startedAt;

  const after = await snapshot(cwd);
  const changed = diffSnapshots(before, after);

  const text = stripControl(
    redactEnvSecrets(window.subarray(-CAPTURE_WINDOW_BYTES).toString("utf8")),
  );
  const truncated = total > CAPTURE_WINDOW_BYTES || text.length > TAIL_CHARS;
  const tail = text.slice(-TAIL_CHARS);

  const exitCode =
    !timedOut && !canceled && typeof result.exitCode === "number" ? result.exitCode : null;
  let status;
  let summary;
  if (canceled) {
    status = "canceled";
    summary = "canceled before the command finished; the command and its descendants were killed";
  } else if (timedOut) {
    status = "timed-out";
    summary = `timed out after ${timeoutSeconds} seconds; the command and its child processes were killed; this is neither a pass nor a failure`;
  } else if (exitCode === null) {
    status = "error";
    summary = `did not run to an exit code${result.signal ? ` (signal ${result.signal})` : ""}`;
  } else {
    status = exitCode === 0 ? "pass" : "fail";
    summary = `exit ${exitCode}`;
  }
  logInfo(`test command finished in ${durationMs}ms: ${status}`);

  const testRun = {
    command: stripControl(redactEnvSecrets(command)),
    status,
    exitCode,
    timedOut,
    durationMs,
    summary,
    outputBytes: total,
    truncated,
    tail,
    workTreeChanged: changed.length > 0,
    changedPaths: changed.slice(0, MAX_CHANGED_PATHS),
    changedCount: changed.length,
    advisory: true,
  };
  if (canceled) {
    const err = new Error("test command canceled");
    err.isCanceled = true;
    err.testRun = testRun;
    throw err;
  }
  return testRun;
}
