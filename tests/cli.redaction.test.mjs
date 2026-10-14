import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { main } from "../src/cli.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";

const BASE = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy", "--task", "t"];

// Usefulness: acceptance (#537) — the fallback text for an empty thrown value goes through the shared
// redactor, so an environment value that matches part of it never reaches the transcript or stderr.
test("the fallback error text for an empty thrown value is redacted", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "empty error";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  const agents = {
    codex: {
      async run() {
        throw "";
      },
    },
    claude: { async run() {} },
    agy: { async run() {} },
  };
  try {
    await main([...BASE, "--cwd", repo, "--transcript", transcriptPath], agents);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    const expected = "Run failed with an [redacted:SYNTH_PROBE_TOKEN] message.";
    expect(transcript.error).toBe(expected);
    expect(errorSpy).toHaveBeenLastCalledWith(`\n${expected}`);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies a command text that holds the value of a secret-named environment
// variable reaches the transcript options, the transcript events, and the stderr report of
// a fatal run as `[redacted:NAME]`, so the file a parent keeps never holds the secret
// (issue #431, ADR 0017).
test("a secret value in the command text is redacted in the transcript and the stderr report", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  const agents = {
    codex: {
      async run() {
        return JSON.stringify({ action: "run_reviewer", prompt: "review" });
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run(_state, _prompt, options) {
        await writeFile(join(options.cwd, "by-reviewer.txt"), "x");
        return "reviewer ok";
      },
    },
  };
  try {
    await main(
      [
        ...BASE,
        "--test-cmd",
        `node -e "console.log('ok')" ${synthetic}`,
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      agents,
    );
    expect(process.exitCode).toBe(1);
    const transcript = await readFile(transcriptPath, "utf8");
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(JSON.parse(transcript).options.testCmd).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(
      JSON.parse(transcript).events.find((e) => e.type === "test-run").testRun.command,
    ).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(report).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(transcript).not.toContain(synthetic);
    expect(report).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies each headless refusal that echoes an argument prints a secret-named
// environment value as `[redacted:NAME]`, so a command passed unquoted, a mistyped flag, or a bad
// value never puts the secret on stderr (issue #431, ADR 0017).
test.each([
  ["an unknown flag with a value", ["--bogus=SECRET"]],
  [
    "an unquoted command that leaves the secret as a stray argument",
    ["--test-cmd", "node", "SECRET"],
  ],
  ["a bad --mode value", ["--mode", "SECRET"]],
  ["an unsupported worker", ["--worker", "SECRET"]],
  [
    "a malformed --test-cmd-timeout beside the command",
    ["--test-cmd", "echo SECRET", "--test-cmd-timeout", "SECRET"],
  ],
  ["an unreadable --task-file", ["--task-file", "SECRET"]],
])("a headless refusal for %s redacts the secret", async (_name, extra) => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  try {
    const argv = [...BASE, ...extra].map((arg) => arg.replaceAll("SECRET", synthetic));
    const withoutTask = extra[0] === "--task-file" ? argv.filter((_a, i) => i < 6 || i > 7) : argv;
    await main(withoutTask, {});
    expect(process.exitCode).toBe(1);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a fatal headless error whose text holds a secret-named environment value
// reaches the stderr report and the transcript error as `[redacted:NAME]` (issue #431, ADR 0017).
test("a fatal headless error redacts a secret value in the stderr report and the transcript", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  const agents = {
    codex: {
      async run() {
        throw new Error(`orchestrator crashed near ${synthetic}`);
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
    await main([...BASE, "--cwd", repo, "--transcript", transcriptPath], agents);
    expect(process.exitCode).toBe(1);
    const transcript = await readFile(transcriptPath, "utf8");
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(transcript).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(report).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(transcript).not.toContain(synthetic);
    expect(report).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies a thrown value whose message is not a string, or that is not an Error,
// reaches the headless stderr report and the transcript with a secret-named environment value
// redacted, so a non-string message cannot bypass the shared sink (issue #431, ADR 0017).
test.each([
  ["an object message", (secret) => ({ message: { detail: secret } })],
  ["an array message", (secret) => ({ message: [secret] })],
  ["a thrown string", (secret) => secret],
])("a headless thrown value with %s is redacted", async (_name, make) => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  const agents = {
    codex: {
      async run() {
        throw make(synthetic);
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
    await main([...BASE, "--cwd", repo, "--transcript", transcriptPath], agents);
    expect(process.exitCode).toBe(1);
    const transcript = await readFile(transcriptPath, "utf8");
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(transcript).not.toContain(synthetic);
    expect(report).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies the headless transcript write warning prints a secret-named environment
// value in the transcript path or the error as `[redacted:NAME]` (issue #431, ADR 0017).
test("the headless transcript write warning redacts a secret value", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  try {
    const blocker = join(repo, "blocker");
    await writeFile(blocker, "x");
    await main([...BASE, "--cwd", repo, "--transcript", join(blocker, synthetic, "t.json")], {});
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("Failed to write transcript");
    expect(report).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(report).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies the headless stderr report and transcript redact a value with a quote and a
// backslash that a thrown object carries (issue #431, ADR 0017).
test("a headless thrown object that holds a value with a quote and a backslash is redacted", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const value = 'synthetic"probe\\value-8f3a1c';
  process.env.SYNTH_PROBE_TOKEN = value;
  const agents = {
    codex: {
      async run() {
        throw { message: { detail: value } };
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
    await main([...BASE, "--cwd", repo, "--transcript", transcriptPath], agents);
    const transcript = await readFile(transcriptPath, "utf8");
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const text of [transcript, report]) {
      expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(report).toContain("[redacted:SYNTH_PROBE_TOKEN]");
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});
