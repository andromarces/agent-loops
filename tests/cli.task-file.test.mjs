import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main, parseArgs } from "../src/cli.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";

const BASE = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy"];
const created = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    await removePath(dir);
  }
});

/** Runs the headless command to an orchestrator abort; returns the recorded task and exit state. */
async function runHeadless(flags, { stdin } = {}) {
  const repo = await createTempRepo();
  created.push(repo);
  const transcript = join(repo, "..", `${Date.now()}-${Math.random()}.json`);
  const errors = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
  const origExitCode = process.exitCode;
  let calls = 0;
  try {
    await main(
      [...BASE, ...flags, "--cwd", repo, "--transcript", transcript],
      {
        codex: {
          async run() {
            calls += 1;
            return JSON.stringify({ action: "abort", reason: "done" });
          },
        },
        claude: { run: async () => "worker" },
        agy: { run: async () => "reviewer" },
      },
      { stdin },
    );
    const exitCode = process.exitCode;
    const recorded = await readFile(transcript, "utf8").then(
      (text) => JSON.parse(text).task,
      () => null,
    );
    return { task: recorded, calls, errors: errors.join("\n"), exitCode };
  } finally {
    process.exitCode = origExitCode;
  }
}

async function taskFile(content) {
  const dir = await mkdtemp(join(tmpdir(), "task-file-"));
  created.push(dir);
  const path = join(dir, "task.md");
  await writeFile(path, content);
  return path;
}

// Usefulness: acceptance (#211) — the file content becomes the task, multi-line and verbatim.
test("--task-file runs with the file content as the task", async () => {
  const path = await taskFile("Line one.\nLine two with 'quotes'.\n");
  const run = await runHeadless(["--task-file", path]);
  expect(run.calls).toBeGreaterThan(0);
  expect(run.task).toBe("Line one.\nLine two with 'quotes'.\n");
});

// Usefulness: acceptance (#211) — `--task-file -` reads the task from stdin, in the space form.
test("--task-file - reads the task from stdin", async () => {
  const run = await runHeadless(["--task-file", "-"], { stdin: async () => "From stdin.\n" });
  expect(run.calls).toBeGreaterThan(0);
  expect(run.task).toBe("From stdin.\n");
});

// Usefulness: acceptance (#211) — a task from two sources fails before any run starts.
test("--task with --task-file fails with a clear error", async () => {
  expect(() => parseArgs([...BASE, "--task", "t", "--task-file", "task.md"])).toThrow(
    "--task and --task-file cannot be combined.",
  );
  expect(() => parseArgs([...BASE, "--task-file", "task.md", "--task", "t"])).toThrow(
    "--task and --task-file cannot be combined.",
  );
});

// Usefulness: acceptance (#211) — the empty-task check applies to the file content, from a file and from stdin.
test("an empty or whitespace-only task file fails with the missing task error", async () => {
  for (const content of ["", " \n\t\n"]) {
    const run = await runHeadless(["--task-file", await taskFile(content)]);
    expect(run.exitCode).toBe(1);
    expect(run.calls).toBe(0);
    expect(run.errors).toContain("Missing required --task.");
  }
  const run = await runHeadless(["--task-file", "-"], { stdin: async () => "  \n" });
  expect(run.exitCode).toBe(1);
  expect(run.calls).toBe(0);
  expect(run.errors).toContain("Missing required --task.");
});

// Usefulness: an unreadable file reports the path and fails before any run starts.
test("a missing task file fails and names the file", async () => {
  const missing = join(tmpdir(), "task-file-does-not-exist", "task.md");
  const run = await runHeadless(["--task-file", missing]);
  expect(run.exitCode).toBe(1);
  expect(run.calls).toBe(0);
  expect(run.errors).toContain(missing);
});

// Usefulness: acceptance (#211) — help lists the flag.
test("help lists --task-file", async () => {
  const lines = [];
  vi.spyOn(console, "log").mockImplementation((text) => lines.push(String(text)));
  const origExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  expect(() => parseArgs(["--help"])).toThrow("exit");
  origExit.mockRestore();
  expect(lines.join("\n")).toContain("--task-file <path|->");
});
