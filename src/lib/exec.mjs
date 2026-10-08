import { execa } from "execa";
import { logDebug, logInfo } from "./log.mjs";
import { cwdHash } from "./runstate.mjs";

/**
 * Environment variable that marks a process spawned for a worker or reviewer turn. Its value is
 * a comma-separated list of run keys, the names of state directories: the keys of every enclosing
 * run, outermost first, then the key of the run that dispatched the turn. `role extend`, `finish`,
 * and `abort` refuse a caller whose list holds the key they use to find the run state, so a
 * descendant of a run never ends or extends it, while a parent that inherited the marker of
 * another run is not refused. Every descendant of the spawned process inherits it (issues #392,
 * #548). An empty value counts as unset.
 */
export const SPAWNED_RUN_ENV = "AGENT_LOOP_SPAWNED_RUN";

/** Appends `key` to the marker list that this process inherited, once. */
function markerFor(key) {
  const keys = (process.env[SPAWNED_RUN_ENV] ?? "").split(",").filter(Boolean);
  return (keys.includes(key) ? keys : [...keys, key]).join(",");
}

/** True when the inherited marker list holds `key`. */
export function isSpawnedByRun(key) {
  return (process.env[SPAWNED_RUN_ENV] ?? "").split(",").includes(key);
}

// `exec` adds no marker for the orchestrator or any other spawn. A process keeps a marker it
// inherited.
const MARKED_ROLES = new Set(["worker", "reviewer"]);

export class ExecError extends Error {
  constructor(
    message,
    { command, exitCode, stdout, stderr, timedOut, isCanceled, isTerminated, signal } = {},
  ) {
    super(message);
    this.name = "ExecError";
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout ?? "";
    this.stderr = stderr ?? "";
    this.timedOut = Boolean(timedOut);
    this.isCanceled = Boolean(isCanceled);
    this.isTerminated = Boolean(isTerminated);
    // The signal name or description, for a caller that reports the termination cause. It travels as
    // a field, not in the message, so every adapter keeps the message `exec` has always built.
    this.signal = signal ?? null;
  }
}

export async function exec(command, args = [], options = {}) {
  const { cwd, input, timeout, signal, role, env, maxBuffer } = options;

  const label = role ? `${role}: ${command}` : command;
  const startedAt = Date.now();
  logInfo(`${label} started`);

  const execaOptions = {
    cwd,
    reject: false,
    input,
    stdin: input === undefined ? "ignore" : undefined,
    killDescendants: true,
  };

  // Characters of decoded text per output stream. Unset keeps the execa default.
  if (maxBuffer !== undefined) {
    execaOptions.maxBuffer = maxBuffer;
  }

  // execa merges env with process.env; the child still inherits the launcher environment.
  const marked = MARKED_ROLES.has(role);
  if (env || marked) {
    execaOptions.env = {
      ...env,
      ...(marked && { [SPAWNED_RUN_ENV]: markerFor(cwdHash(cwd ?? process.cwd())) }),
    };
  }

  if (typeof timeout === "number" && timeout > 0) {
    execaOptions.timeout = timeout * 1000;
  }

  if (signal) {
    execaOptions.cancelSignal = signal;
  }

  const result = await execa(command, args, execaOptions);

  const timedOut = Boolean(result.timedOut);
  const isCanceled = Boolean(result.isCanceled);
  const isTerminated = Boolean(result.isTerminated);
  // execa can report an overflow with exit code 0 and a cut stream.
  const isMaxBuffer = Boolean(result.isMaxBuffer);

  if (result.exitCode !== 0 || timedOut || isCanceled || isTerminated || isMaxBuffer) {
    const signal = result.signalDescription ?? result.signal;
    let cause;
    if (timedOut) {
      cause = `${command} timed out after ${timeout} seconds.`;
    } else if (isCanceled) {
      cause = `${command} was canceled.`;
    } else if (isMaxBuffer) {
      cause = `${command} output exceeded the buffer limit and was cut.`;
    } else if (isTerminated) {
      // POSIX-only: execa cannot detect signal termination on Windows.
      cause = `${command} was killed by ${signal ?? "a signal"}.`;
    } else if (result.exitCode === undefined) {
      // POSIX-only: execa leaves exitCode undefined when the subprocess
      // could not be spawned (Windows reports exit code 1 instead).
      cause = `${command} failed to start.`;
    } else {
      cause = `${command} exited with code ${result.exitCode}.`;
    }

    const message = [cause, result.stderr?.trim(), result.stdout?.trim()]
      .filter(Boolean)
      .join("\n\n");

    // The caller owns the failure level (it knows whether the runtime recovers); this
    // debug line terminates the invocation trace when the caller does not log one.
    logDebug(`${label} failed in ${Date.now() - startedAt}ms: ${cause}`);

    throw new ExecError(message, {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut,
      isCanceled,
      isTerminated,
      signal,
    });
  }

  const durationMs = Date.now() - startedAt;
  logInfo(`${label} finished in ${durationMs}ms (exit 0)`);

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
  };
}
