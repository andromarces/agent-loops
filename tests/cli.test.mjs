import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { execa } from "execa";
import { main, parseArgs } from "../src/cli.mjs";

async function createTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "cli-test-repo-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.name", "Tester"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(join(dir, "init.txt"), "hello\n");
  await execa("git", ["add", "init.txt"], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

// Usefulness: verifies missing required --orchestrator flag throws error.
test("missing --orchestrator fails", () => {
  expect(() => parseArgs(["--worker", "claude", "--reviewer", "agy", "--task", "work"])).toThrow(
    "Missing required --orchestrator.",
  );
});

// Usefulness: verifies missing required --worker flag throws error.
test("missing --worker fails", () => {
  expect(() =>
    parseArgs(["--orchestrator", "codex", "--reviewer", "agy", "--task", "work"]),
  ).toThrow("Missing required --worker.");
});

// Usefulness: verifies missing required --reviewer flag throws error.
test("missing --reviewer fails", () => {
  expect(() =>
    parseArgs(["--orchestrator", "codex", "--worker", "claude", "--task", "work"]),
  ).toThrow("Missing required --reviewer.");
});

// Usefulness: verifies missing required --task flag throws error.
test("missing --task fails", () => {
  expect(() =>
    parseArgs(["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy"]),
  ).toThrow("Missing required --task.");
});

// Usefulness: verifies unsupported agent for any role fails.
test("unsupported agent fails", () => {
  expect(() =>
    parseArgs([
      "--orchestrator",
      "unknown",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
    ]),
  ).toThrow("Unsupported orchestrator: unknown");
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--worker",
      "unknown",
      "--reviewer",
      "agy",
      "--task",
      "t",
    ]),
  ).toThrow("Unsupported worker: unknown");
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "unknown",
      "--task",
      "t",
    ]),
  ).toThrow("Unsupported reviewer: unknown");
});

// Usefulness: verifies legacy --max-reviews flag is rejected as unknown argument.
test("--max-reviews is rejected", () => {
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
      "--max-reviews",
      "5",
    ]),
  ).toThrow("Unknown argument: --max-reviews");
});

// Usefulness: verifies invalid --max-steps values are rejected.
test("invalid --max-steps is rejected", () => {
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
      "--max-steps",
      "0",
    ]),
  ).toThrow("--max-steps must be a positive integer.");
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
      "--max-steps",
      "abc",
    ]),
  ).toThrow("--max-steps must be a positive integer.");
});

// Usefulness: verifies invalid --timeout values are rejected.
test("invalid --timeout is rejected", () => {
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
      "--timeout",
      "0",
    ]),
  ).toThrow("--timeout must be a positive integer.");
});

// Usefulness: verifies readValue guards against missing value or value starting with -.
test("readValue guards against missing or flag-like values", () => {
  expect(() => parseArgs(["--orchestrator", "--worker"])).toThrow(
    "Missing value for --orchestrator.",
  );
  expect(() => parseArgs(["--orchestrator", "codex", "--worker"])).toThrow(
    "Missing value for --worker.",
  );
});

// Usefulness: verifies OpenCode effort validation rules on orchestrator role.
test("OpenCode effort validation on orchestrator", () => {
  expect(() =>
    parseArgs([
      "--orchestrator",
      "opencode",
      "--orchestrator-effort",
      "high",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
    ]),
  ).toThrow("--orchestrator-effort requires --orchestrator-model for OpenCode.");

  expect(() =>
    parseArgs([
      "--orchestrator",
      "opencode",
      "--orchestrator-model",
      "claude-3-5#variant",
      "--orchestrator-effort",
      "high",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "t",
    ]),
  ).toThrow("already contains a variant");
});

// Usefulness: verifies non-Git --cwd exits 1 before any spawn and writes transcript if requested.
test("non-Git cwd exits 1 before spawn and records transcript", async () => {
  const nonRepo = await mkdtemp(join(tmpdir(), "non-repo-"));
  const transcriptPath = join(nonRepo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    await main([
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--task",
      "some task",
      "--cwd",
      nonRepo,
      "--transcript",
      transcriptPath,
    ]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--cwd must be inside a Git work tree"),
    );

    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(1);
    expect(transcript.error).toContain("--cwd must be inside a Git work tree");
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await rm(nonRepo, { recursive: true, force: true });
  }
});

// Usefulness: verifies successful finish run writes transcript with exitCode 0.
test("successful finish run writes transcript with exitCode 0", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;

  const fakeAgents = {
    codex: {
      async run() {
        return JSON.stringify({
          action: "finish",
          summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
        });
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run() {
        return "reviewer ok";
      },
    },
  };

  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "done task",
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(0);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(0);
    expect(transcript.error).toBeNull();
    // One orchestrator CLI call, then its validated finish action.
    expect(transcript.events.map((event) => event.type)).toEqual(["invocation", "action"]);
  } finally {
    process.exitCode = origExitCode;
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies step limit reached writes transcript with exitCode 2.
test("step limit run writes transcript with exitCode 2", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const fakeAgents = {
    codex: {
      async run() {
        return JSON.stringify({
          action: "run_worker",
          prompt: "keep working",
        });
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run() {
        return "reviewer ok";
      },
    },
  };

  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "infinite task",
        "--cwd",
        repo,
        "--max-steps",
        "1",
        "--transcript",
        transcriptPath,
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(2);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(2);
    expect(transcript.error).toContain("Step limit reached");
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies orchestrator failure writes transcript with exitCode 1.
test("orchestrator failure writes transcript with exitCode 1", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const fakeAgents = {
    codex: {
      async run() {
        throw new Error("fatal model crash");
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run() {
        return "reviewer ok";
      },
    },
  };

  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "task",
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(1);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(1);
    expect(transcript.error).toContain("fatal model crash");
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await rm(repo, { recursive: true, force: true });
  }
});

// Usefulness: verifies SIGINT cancel through cli.mjs sets exitCode 130 and writes transcript.
test("SIGINT cancel through cli.mjs exits 130 and records transcript", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const fakeAgents = {
    codex: {
      async run() {
        process.emit("SIGINT");
        // Simulate execa cancel behavior on signal
        const err = new Error("canceled");
        err.isCanceled = true;
        throw err;
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run() {
        return "reviewer ok";
      },
    },
  };

  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "task",
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(130);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(130);
    expect(transcript.error).toContain("Interrupted by SIGINT");
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await rm(repo, { recursive: true, force: true });
  }
});
