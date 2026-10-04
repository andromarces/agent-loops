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

/**
 * Kills the command and every descendant. A process group signal misses a
 * descendant that started its own group, so on POSIX the tree is read from the
 * process table, stopped with SIGSTOP so it cannot start more children, read
 * again until no new process appears, then killed with SIGKILL. On Windows execa
 * runs `taskkill /T /F`, which walks the parent links. known-limit: a descendant
 * whose parent exited before the kill has no parent link left, and neither
 * platform finds it.
 */
async function killTree(subprocess) {
  if (subprocess.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    subprocess.kill();
    return;
  }
  const known = new Set([subprocess.pid]);
  for (let round = 0; round < MAX_KILL_ROUNDS; round++) {
    const fresh = (await listDescendants(subprocess.pid)).filter((pid) => !known.has(pid));
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
  // The group signal covers a process the table read missed.
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
 * not a mutation by the reviewer. A snapshot failure and a cancel throw; every
 * other failure of the command is a result.
 * @param {{ command: string, timeoutSeconds?: number, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<object>} the advisory result: `status` is `pass`, `fail`, `timed-out`, or `error`
 */
export async function runTestCmd({
  command,
  timeoutSeconds = DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
  cwd,
  signal,
}) {
  const before = await snapshot(cwd);
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
  });
  // The runtime owns the bound and the cancel, so both reach the whole tree.
  let timedOut = false;
  let canceled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(subprocess);
  }, timeoutSeconds * 1000);
  const onAbort = () => {
    canceled = true;
    void killTree(subprocess);
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
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const durationMs = Date.now() - startedAt;

  if (canceled) {
    const err = new Error("test command canceled");
    err.isCanceled = true;
    throw err;
  }

  const after = await snapshot(cwd);
  const changed = diffSnapshots(before, after);

  const text = stripControl(
    redactEnvSecrets(window.subarray(-CAPTURE_WINDOW_BYTES).toString("utf8")),
  );
  const truncated = total > CAPTURE_WINDOW_BYTES || text.length > TAIL_CHARS;
  const tail = text.slice(-TAIL_CHARS);

  const exitCode = !timedOut && typeof result.exitCode === "number" ? result.exitCode : null;
  let status;
  let summary;
  if (timedOut) {
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

  return {
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
}
