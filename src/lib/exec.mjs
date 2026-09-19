import { execa } from "execa";
import { logDebug, logInfo } from "./log.mjs";

export class ExecError extends Error {
  constructor(
    message,
    { command, exitCode, stdout, stderr, timedOut, isCanceled, isTerminated } = {},
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
  }
}

export async function exec(command, args = [], options = {}) {
  const { cwd, input, timeout, signal, role, env } = options;

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

  // execa merges env with process.env; the child still inherits the launcher environment.
  if (env) {
    execaOptions.env = env;
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

  if (result.exitCode !== 0 || timedOut || isCanceled || isTerminated) {
    let cause;
    if (timedOut) {
      cause = `${command} timed out after ${timeout} seconds.`;
    } else if (isCanceled) {
      cause = `${command} was canceled.`;
    } else if (isTerminated) {
      // POSIX-only: execa cannot detect signal termination on Windows.
      const description = result.signalDescription ?? result.signal ?? "a signal";
      cause = `${command} was killed by ${description}.`;
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
