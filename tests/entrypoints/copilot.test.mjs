import { isAbsolute } from "node:path";
import { expect, test, vi } from "vitest";

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
// execa shell-quotes (issue #431, ADR 0017).
test.each([
  ["a non-zero exit", "node", "exit code 3"],
  ["a missing binary", "agent-loop-missing-copilot-binary", "ENOENT"],
])("Copilot launcher failure report for %s echoes no argument", async (_name, binary, expected) => {
  const synthetic = "synth'etic\"probe\\value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  standIn.binary = binary;
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await main([`Implement it with --test-cmd "run ${synthetic}"`]).catch(reportFailure);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("agent-loop-copilot:");
    expect(report).toContain(expected);
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
