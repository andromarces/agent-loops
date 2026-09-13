import { expect, test, vi } from "vitest";
import { execa } from "execa";

vi.mock("execa", () => ({ execa: vi.fn() }));

function mockKind(kind, replies, onInput) {
  return async (command, args, options) => {
    const index = onInput.calls++;
    expect(command).toBe(kind);
    expect(options.stdin).toBeUndefined();
    expect(args).not.toContain(options.input);
    onInput.handler(index, options.input, args);
    const sessionId = index % 2 === 0 ? "worker-session" : "review-session";
    let stdout = replies[index];
    if (kind === "codex") {
      stdout = [
        { type: "thread.started", thread_id: sessionId },
        { type: "item.completed", item: { type: "agent_message", text: stdout } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
    } else if (kind === "opencode") {
      stdout = JSON.stringify({ type: "text", sessionID: sessionId, part: { text: stdout } });
    }
    return { exitCode: 0, stdout, stderr: "" };
  };
}

// Usefulness: verifies the issue-#3 requirement that the worker acts first, reviewer verifies, and REVIEW_COMPLETE triggers a final worker summary. No other test covers the worker-first order, so coverage is nonredundant.
test.each(["codex", "opencode", "copilot"])(
  "%s runs worker first and returns a final summary on REVIEW_COMPLETE",
  async (kind) => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const task =
      'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
    const workerResult = "First implementation.\nDid the work.";
    const summary =
      "Changed: all.\nVerified: tests.\nDeferred: none.\nNot done: none.\nOpen: none.";
    const replies = [workerResult, "REVIEW_COMPLETE", summary];
    const inputs = [];
    const seenArgs = [];
    const tracker = {
      calls: 0,
      handler(index, input, args) {
        inputs.push(input);
        seenArgs.push(args);
      },
    };

    vi.mocked(execa)
      .mockReset()
      .mockImplementation(mockKind(kind, replies, tracker));

    try {
      process.argv = [
        process.execPath,
        "src/cli.mjs",
        "--reviewer",
        kind,
        "--worker",
        kind,
        "--task",
        task,
        "--max-reviews",
        "3",
      ];
      vi.resetModules();
      await import("../src/cli.mjs");
      await vi.waitFor(
        () => {
          expect(log).toHaveBeenCalledWith(expect.stringContaining(summary));
        },
        { timeout: 10000 },
      );

      expect(error).not.toHaveBeenCalled();
      expect(execa).toHaveBeenCalledTimes(3);
      expect(inputs[0]).toContain(task);
      expect(inputs[0]).toContain("You are the implementation agent");
      expect(inputs[1]).toContain(task);
      expect(inputs[1]).toContain(workerResult);
      expect(inputs[1]).toContain("From the Worker:");
      expect(inputs[2]).toBe("From the Reviewer:\nREVIEW_COMPLETE");
      const calls = vi.mocked(execa).mock.calls;
      const sessions =
        kind === "copilot"
          ? [calls[0][1][1], calls[1][1][1], calls[2][1][1]]
          : ["worker-session", "review-session", "worker-session"];
      expect(sessions[0]).toEqual(expect.any(String));
      expect(sessions[0]).not.toBe(sessions[1]);
      expect(sessions[0]).toBe(sessions[2]);
      for (const [index, [, args]] of calls.entries()) {
        const sessionId = sessions[index];
        if (kind === "codex") {
          expect(args).toEqual(
            index < 2 ? ["exec", "--json"] : ["exec", "resume", sessionId, "--json", "-"],
          );
        } else if (kind === "opencode") {
          expect(args).toEqual(
            index < 2
              ? ["run", "--format", "json"]
              : ["run", "--format", "json", "--session", sessionId],
          );
        } else {
          expect(args).toEqual(["--session-id", sessionId, "-s", "--no-ask-user"]);
        }
      }
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
    }
  },
  15000,
);

// Usefulness: verifies the issue-#3 requirement that later turns reuse the exact From the Reviewer and From the Worker templates. No other test covers multi-iteration prompts, so coverage is nonredundant.
test("later worker and reviewer turns use the exact follow-up templates", async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const task = "Do the thing.";
  const findings = "Blocking: fix null check.";
  const fix = "Fixed null check and ran tests.";
  const summary =
    "Changed: null check.\nVerified: tests.\nDeferred: none.\nNot done: none.\nOpen: none.";
  const replies = ["Initial work.", findings, fix, "REVIEW_COMPLETE", summary];
  const inputs = [];
  const tracker = {
    calls: 0,
    handler(index, input) {
      inputs.push(input);
    },
  };

  vi.mocked(execa)
    .mockReset()
    .mockImplementation(mockKind("copilot", replies, tracker));

  try {
    process.argv = [
      process.execPath,
      "src/cli.mjs",
      "--reviewer",
      "copilot",
      "--worker",
      "copilot",
      "--task",
      task,
      "--max-reviews",
      "3",
    ];
    vi.resetModules();
    await import("../src/cli.mjs");
    await vi.waitFor(
      () => {
        expect(log).toHaveBeenCalledWith(expect.stringContaining(summary));
      },
      { timeout: 10000 },
    );

    expect(error).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledTimes(5);
    expect(inputs[2]).toBe(`From the Reviewer:\n${findings}`);
    expect(inputs[3]).toContain("Do not implement, fix, edit, or change anything yet.");
    expect(inputs[3]).toContain(`From the Worker:\n${fix}`);
    expect(inputs[4]).toBe("From the Reviewer:\nREVIEW_COMPLETE");
    expect(process.exitCode).toBe(originalExitCode);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  }
});

// Usefulness: verifies the issue-#3 requirement that REVIEW_COMPLETE counts only as an exact whole response. No other test covers the strict equality rule, so coverage is nonredundant.
test("findings followed by REVIEW_COMPLETE do not stop the loop", async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const replies = ["Did the work.", "Still broken.\nREVIEW_COMPLETE"];
  const tracker = { calls: 0, handler() {} };

  vi.mocked(execa)
    .mockReset()
    .mockImplementation(mockKind("copilot", replies, tracker));

  try {
    process.argv = [
      process.execPath,
      "src/cli.mjs",
      "--reviewer",
      "copilot",
      "--worker",
      "copilot",
      "--task",
      "Do the thing.",
      "--max-reviews",
      "1",
    ];
    vi.resetModules();
    await import("../src/cli.mjs");
    await vi.waitFor(
      () => {
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Stopped after 1 reviews"));
      },
      { timeout: 10000 },
    );

    expect(execa).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("IMPLEMENTATION 0"));
    expect(process.exitCode).toBe(2);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  }
});

// Usefulness: verifies the issue-#3 requirement that --task is required. No other test covers the missing task failure, so coverage is nonredundant.
test("missing --task fails fast with a clear message", async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  vi.mocked(execa).mockReset();

  try {
    process.argv = [
      process.execPath,
      "src/cli.mjs",
      "--reviewer",
      "copilot",
      "--worker",
      "copilot",
    ];
    vi.resetModules();
    await import("../src/cli.mjs");
    await vi.waitFor(
      () => {
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--task"));
      },
      { timeout: 10000 },
    );

    expect(execa).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  }
});
