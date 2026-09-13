import { expect, test, vi } from "vitest";
import { execa } from "execa";

vi.mock("execa", () => ({ execa: vi.fn() }));

// Usefulness: verifies the issue-#6 requirement that claude accepts the array envelope and the legacy object shape across initial and resume turns. No other test exercises the Claude parse boundary, so coverage is nonredundant.
test("claude handles array and object envelopes and resumes sessions", async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const task = 'Inspect both lines.\nKeep "quotes" and Unicode: café.';
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
    .mockImplementation(async (command, args) => {
      const index = callNumber++;
      expect(command).toBe("claude");
      expect(args[0]).toBe("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("json");
      const prompt = args.find(
        (arg) => typeof arg === "string" && arg.includes(index === 0 ? task : replies[index - 1]),
      );
      expect(prompt).toBeDefined();

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

// Usefulness: verifies the issue-#4 requirement that per-role model and effort flags reach each CLI on first and resumed calls. No other test exercises the model argument boundary, so coverage is nonredundant.
test.each([
  {
    kind: "claude",
    reviewerModel: "reviewer-claude-model",
    reviewerEffort: "high",
    workerModel: "worker-claude-model",
    workerEffort: "low",
    check: (args, role) => {
      const model = role === "reviewer" ? "reviewer-claude-model" : "worker-claude-model";
      const effort = role === "reviewer" ? "high" : "low";
      expect(args[args.indexOf("--model") + 1]).toBe(model);
      expect(args[args.indexOf("--effort") + 1]).toBe(effort);
    },
  },
  {
    kind: "codex",
    reviewerModel: "reviewer-codex-model",
    reviewerEffort: "xhigh",
    workerModel: "worker-codex-model",
    workerEffort: "low",
    check: (args, role) => {
      const model = role === "reviewer" ? "reviewer-codex-model" : "worker-codex-model";
      const effort = role === "reviewer" ? "xhigh" : "low";
      expect(args[args.indexOf("-m") + 1]).toBe(model);
      expect(args[args.indexOf("-c") + 1]).toBe(`model_reasoning_effort=${effort}`);
    },
  },
  {
    kind: "agy",
    reviewerModel: "reviewer-agy-model",
    reviewerEffort: "high",
    workerModel: "worker-agy-model",
    workerEffort: "low",
    check: (args, role) => {
      const model = role === "reviewer" ? "reviewer-agy-model" : "worker-agy-model";
      const effort = role === "reviewer" ? "high" : "low";
      expect(args[args.indexOf("--model") + 1]).toBe(model);
      expect(args[args.indexOf("--effort") + 1]).toBe(effort);
    },
  },
  {
    kind: "opencode",
    reviewerModel: "provider/reviewer-model",
    reviewerEffort: "high",
    workerModel: "provider/worker-model",
    workerEffort: "low",
    check: (args, role) => {
      const expected =
        role === "reviewer" ? "provider/reviewer-model#high" : "provider/worker-model#low";
      expect(args[args.indexOf("--model") + 1]).toBe(expected);
    },
  },
  {
    kind: "copilot",
    reviewerModel: "reviewer-copilot-model",
    reviewerEffort: "xhigh",
    workerModel: "worker-copilot-model",
    workerEffort: "low",
    check: (args, role) => {
      const model = role === "reviewer" ? "reviewer-copilot-model" : "worker-copilot-model";
      const effort = role === "reviewer" ? "xhigh" : "low";
      expect(args[args.indexOf("--model") + 1]).toBe(model);
      expect(args[args.indexOf("--reasoning-effort") + 1]).toBe(effort);
    },
  },
])(
  "$kind forwards per-role model and effort on first and resumed calls",
  async ({ kind, reviewerModel, reviewerEffort, workerModel, workerEffort, check }) => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const replies = ["Finding.", "Fix.", "Finding again.", "Fix again.", "Done.\nREVIEW_COMPLETE"];
    let callNumber = 0;

    vi.mocked(execa)
      .mockReset()
      .mockImplementation(async (command, args) => {
        const index = callNumber++;
        expect(command).toBe(kind);
        const role = index % 2 === 0 ? "reviewer" : "worker";
        check(args, role);

        const sessionId = role === "reviewer" ? "review-session" : "worker-session";
        let stdout = replies[index];
        if (kind === "claude") {
          stdout = JSON.stringify({ session_id: sessionId, result: stdout });
        } else if (kind === "codex") {
          stdout = [
            { type: "thread.started", thread_id: sessionId },
            { type: "item.completed", item: { type: "agent_message", text: stdout } },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n");
        } else if (kind === "agy") {
          stdout = JSON.stringify({ conversation_id: sessionId, response: stdout });
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
        "--reviewer-model",
        reviewerModel,
        "--reviewer-effort",
        reviewerEffort,
        "--worker-model",
        workerModel,
        "--worker-effort",
        workerEffort,
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
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
    }
  },
);

// Usefulness: verifies the issue-#4 requirement that omitted model and effort flags leave each CLI default untouched. No other test asserts the absence of these flags, so coverage is nonredundant.
test.each(["claude", "codex", "agy", "opencode", "copilot"])(
  "%s omits model and effort flags when the options are not passed",
  async (kind) => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const replies = ["Finding.", "Fix.", "Done.\nREVIEW_COMPLETE"];
    let callNumber = 0;

    vi.mocked(execa)
      .mockReset()
      .mockImplementation(async (command, args) => {
        const index = callNumber++;
        expect(command).toBe(kind);
        expect(args).not.toContain("--model");
        expect(args).not.toContain("-m");
        expect(args).not.toContain("--effort");
        expect(args).not.toContain("-c");
        expect(args).not.toContain("--reasoning-effort");
        expect(
          args.some((arg) => typeof arg === "string" && arg.includes("reasoning_effort")),
        ).toBe(false);

        const sessionId = index % 2 === 0 ? "review-session" : "worker-session";
        let stdout = replies[index];
        if (kind === "claude") {
          stdout = JSON.stringify({ session_id: sessionId, result: stdout });
        } else if (kind === "codex") {
          stdout = [
            { type: "thread.started", thread_id: sessionId },
            { type: "item.completed", item: { type: "agent_message", text: stdout } },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n");
        } else if (kind === "agy") {
          stdout = JSON.stringify({ conversation_id: sessionId, response: stdout });
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
        "--max-reviews",
        "2",
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

      expect(execa).toHaveBeenCalledTimes(3);
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
    }
  },
);

// Usefulness: verifies the issue-#4 OpenCode rule that effort appends as a model variant suffix. No other test exercises the variant merge, so coverage is nonredundant.
test.each([
  {
    name: "rejects effort without a model",
    argv: ["--reviewer", "opencode", "--worker", "claude", "--reviewer-effort", "high"],
    message: "--reviewer-effort requires --reviewer-model",
  },
  {
    name: "rejects a model variant plus effort",
    argv: [
      "--reviewer",
      "opencode",
      "--worker",
      "claude",
      "--reviewer-model",
      "provider/model#high",
      "--reviewer-effort",
      "low",
    ],
    message: "already contains a variant",
  },
])("opencode $name", async ({ argv, message }) => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(execa).mockReset();

  try {
    process.argv = [process.execPath, "src/cli.mjs", ...argv];
    process.exitCode = undefined;
    vi.resetModules();
    await import("../src/cli.mjs");
    await vi.waitFor(
      () => {
        expect(error).toHaveBeenCalled();
      },
      { timeout: 10000 },
    );
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).toContain(message);
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  }
});
