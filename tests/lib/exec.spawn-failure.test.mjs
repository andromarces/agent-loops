import { expect, test, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { ExecError, exec } from "../../src/lib/exec.mjs";

// Usefulness: verifies a command that could not be spawned names the cause
// instead of "exited with code undefined" (issue #40 POSIX case). Runs with a
// mocked execa result because a Windows spawn failure reports exitCode 1.
test("exec spawn failure message contains failed to start", async () => {
  execa.mockResolvedValue({
    exitCode: undefined,
    isTerminated: false,
    signalDescription: undefined,
    stdout: "",
    stderr: "",
  });

  try {
    await exec("definitely-not-a-command", []);
    expect.unreachable("should have thrown ExecError");
  } catch (err) {
    expect(err).toBeInstanceOf(ExecError);
    expect(err.message).toContain("failed to start");
    expect(err.message).not.toContain("undefined");
  }
});
