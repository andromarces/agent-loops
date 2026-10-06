import { isAbsolute } from "node:path";
import { expect, test, vi } from "vite-plus/test";

// The launcher runs `copilot`, which is not installed in the test environment. The stand-in runs a
// real child with the same arguments, so execa builds its real failure message from the real command
// line: `node` exits 3, and a missing binary fails to spawn (ENOENT).
const standIn = vi.hoisted(() => ({ binary: "node" }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (_command, args, options) =>
      standIn.binary === "node"
        ? real.execa("node", ["-e", "process.exit(3)", "--", ...args], options)
        : real.execa(standIn.binary, args, options),
  };
});

import { buildCopilotInvocation, main, reportFailure } from "../../src/entrypoints/copilot.mjs";

// Usefulness: verifies the Copilot launcher carries one session id into both
// the CLI session and the first prompt's --parent-session instruction, grants
// Copilot access to the shipped instructions directory with --add-dir, and
// names that file by absolute path, so the prompt resolves from any working
// directory, not only from a clone of this repository.
test("Copilot launcher seeds the interactive parent prompt with its session id", () => {
  const sessionId = "parent-session-1";
  const invocation = buildCopilotInvocation("Implement the change.", sessionId);

  expect(invocation.command).toBe("copilot");
  expect(invocation.args.slice(0, 2)).toEqual(["--session-id", sessionId]);

  const addDirIndex = invocation.args.indexOf("--add-dir");
  expect(addDirIndex).toBeGreaterThan(-1);
  const instructionsDir = invocation.args[addDirIndex + 1];
  expect(isAbsolute(instructionsDir)).toBe(true);
  expect(invocation.args[addDirIndex + 2]).toBe("--interactive");

  const prompt = invocation.args[addDirIndex + 3];
  expect(prompt).toContain(sessionId);
  expect(prompt).toContain("Implement the change.");

  const instructionPath = prompt.match(/`([^`]*orchestrator-instructions\.md)`/)?.[1];
  expect(instructionPath).toBeDefined();
  expect(isAbsolute(instructionPath)).toBe(true);
  expect(instructionPath.startsWith(instructionsDir)).toBe(true);
});

// Usefulness: verifies the launcher passes no line breaks, because execa
// rejects CR or LF in an argument on Windows when it spawns the copilot .cmd
// shim through cmd.exe. The task itself may carry a newline.
test("Copilot launcher passes no line breaks in its arguments", () => {
  const invocation = buildCopilotInvocation("Line one.\nLine two.\r\nLine three.", "session-1");

  for (const arg of invocation.args) {
    expect(arg).not.toMatch(/[\r\n]/);
  }
  expect(invocation.args.at(-1)).toContain("Line one. Line two. Line three.");
});

// Usefulness: verifies the launcher failure report is built from the exit code, the signal, and the
// error code, never from the execa command line, so a secret-named environment value in the task
// cannot reach it in any quoting, here a value with an apostrophe, a quote, and a backslash that
// execa shell-quotes (issue #431, ADR 0017). A missing binary reports the error code ENOENT on
// POSIX and exit code 1 on Windows, where execa runs it through cmd.exe (Windows CI, 2026-10-05).
test.each([
  ["a non-zero exit", "node", /\(exit code 3\)/],
  [
    "a missing binary",
    "agent-loop-missing-copilot-binary",
    process.platform === "win32" ? /\(exit code 1\)/ : /\(error code ENOENT\)/,
  ],
])("Copilot launcher failure report for %s echoes no argument", async (_name, binary, expected) => {
  const synthetic = "synth'etic\"probe\\value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  standIn.binary = binary;
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await main([`Implement it with --test-cmd "run ${synthetic}"`]).catch(reportFailure);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toMatch(/^agent-loop-copilot: copilot failed/);
    expect(report).toMatch(expected);
    expect(report).not.toContain("8f3a1c");
    expect(report).not.toContain("--test-cmd");
    expect(process.exitCode).toBe(1);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    standIn.binary = "node";
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a launcher error that the launcher authored still goes through the shared
// redaction, so a value that reaches its text prints as `[redacted:NAME]` (issue #431, ADR 0017).
test("Copilot launcher failure report redacts a secret value in its own message", () => {
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    reportFailure(new Error(`bad input ${synthetic}`));
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(report).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: acceptance (#490) — a launcher failure that is `null` or has a throwing `message`
// getter still prints one line and sets the exit code, and an ordinary Error keeps its message.
test.each([
  ["null", null, "null"],
  [
    "a throwing message getter",
    {
      get message() {
        throw new Error("getter");
      },
    },
    "unserializable",
  ],
  ["an ordinary Error", new Error("plain failure"), "plain failure"],
])("Copilot launcher failure report survives %s", (_name, thrown, expected) => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => reportFailure(thrown)).not.toThrow();
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain(expected);
    expect(process.exitCode).toBe(1);
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: acceptance (#523) — a throwing `shortMessage`, `exitCode`, `signal`, or `code` getter
// never escapes the report, and an execa error still prints its exit code, signal, and error code.
test.each(["shortMessage", "exitCode", "signal", "code"])(
  "Copilot launcher failure report survives a throwing %s getter",
  (key) => {
    const thrown = {
      shortMessage: "Command failed",
      exitCode: 2,
      signal: "SIGTERM",
      code: "ENOENT",
      message: "full command line",
    };
    Object.defineProperty(thrown, key, {
      get() {
        throw new Error("getter");
      },
    });
    const origExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => reportFailure(thrown)).not.toThrow();
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = origExitCode;
    }
  },
);

// Usefulness: acceptance (#523) — an ordinary execa error keeps its exit code, signal, and error code text.
test("Copilot launcher failure report prints exit code, signal, and error code of an execa error", () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    reportFailure({ shortMessage: "Command failed", exitCode: 2, signal: "SIGTERM", code: "EX" });
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("copilot failed (exit code 2, signal SIGTERM, error code EX)");
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: ADR 0017 — an execa-like failure whose `shortMessage` getter throws still prints the
// fixed report, so the command arguments in `message`, `command`, and `escapedCommand` never reach the output.
test("Copilot launcher failure report keeps command arguments out when shortMessage is unreadable", () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const thrown = {
    message: "Command failed: copilot --secret-arg 'task words'",
    command: "copilot --secret-arg 'task words'",
    escapedCommand: "copilot --secret-arg 'task words'",
    exitCode: 2,
    get shortMessage() {
      throw new Error("getter");
    },
  };
  try {
    reportFailure(thrown);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("copilot failed (exit code 2)");
    expect(report).not.toContain("secret-arg");
    expect(report).not.toContain("task words");
    expect(process.exitCode).toBe(1);
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: acceptance (#523) — a thrown value whose field cannot convert to text (a Symbol
// `exitCode`, a throwing `toString`) still prints the fixed report instead of throwing.
test("Copilot launcher failure report survives a field value that cannot convert to text", () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const fields = {
    shortMessage: "Command failed",
    exitCode: Symbol("boom"),
    signal: {
      toString() {
        throw new Error("toString");
      },
    },
    code: "EX",
  };
  const thrown = new Proxy({}, { get: (_target, key) => fields[key] });
  try {
    expect(() => reportFailure(thrown)).not.toThrow();
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("copilot failed (exit code [unprintable]");
    expect(report).toContain("error code EX");
    expect(process.exitCode).toBe(1);
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: ADR 0017 — an object, array, or function in `exitCode`, `signal`, or `code` can hold
// argv, so only a number or a string prints and any other type prints a fixed placeholder.
test("Copilot launcher failure report keeps command arguments out of object-valued fields", () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const thrown = {
    shortMessage: "Command failed",
    exitCode: { argv: ["copilot", "--secret-arg"] },
    signal: ["copilot", "task words"],
    code: Object.assign(() => {}, { command: "copilot --secret-arg" }),
  };
  try {
    reportFailure(thrown);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("exit code [unprintable]");
    expect(report).not.toContain("secret-arg");
    expect(report).not.toContain("task words");
    expect(process.exitCode).toBe(1);
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: ADR 0017 — a thrown object with no readable string message never has its content
// serialized into the report, because that content can hold command arguments.
test("Copilot launcher failure report never serializes a thrown object without a message", () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    reportFailure({ exitCode: { argv: ["copilot", "ARGUMENT_CANARY"] } });
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("agent-loop-copilot:");
    expect(report).not.toContain("ARGUMENT_CANARY");
    expect(process.exitCode).toBe(1);
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});
