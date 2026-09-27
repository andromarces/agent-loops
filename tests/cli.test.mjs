import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { main, parseArgs } from "../src/cli.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

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

const BASE = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy", "--task", "t"];

// Usefulness: verifies an unattended run is bounded by default (issue #48).
test("--timeout defaults to 3600 seconds when unset", () => {
  expect(parseArgs(BASE).timeout).toBe(3600);
});

// Usefulness: verifies --timeout 0 is the documented way to remove the bound.
test("--timeout 0 disables the per-invocation bound", () => {
  expect(parseArgs([...BASE, "--timeout", "0"]).timeout).toBeNull();
});

// Usefulness: verifies negative and non-integer --timeout values are rejected.
test("invalid --timeout is rejected", () => {
  for (const bad of ["abc", "1.5"]) {
    expect(() => parseArgs([...BASE, "--timeout", bad])).toThrow(
      "--timeout must be a non-negative integer.",
    );
  }
});

// Usefulness: verifies --require-accept is an opt-in boolean gate that defaults
// off and rejects an inline value like the other boolean flags (issue #234).
test("--require-accept is a boolean flag", () => {
  expect(parseArgs(BASE).requireAccept).toBe(false);
  expect(parseArgs([...BASE, "--require-accept"]).requireAccept).toBe(true);
  expect(() => parseArgs([...BASE, "--require-accept=1"])).toThrow(
    "--require-accept does not take a value.",
  );
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

// Usefulness: verifies acceptance (#210) — the inline form accepts a value that
// starts with `-`, which the space-separated form rejects.
test("--task=-x sets the task", () => {
  expect(parseArgs([...BASE, "--task=-x"]).task).toBe("-x");
});

// Usefulness: verifies acceptance (#210) — an empty inline value is rejected at
// parse time, matching the space-separated form, so a no-op flag value cannot
// silently pass through.
test("--task= is rejected as a missing value", () => {
  expect(() => parseArgs([...BASE, "--task="])).toThrow("Missing value for --task.");
});

// Usefulness: verifies acceptance (#210) — a boolean flag rejects an inline value.
test("--verbose=1 is rejected", () => {
  expect(() => parseArgs([...BASE, "--verbose=1"])).toThrow("--verbose does not take a value.");
});

// Usefulness: verifies acceptance (#215) — an unknown inline argument keeps the
// `=value` segment in the error, so the whole token the user typed is reported.
test("unknown inline argument keeps its value in the error", () => {
  expect(() => parseArgs([...BASE, "--nope=bar"])).toThrow("Unknown argument: --nope=bar");
});

// Usefulness: verifies acceptance (#215) — an empty inline value on a boolean
// flag is rejected as a value on a no-value flag, not as a missing value.
test("--verbose= is rejected as not taking a value", () => {
  expect(() => parseArgs([...BASE, "--verbose="])).toThrow("--verbose does not take a value.");
});

// Usefulness: verifies acceptance (#215) — an unknown inline argument with an
// empty value still reports the full token rather than a missing value.
test("unknown inline argument with an empty value reports the full token", () => {
  expect(() => parseArgs([...BASE, "--nope="])).toThrow("Unknown argument: --nope=");
});

// Usefulness: verifies an effort-only OpenCode role is rejected, because the installed CLI accepts
// a variant only inside --model provider/model#variant.
test("OpenCode effort without a model is rejected", () => {
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
  ).toThrow("--orchestrator-effort requires --orchestrator-model");
});

// Usefulness: verifies a model that already carries a variant still conflicts with a separate effort.
test("OpenCode model variant with effort is rejected", () => {
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
