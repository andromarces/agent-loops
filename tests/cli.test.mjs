import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `withContinueRepo`); every other test, and every other command, reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { execa } from "execa";
import { main } from "../src/cli.mjs";
import { parseRoleArgs } from "../src/role.mjs";
import {
  cleanRepoGit,
  createCleanRepoDir,
  createTempRepo,
  removePath,
  untrackedFilesGit,
} from "./runtime-helpers.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const BASE = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy", "--task", "t"];

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
    await removePath(nonRepo);
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
    // One orchestrator CLI call, its validated finish action, then the gate record (#393).
    expect(transcript.events.map((event) => event.type)).toEqual(["invocation", "action", "gate"]);
  } finally {
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies the `--cwd` guard does not refuse a Git work tree whose
// path contains spaces, which would otherwise block every headless run in such a
// work tree (issue #413).
test("a Git work tree whose path contains spaces is not refused", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cli spaced parent-"));
  const source = await createTempRepo();
  const repo = join(parent, "my work tree");
  await rename(source, repo);
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const agents = {
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
    await main([...BASE, "--cwd", repo, "--transcript", transcriptPath], agents);

    expect(process.exitCode).toBe(0);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(0);
    expect(transcript.error).toBeNull();
  } finally {
    process.exitCode = origExitCode;
    await removePath(parent);
  }
});

// Usefulness: verifies a run with no --mode writes the transcript it wrote before the flag existed,
// so a consumer of that file sees no field this flag introduced. The comparison
// is the recorded file: the same top-level keys, the same option keys, and the
// same event list a run without the flag wrote before it (issue #337). A
// transcript inside the work tree also holds `runNonce`, and nothing else is added
// (ADR 0027), so the test runs once for each location.
test.each([
  { where: "outside the work tree", inTree: false, added: [] },
  { where: "inside the work tree", inTree: true, added: ["runNonce"] },
])("a mode-free run writes the pre-flag transcript shape $where", async ({ inTree, added }) => {
  const runOnce = async (extra) => {
    const repo = await createTempRepo();
    const transcriptPath = inTree ? join(repo, "transcript.json") : `${repo}-transcript.json`;
    const origExitCode = process.exitCode;
    const agents = {
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
      await main([...BASE, ...extra, "--cwd", repo, "--transcript", transcriptPath], agents);
      return JSON.parse(await readFile(transcriptPath, "utf8"));
    } finally {
      process.exitCode = origExitCode;
      await removePath(repo);
      await removePath(transcriptPath);
    }
  };

  const modeFree = await runOnce([]);
  // A mode-free run wrote these keys, and no more, before the flag existed, for a run that names no mode.
  expect(Object.keys(modeFree).sort()).toEqual(
    ["cwd", "error", "events", "exitCode", "options", "roles", "task", ...added].sort(),
  );
  if (inTree) expect(modeFree.runNonce).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(modeFree.options).sort()).toEqual(
    ["maxSteps", "pr", "requireAccept", "requireCi", "timeout"].sort(),
  );
  expect(modeFree.events.map((event) => event.type)).toEqual(["invocation", "action", "gate"]);

  // A run that names a mode records it, and its other fields are unchanged.
  const withMode = await runOnce(["--mode", "review-first"]);
  expect(withMode.options.mode).toBe("review-first");
  expect(Object.keys(withMode).sort()).toEqual(Object.keys(modeFree).sort());
  expect(Object.keys(withMode.options).sort()).toEqual(
    [...Object.keys(modeFree.options), "mode"].sort(),
  );
  expect(withMode.events.map((event) => event.type)).toEqual(
    modeFree.events.map((event) => event.type),
  );
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
    await removePath(repo);
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
    await removePath(repo);
  }
});

// Usefulness: acceptance (#537) — a falsy value thrown by the orchestrator still fails the run with
// a non-null transcript error and a visible non-empty stderr error line, so a failed run never reads as error-free.
test.each([
  [null, "null"],
  [undefined, "undefined"],
  [0, "0"],
  [false, "false"],
  ["", "Run failed with an empty error message."],
  [new Error(""), "Run failed with an empty error message."],
])(
  "orchestrator that throws %j records a transcript error and prints an error line",
  async (thrown, expectedText) => {
    const repo = await createTempRepo();
    const transcriptPath = join(repo, "transcript.json");
    const origExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeAgents = {
      codex: {
        async run() {
          throw thrown;
        },
      },
      claude: { async run() {} },
      agy: { async run() {} },
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
      expect(transcript.error).toBe(expectedText);
      expect(errorSpy).toHaveBeenLastCalledWith(`\n${expectedText}`);
    } finally {
      process.exitCode = origExitCode;
      errorSpy.mockRestore();
      await removePath(repo);
    }
  },
);

