import { execa } from "execa";

export class ExecError extends Error {
  constructor(message, { command, exitCode, stdout, stderr, timedOut, isCanceled } = {}) {
    super(message);
    this.name = "ExecError";
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout ?? "";
    this.stderr = stderr ?? "";
    this.timedOut = Boolean(timedOut);
    this.isCanceled = Boolean(isCanceled);
  }
}

export async function exec(command, args = [], options = {}) {
  const { cwd, input, timeout, signal } = options;

  const execaOptions = {
    cwd,
    reject: false,
    input,
    stdin: input === undefined ? "ignore" : undefined,
    killDescendants: true,
  };

  if (typeof timeout === "number" && timeout > 0) {
    execaOptions.timeout = timeout * 1000;
  }

  if (signal) {
    execaOptions.cancelSignal = signal;
  }

  const result = await execa(command, args, execaOptions);

  const timedOut = Boolean(result.timedOut);
  const isCanceled = Boolean(result.isCanceled);

  if (result.exitCode !== 0 || timedOut || isCanceled) {
    const message = [
      `${command} exited with code ${result.exitCode}.`,
      result.stderr?.trim(),
      result.stdout?.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");

    throw new ExecError(message, {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut,
      isCanceled,
    });
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
