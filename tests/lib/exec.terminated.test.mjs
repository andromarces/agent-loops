import { expect, test, vi } from "vite-plus/test";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { ExecError, exec } from "../../src/lib/exec.mjs";

// Usefulness: verifies a signal-killed command names the signal instead of
// "exited with code undefined" (issue #20 POSIX case). Runs with a mocked
// execa result because Windows cannot reach execa's signal-termination path.
// The signal name also travels as a field, so a caller that reports the cause does
// not have to parse it back out of the message.
test("exec terminated message contains signal description", async () => {
  execa.mockResolvedValue({
    exitCode: undefined,
    isTerminated: true,
    signalDescription: "Forced termination",
    stdout: "",
    stderr: "",
  });

  try {
    await exec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    expect.unreachable("should have thrown ExecError");
  } catch (err) {
    expect(err).toBeInstanceOf(ExecError);
    expect(err.isTerminated).toBe(true);
    expect(err.signal).toBe("Forced termination");
    expect(err.message).toContain("killed");
    expect(err.message).not.toContain("undefined");
  }
});