// Usefulness: acceptance (#523) — a thrown value whose `isCanceled` getter throws still reaches
// the generic failure path (exit 1) instead of hiding the original failure.
test("headless run survives a thrown value with a throwing isCanceled getter", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const thrown = {
    message: "original failure",
    get isCanceled() {
      throw new Error("getter");
    },
  };
  const fakeAgents = {
    codex: {
      async run() {
        throw thrown;
      },
    },
    claude: { async run() {} },
    agy: { async run() {} },
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
      ],
      fakeAgents,
    );
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "original failure",
    );
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies a finish that reports an unresolved PR-head compare exits
// 4 and still prints the recorded summary, so an exit-code-only consumer tells
// it apart from the exit-0 verified finish (issue #279).
test("finish with unresolvedCompare exits 4 and keeps the summary", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  const fakeAgents = {
    codex: {
      async run() {
        return JSON.stringify({
          action: "finish",
          summary: {
            changed: "a",
            verified: "not verified",
            deferred: "c",
            notDone: "d",
            open: "e",
          },
          unresolvedCompare: true,
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
        "task",
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(4);
    const printed = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(printed).toContain("===== SUMMARY =====");
    expect(printed).toContain("Not done: d");
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(4);
    expect(transcript.error).toBeNull();
  } finally {
    process.exitCode = origExitCode;
    logSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies a review-only finish without the marker keeps exit 0 and
// its summary, so the new code fires on the marker alone (issue #279).
test("review-only finish without unresolvedCompare keeps exit 0", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const orchReplies = [
    JSON.stringify({ action: "run_reviewer", prompt: "review" }),
    JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    }),
  ];

  const fakeAgents = {
    codex: {
      async run() {
        return orchReplies.shift();
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
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(printed).toContain("===== SUMMARY =====");
    expect(printed).toContain("Verified: b");
  } finally {
    process.exitCode = origExitCode;
    logSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies --version and -V print the package.json version without an exit error.
test.each(["--version", "-V"])("%s prints the package version", async (flag) => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await main([flag]);
    expect(log.mock.calls).toEqual([[version]]);
    expect(process.exitCode).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

// Usefulness: verifies the top-level help lists both new flags.
test("--help lists --version and role --help", async () => {
  const { stdout } = await execa(process.execPath, [CLI, "--help"]);
  expect(stdout).toContain("-V, --version");
  expect(stdout).toContain("agent-loop role --help");
});

// Usefulness: verifies `role --help` and `role -h` print usage on stdout and exit 0.
test.each(["--help", "-h"])("role %s prints usage and exits 0", async (flag) => {
  const result = await execa(process.execPath, [CLI, "role", flag]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^Usage: agent-loop role/);
});

// Usefulness: verifies a help flag after an operation parses, and an inline value is rejected.
test("role help parses after an operation and rejects an inline value", () => {
  expect(parseRoleArgs(["finish", "-h"]).help).toBe(true);
  expect(() => parseRoleArgs(["--help=1"])).toThrow("--help does not take a value.");
});

// Runs `fn(repo, transcriptPath, errorSpy)` with a clean exit-code and error state. The
// repo is a directory with a `.git` directory and `git` is answered from memory
// (`cleanRepoGit`), so the test starts no `git` process.
async function withContinueRepo(fn) {
  const repo = await createCleanRepoDir();
  gitDouble.answer = cleanRepoGit;
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await fn(repo, join(repo, "run.json"), errorSpy);
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    logSpy.mockRestore();
    gitDouble.answer = null;
    await removePath(repo);
  }
}

// Usefulness: verifies the headless transcript keeps the --test-cmd result and its work
// tree compare when the run ends on a fatal error, here a reviewer mutation, so the
// evidence the runtime read survives the exit 1 (issue #420 review of aa0b25e).
test("a fatal run keeps the test command result in the transcript", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    gitDouble.answer = untrackedFilesGit;
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
    await main(
      [
        ...BASE,
        "--test-cmd",
        `node -e "require('fs').writeFileSync('generated.txt', 'x'); console.log('9 passed')"`,
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      agents,
    );
    expect(process.exitCode).toBe(1);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.error).toContain("Mutation detected during reviewer turn");
    const evidence = transcript.events.find((e) => e.type === "test-run");
    expect(evidence.testRun).toMatchObject({
      status: "pass",
      workTreeChanged: true,
      changedPaths: ["generated.txt"],
    });
  });
});

// Usefulness: verifies a headless run that ends on a fatal error reports the command
// result and its work tree compare on stderr when no --transcript is given, so the
// parent that reads only the exit report still gets the evidence the runtime read
// (issue #420 review of 9ec667e).
test("a fatal run reports the test command result on stderr without a transcript", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
        `node -e "require('fs').writeFileSync('generated.txt', 'x'); console.log('9 passed')"`,
        "--cwd",
        repo,
      ],
      agents,
    );
    expect(process.exitCode).toBe(1);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).toContain("Mutation detected during reviewer turn");
    expect(report).toContain("Test command result");
    expect(report).toContain("9 passed");
    expect(report).toContain("generated.txt");
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});

// Usefulness: verifies a fatal run with no --test-cmd prints no test report, so the
// error report keeps its earlier shape when the flag is absent (issue #420).
test("a fatal run without a test command prints no test report", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    await main([...BASE, "--cwd", repo], agents);
    expect(process.exitCode).toBe(1);
    const report = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(report).not.toContain("Test command result");
  } finally {
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
    await removePath(repo);
  }
});
