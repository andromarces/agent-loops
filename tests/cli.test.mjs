import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { execa } from "execa";

vi.mock("execa", () => ({ execa: vi.fn() }));

function mockKind(kind, replies, onInput) {
  return async (command, args, options) => {
    const actual = await vi.importActual("execa");
    const index = onInput.calls++;
    expect(command).toBe(kind);
    expect(options.cwd).toBe(process.cwd());
    expect(options.stdin).toBeUndefined();
    expect(args).not.toContain(options.input);
    onInput.handler(index, options.input, args);

    const echoed = await actual.execa(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { ...options, stripFinalNewline: false },
    );
    expect(echoed.exitCode).toBe(0);
    expect(echoed.stdout).toBe(options.input);

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
    } else if (kind === "agy") {
      stdout = JSON.stringify({ conversation_id: sessionId, response: replies[index] });
    }
    return { exitCode: 0, stdout, stderr: "" };
  };
}

// Usefulness: verifies the issue-#7 requirement that claude sends multi-line prompts on stdin with newline-free argv and still accepts the array envelope and the legacy object shape across initial and resume turns in a worker-first loop. No other test exercises the Claude stdin plus parse boundary, so coverage is nonredundant.
test("claude handles array and object envelopes and resumes worker-first sessions", async () => {
  const actual = await vi.importActual("execa");
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const task =
    'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
  const workerResult = "First implementation.\nDid the work.";
  const findings = "Blocking: fix null check.";
  const fix = "Fixed null check and ran tests.";
  const summary = "Changed: all.\nVerified: tests.\nDeferred: none.\nNot done: none.\nOpen: none.";
  const replies = [workerResult, findings, fix, "REVIEW_COMPLETE", summary];
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

      const sessionId = index % 2 === 0 ? "worker-session" : "review-session";
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
        expect(log).toHaveBeenCalledWith(expect.stringContaining(summary));
      },
      { timeout: 10000 },
    );

    expect(execa).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(execa).mock.calls;
    expect(calls[2][1]).toContain("worker-session");
    expect(calls[3][1]).toContain("review-session");
    expect(calls[4][1]).toContain("worker-session");
    for (const [index, [, args]] of calls.entries()) {
      const sessionId = index % 2 === 0 ? "worker-session" : "review-session";
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

// Usefulness: verifies the issue-#7 requirement that agy sends multi-line prompts on stdin with newline-free argv through --input-format text and resumes by conversation id in a worker-first loop. No other test exercises the agy spawn boundary, so coverage is nonredundant.
test("agy preserves multiline stdin and resumes worker-first sessions", async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const task =
    'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
  const workerResult = "First implementation.\nDid the work.";
  const findings = "Blocking: fix null check.";
  const fix = "Fixed null check and ran tests.";
  const summary = "Changed: all.\nVerified: tests.\nDeferred: none.\nNot done: none.\nOpen: none.";
  const replies = [workerResult, findings, fix, "REVIEW_COMPLETE", summary];
  const tracker = {
    calls: 0,
    handler(index, input, args) {
      expect(input).toContain(index === 0 ? task : replies[index - 1]);
      for (const arg of args) {
        expect(arg).not.toMatch(/[\r\n]/);
      }
      if (index >= 2) {
        const sessionId = index % 2 === 0 ? "worker-session" : "review-session";
        expect(args).toContain("--conversation");
        expect(args).toContain(sessionId);
      }
    },
  };

  vi.mocked(execa)
    .mockReset()
    .mockImplementation(mockKind("agy", replies, tracker));

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
        expect(log).toHaveBeenCalledWith(expect.stringContaining(summary));
      },
      { timeout: 10000 },
    );

    expect(execa).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(execa).mock.calls;
    const sessions = ["worker-session", "review-session", "worker-session"];
    for (const [index, [, args]] of calls.entries()) {
      const sessionId = sessions[index % 2 === 0 ? 0 : 1];
      if (index >= 2) {
        expect(args).toContain(sessionId);
      }
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

// Usefulness: verifies the issue-#3 requirement that the worker acts first with the exact first-worker and first-reviewer templates and REVIEW_COMPLETE triggers a final worker summary, and the issue-#2 requirement that multi-line prompts travel on stdin with newline-free argv. No other test exercises the execa spawn boundary in a worker-first loop, so coverage is nonredundant.
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
      expect(inputs[0]).toBe(`You are the implementation agent in an automated review loop.

Complete the task below. Inspect the actual repository state before you make changes. Run relevant tests, checks, or validation. Do not merely explain what must change.

After this turn, a reviewer will inspect your work. Each later message you receive starts with the line "From the Reviewer:" followed by either actionable findings or the single line REVIEW_COMPLETE.

When you receive findings, address every actionable finding, then report what you changed, what you verified, and any finding you did not address and why.

When you receive exactly this two-line message:
From the Reviewer:
REVIEW_COMPLETE

Do not change any files. Return a final summary report that covers the entire task, not only the last turn, with these sections:
- Changed: what changed across the whole loop
- Verified: what verification ran and its results
- Deferred: items intentionally postponed, with the reason
- Not done: items not completed, with the reason
- Open: unresolved questions or risks for the user
If a section has no items, state that explicitly.

Task:
${task}`);
      expect(inputs[1])
        .toBe(`Do not implement, fix, edit, or change anything yet. Review, assess, and verify only. Live probes and queries if needed are authorized. If there are any actionable blocking and non-blocking findings, only return with all the actionable blocking and non-blocking findings. If there are no actionable blocking and non-blocking findings, return REVIEW_COMPLETE.

Instruction for the Worker:
${task}

From the Worker:
${workerResult}`);
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
    const summary =
      "Changed: all.\nVerified: tests.\nDeferred: none.\nNot done: none.\nOpen: none.";
    const replies = [
      "Initial work.",
      "Blocking: fix null check.",
      "Fixed null check and ran tests.",
      "REVIEW_COMPLETE",
      summary,
    ];
    let callNumber = 0;

    vi.mocked(execa)
      .mockReset()
      .mockImplementation(async (command, args) => {
        const index = callNumber++;
        expect(command).toBe(kind);
        const role = index % 2 === 0 ? "worker" : "reviewer";
        check(args, role);

        const sessionId = role === "worker" ? "worker-session" : "review-session";
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
        "--task",
        "Do the thing.",
        "--max-reviews",
        "3",
      ];
      vi.resetModules();
      await import("../src/cli.mjs");
      await vi.waitFor(
        () => {
          expect(error).not.toHaveBeenCalled();
          expect(log).toHaveBeenCalledWith(expect.stringContaining(summary));
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
    const replies = ["Did the work.", "REVIEW_COMPLETE", "Final summary."];
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

        const sessionId = index % 2 === 0 ? "worker-session" : "review-session";
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
        "--task",
        "Do the thing.",
        "--max-reviews",
        "2",
      ];
      vi.resetModules();
      await import("../src/cli.mjs");
      await vi.waitFor(
        () => {
          expect(error).not.toHaveBeenCalled();
          expect(log).toHaveBeenCalledWith("\n===== SUMMARY =====\n");
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

// Usefulness: verifies the issue-#4 OpenCode rule and the missing-or-empty value errors. No other test exercises the variant merge or the value validation, so coverage is nonredundant.
test.each([
  {
    name: "rejects effort without a model",
    argv: [
      "--reviewer",
      "opencode",
      "--worker",
      "claude",
      "--task",
      "Do the thing.",
      "--reviewer-effort",
      "high",
    ],
    message: "--reviewer-effort requires --reviewer-model",
  },
  {
    name: "rejects a model variant plus effort",
    argv: [
      "--reviewer",
      "opencode",
      "--worker",
      "claude",
      "--task",
      "Do the thing.",
      "--reviewer-model",
      "provider/model#high",
      "--reviewer-effort",
      "low",
    ],
    message: "already contains a variant",
  },
  {
    name: "rejects an empty model value",
    argv: [
      "--reviewer",
      "claude",
      "--worker",
      "claude",
      "--task",
      "Do the thing.",
      "--reviewer-model",
      "",
    ],
    message: "Missing value for --reviewer-model",
  },
  {
    name: "rejects a missing --cwd value",
    argv: ["--reviewer", "claude", "--worker", "claude", "--task", "Do the thing.", "--cwd"],
    message: "Missing value for --cwd",
  },
])("validation $name", async ({ argv, message }) => {
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
// Usefulness: verifies the issue-#3 requirement that every turn uses the exact prompt template, asserting all four templates with whole-string equality. No other test covers the full prompt contract, so coverage is nonredundant.
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
    expect(inputs[0]).toBe(`You are the implementation agent in an automated review loop.

Complete the task below. Inspect the actual repository state before you make changes. Run relevant tests, checks, or validation. Do not merely explain what must change.

After this turn, a reviewer will inspect your work. Each later message you receive starts with the line "From the Reviewer:" followed by either actionable findings or the single line REVIEW_COMPLETE.

When you receive findings, address every actionable finding, then report what you changed, what you verified, and any finding you did not address and why.

When you receive exactly this two-line message:
From the Reviewer:
REVIEW_COMPLETE

Do not change any files. Return a final summary report that covers the entire task, not only the last turn, with these sections:
- Changed: what changed across the whole loop
- Verified: what verification ran and its results
- Deferred: items intentionally postponed, with the reason
- Not done: items not completed, with the reason
- Open: unresolved questions or risks for the user
If a section has no items, state that explicitly.

Task:
${task}`);
    expect(inputs[1])
      .toBe(`Do not implement, fix, edit, or change anything yet. Review, assess, and verify only. Live probes and queries if needed are authorized. If there are any actionable blocking and non-blocking findings, only return with all the actionable blocking and non-blocking findings. If there are no actionable blocking and non-blocking findings, return REVIEW_COMPLETE.

Instruction for the Worker:
${task}

From the Worker:
Initial work.`);
    expect(inputs[2]).toBe(`From the Reviewer:\n${findings}`);
    expect(inputs[3])
      .toBe(`Do not implement, fix, edit, or change anything yet. Review, assess, and verify only. Live probes and queries if needed are authorized.

From the Worker:
${fix}`);
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining("IMPLEMENTATION 1"));
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
