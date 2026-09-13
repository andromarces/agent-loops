import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { execa } from "execa";

vi.mock("execa", () => ({ execa: vi.fn() }));

// Usefulness: verifies the issue-#7 requirement that claude sends multi-line prompts on stdin with newline-free argv and still accepts the array envelope and the legacy object shape across initial and resume turns. No other test exercises the Claude stdin plus parse boundary, so coverage is nonredundant.
test("claude handles array and object envelopes and resumes sessions", async () => {
  const actual = await vi.importActual("execa");
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const task =
    'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
  const replies = [
    "First finding.\nFix it.",
    "First fix.\nCheck it.",
    "Second finding.\nFix it too.",
    "Second fix.\nCheck again.",
    "No findings.\nREVIEW_COMPLETE",
  ];
  let callNumber = 0;

  vi.mocked(execa)
    .mockReset()
    .mockImplementation(async (command, args, options) => {
      const index = callNumber++;
      expect(command).toBe("claude");
      expect(options.cwd).toBe(process.cwd());
      expect(options.input).toContain(index === 0 ? task : replies[index - 1]);
      expect(options.stdin).toBeUndefined();
      expect(args).not.toContain(options.input);
      for (const arg of args) {
        expect(arg).not.toMatch(/[\r\n]/);
      }

      const echoed = await actual.execa(
        process.execPath,
        ["-e", "process.stdin.pipe(process.stdout)"],
        { ...options, stripFinalNewline: false },
      );
      expect(echoed.exitCode).toBe(0);
      expect(echoed.stdout).toBe(options.input);

      const sessionId = index % 2 === 0 ? "review-session" : "worker-session";
      if (index >= 2) {
        expect(args).toContain("--resume");
        expect(args).toContain(sessionId);
      }
      const stdout =
        index % 2 === 0
          ? JSON.stringify([
              { type: "system", subtype: "init", session_id: sessionId },
              { type: "result", subtype: "success", session_id: sessionId, result: replies[index] },
            ])
          : JSON.stringify({ session_id: sessionId, result: replies[index] });
      return { exitCode: 0, stdout, stderr: "" };
    });

  try {
    process.argv = [
      process.execPath,
      "src/cli.mjs",
      "--reviewer",
      "claude",
      "--worker",
      "claude",
      "--task",
      task,
      "--max-reviews",
      "3",
    ];
    vi.resetModules();
    await import("../src/cli.mjs");
    await vi.waitFor(
      () => {
        expect(error).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith("\nReview loop complete.");
      },
      { timeout: 10000 },
    );

    expect(execa).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(execa).mock.calls;
    expect(calls[2][1]).toContain("review-session");
    expect(calls[3][1]).toContain("worker-session");
    for (const [index, [, args]] of calls.entries()) {
      const sessionId = index % 2 === 0 ? "review-session" : "worker-session";
      expect(args).toEqual(
        index < 2
          ? ["-p", "--output-format", "json"]
          : ["-p", "--resume", sessionId, "--output-format", "json"],
      );
    }
    expect(process.exitCode).toBe(originalExitCode);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  }
});

// Usefulness: verifies the issue-#7 requirement that agy sends multi-line prompts on stdin with newline-free argv through --input-format text and resumes by conversation id. No other test exercises the agy spawn boundary, so coverage is nonredundant.
test("agy preserves multiline stdin and resumes reviewer and worker sessions", async () => {
  const actual = await vi.importActual("execa");
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const task =
    'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
  const replies = [
    "First finding.\nFix it.",
    "First fix.\nCheck it.",
    "Second finding.\nFix it too.",
    "Second fix.\nCheck again.",
    "No findings.\nREVIEW_COMPLETE",
  ];
  let callNumber = 0;

  vi.mocked(execa)
    .mockReset()
    .mockImplementation(async (command, args, options) => {
      const index = callNumber++;
      expect(command).toBe("agy");
      expect(options.cwd).toBe(process.cwd());
      expect(options.input).toContain(index === 0 ? task : replies[index - 1]);
      expect(options.stdin).toBeUndefined();
      expect(args).not.toContain(options.input);
      for (const arg of args) {
        expect(arg).not.toMatch(/[\r\n]/);
      }

      const echoed = await actual.execa(
        process.execPath,
        ["-e", "process.stdin.pipe(process.stdout)"],
        { ...options, stripFinalNewline: false },
      );
      expect(echoed.exitCode).toBe(0);
      expect(echoed.stdout).toBe(options.input);

      const sessionId = index % 2 === 0 ? "review-session" : "worker-session";
      if (index >= 2) {
        expect(args).toContain("--conversation");
        expect(args).toContain(sessionId);
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ conversation_id: sessionId, response: replies[index] }),
        stderr: "",
      };
    });

  try {
    process.argv = [
      process.execPath,
      "src/cli.mjs",
      "--reviewer",
      "agy",
      "--worker",
      "agy",
      "--task",
      task,
      "--max-reviews",
      "3",
    ];
    vi.resetModules();
    await import("../src/cli.mjs");
    await vi.waitFor(
      () => {
        expect(error).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith("\nReview loop complete.");
      },
      { timeout: 10000 },
    );

    expect(execa).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(execa).mock.calls;
    for (const [index, [, args]] of calls.entries()) {
      const sessionId = index % 2 === 0 ? "review-session" : "worker-session";
      expect(args).toEqual(
        index < 2
          ? ["--input-format", "text", "--output-format", "json"]
          : ["--input-format", "text", "--output-format", "json", "--conversation", sessionId],
      );
    }
    expect(process.exitCode).toBe(originalExitCode);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  }
});

// Usefulness: verifies the issue-#2 requirement that multi-line prompts travel on stdin with newline-free argv for codex, opencode, and copilot across initial and resume turns. No other test exercises the execa spawn boundary, so coverage is nonredundant.
test.each(["codex", "opencode", "copilot"])(
  "%s preserves multiline stdin and resumes reviewer and worker sessions",
  async (kind) => {
    const actual = await vi.importActual("execa");
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const task =
      'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
    const replies = [
      "First finding.\nFix it.",
      "First fix.\nCheck it.",
      "Second finding.\nFix it too.",
      "Second fix.\nCheck again.",
      "No findings.\nREVIEW_COMPLETE",
    ];
    let callNumber = 0;

    vi.mocked(execa)
      .mockReset()
      .mockImplementation(async (command, args, options) => {
        const index = callNumber++;
        expect(command).toBe(kind);
        expect(options.cwd).toBe(process.cwd());
        expect(options.input).toContain(index === 0 ? task : replies[index - 1]);
        expect(options.stdin).toBeUndefined();
        expect(args).not.toContain(options.input);

        const echoed = await actual.execa(
          process.execPath,
          ["-e", "process.stdin.pipe(process.stdout)"],
          { ...options, stripFinalNewline: false },
        );
        expect(echoed.exitCode).toBe(0);
        expect(echoed.stdout).toBe(options.input);

        const sessionId = index % 2 === 0 ? "review-session" : "worker-session";
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
      });

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
          expect(error).not.toHaveBeenCalled();
          expect(log).toHaveBeenCalledWith("\nReview loop complete.");
        },
        { timeout: 10000 },
      );

      expect(execa).toHaveBeenCalledTimes(5);
      const calls = vi.mocked(execa).mock.calls;
      const sessions =
        kind === "copilot"
          ? calls.slice(0, 2).map((call) => call[1][1])
          : ["review-session", "worker-session"];
      expect(sessions[0]).toEqual(expect.any(String));
      expect(sessions[0]).not.toBe(sessions[1]);
      for (const [index, [, args]] of calls.entries()) {
        const sessionId = sessions[index % 2];
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

// Usefulness: verifies the issue-#7 mechanism that a real Windows .cmd shim rejects multi-line argv but accepts the same prompt on stdin with the newline-free argv shapes the agents now use. The adapter tests mock execa, so only this test exercises a real .cmd spawn.
(process.platform === "win32" ? test : test.skip)(
  "windows .cmd shim rejects multi-line argv and round-trips stdin",
  async () => {
    const { execa: realExeca } = await vi.importActual("execa");
    const prompt =
      'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
    const dir = await mkdtemp(join(tmpdir(), "cmd-shim-"));
    const shim = join(dir, "echo-prompt.cmd");

    await writeFile(shim, '@echo off\r\nnode -e "process.stdin.pipe(process.stdout)"\r\n');

    try {
      expect(() => realExeca(shim, ["-p", prompt, "--output-format", "json"])).toThrow(
        /line break/,
      );

      for (const args of [
        ["-p", "--output-format", "json"],
        ["--input-format", "text", "--output-format", "json"],
      ]) {
        const result = await realExeca(shim, args, {
          input: prompt,
          stripFinalNewline: false,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(prompt);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
