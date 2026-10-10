import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { main, parseArgs } from "../src/cli.mjs";
import { readProcessCommands } from "../src/lib/process-ancestry.mjs";
import { parseRoleArgs } from "../src/role.mjs";
import {
  cleanRepoGit,
  createTempRepo,
  removePath,
  untrackedFilesGit,
  createPsShim,
  within,
} from "./runtime-helpers.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// True when the process-table read of the product works on this host and lists this process.
const processTableReadable = await readProcessCommands().then(
  (table) => table.some((entry) => entry.pid === process.pid),
  () => false,
);

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

const BASE_FOR_MAX_STEPS = [
  "--orchestrator",
  "codex",
  "--worker",
  "claude",
  "--reviewer",
  "agy",
  "--task",
  "t",
];

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
  // A value above the safe integer range is refused, so `stepsUsed + 1` always
  // advances and the documented step budget holds (issue #312).
  expect(() => parseArgs([...BASE_FOR_MAX_STEPS, "--max-steps", "1000000000000000000000"])).toThrow(
    "--max-steps must be a positive integer.",
  );
  expect(parseArgs([...BASE_FOR_MAX_STEPS, "--max-steps", "9007199254740991"]).maxSteps).toBe(
    9007199254740991,
  );
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

// Usefulness: verifies the headless loop takes a PR number for the finish gate,
// defaults it off, and rejects a value that is not a positive integer, so a bad
// PR number fails at parse time instead of inside the gate (issue #293).
test("--require-ci takes a positive integer PR number", () => {
  expect(parseArgs(BASE).requireCi).toBeNull();
  expect(parseArgs([...BASE, "--require-ci", "42"]).requireCi).toBe(42);
  expect(parseArgs([...BASE, "--require-ci=7"]).requireCi).toBe(7);
  for (const bad of ["0", "abc"]) {
    expect(() => parseArgs([...BASE, "--require-ci", bad])).toThrow(
      "--require-ci must be a positive integer.",
    );
  }
});

// Usefulness: verifies the run PR declaration takes a positive integer PR
// number, defaults to absent, and rejects a value that is not a positive integer,
// so a run cannot declare a PR the gate could not read (issue #302).
test("--pr declares the run PR and takes a positive integer", () => {
  expect(parseArgs(BASE).pr).toBeNull();
  expect(parseArgs([...BASE, "--pr", "42"]).pr).toBe(42);
  expect(parseArgs([...BASE, "--pr=7"]).pr).toBe(7);
  for (const bad of ["0", "abc"]) {
    expect(() => parseArgs([...BASE, "--pr", bad])).toThrow("--pr must be a positive integer.");
  }
});

// Usefulness: verifies the headless loop takes the test command and its bound,
// defaults both off, and refuses a blank command, a bound with no command, and a
// bound that is not a positive integer, so a bad value fails at parse time and
// the run never starts with a command it cannot run (issue #420).
test("--test-cmd and --test-cmd-timeout parse and refuse bad values", () => {
  expect(parseArgs(BASE)).toMatchObject({ testCmd: null, testCmdTimeout: null });
  expect(parseArgs([...BASE, "--test-cmd", "pnpm test"]).testCmd).toBe("pnpm test");
  expect(parseArgs([...BASE, "--test-cmd=pnpm test", "--test-cmd-timeout", "90"])).toMatchObject({
    testCmd: "pnpm test",
    testCmdTimeout: 90,
  });
  expect(() => parseArgs([...BASE, "--test-cmd", "   "])).toThrow("--test-cmd must not be blank.");
  expect(() => parseArgs([...BASE, "--test-cmd-timeout", "90"])).toThrow(
    "--test-cmd-timeout requires --test-cmd.",
  );
  for (const bad of ["0", "abc"]) {
    expect(() => parseArgs([...BASE, "--test-cmd", "x", "--test-cmd-timeout", bad])).toThrow(
      "--test-cmd-timeout must be a positive integer.",
    );
  }
});

// Usefulness: verifies the headless loop takes the reviewer sandbox opt-in, defaults it off, and
// refuses it for a reviewer that is not Codex, so the opt-in never silently does nothing while the
// prompt says it is on (issue #421).
test("--reviewer-workspace-write parses, defaults off, and needs a Codex reviewer", () => {
  expect(parseArgs(BASE).reviewerWorkspaceWrite).toBe(false);
  const codexReviewer = BASE.map((v) => (v === "agy" ? "codex" : v));
  expect(parseArgs([...codexReviewer, "--reviewer-workspace-write"]).reviewerWorkspaceWrite).toBe(
    true,
  );
  expect(() => parseArgs([...BASE, "--reviewer-workspace-write"])).toThrow(
    "--reviewer-workspace-write requires --reviewer codex.",
  );
  expect(() => parseArgs([...codexReviewer, "--reviewer-workspace-write=1"])).toThrow(
    "--reviewer-workspace-write does not take a value.",
  );
});

// Usefulness: verifies the headless path refuses a gate for another pull request
// at parse time, before any child turn runs and before the prompt is built. Both
// flags arrive on one command line there, so a run that could never be gated
// never starts, and the prompt never has to describe a case it cannot reach.
// A matching gate is still accepted, and `--pr` alone is still accepted (issue #302).
test("--pr with --require-ci for another pull request is a usage error", () => {
  expect(() => parseArgs([...BASE, "--pr", "42", "--require-ci", "7"])).toThrow(
    "--pr 42 and --require-ci 7 must name the same pull request.",
  );
  expect(() => parseArgs([...BASE, "--pr=42", "--require-ci=7"])).toThrow(
    "--pr 42 and --require-ci 7 must name the same pull request.",
  );
  expect(parseArgs([...BASE, "--pr", "42", "--require-ci", "42"]).requireCi).toBe(42);
  expect(parseArgs([...BASE, "--pr", "42"]).pr).toBe(42);
  expect(parseArgs([...BASE, "--require-ci", "7"]).requireCi).toBe(7);
});

// Usefulness: verifies a review-only headless run refuses --pr, --require-accept,
// and --require-ci before any child turn runs, with the interactive wordings, so
// the two paths state one rule for a mode that could never reach a gate. The
// check is the command outcome: exit 1, the refusal on stderr, and no child CLI
// call (issue #337).
test("a review-only run refuses the PR flags before any child turn", async () => {
  const refusals = [
    [["--pr", "42"], "--pr declares PR work, which needs the --require-ci gate"],
    [
      ["--require-accept"],
      "--require-accept and --require-ci apply only to work-first and review-first",
    ],
    [
      ["--require-ci", "42"],
      "--require-accept and --require-ci apply only to work-first and review-first",
    ],
  ];
  const origExitCode = process.exitCode;
  // The refusal is raised by `parseArgs`, before any Git validation, so the run
  // needs no repo: creating one spawns six `git` processes, which is most of the
  // cost of a run on Windows.
  const cwd = tmpdir();

  try {
    for (const [flags, message] of refusals) {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const agents = {
        codex: {
          async run() {
            throw new Error("orchestrator must not run");
          },
        },
        claude: {
          async run() {
            throw new Error("worker must not run");
          },
        },
        agy: {
          async run() {
            throw new Error("reviewer must not run");
          },
        },
      };
      try {
        await main([...BASE, "--mode", "review-only", ...flags, "--cwd", cwd], agents);
        expect(process.exitCode).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      } finally {
        process.exitCode = origExitCode;
        errorSpy.mockRestore();
      }
    }
  } finally {
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a work-first or review-first run still takes the PR flags
// the review-only run refuses, and that a run with no --mode takes them too,
// because only review-only rejects a gate. The check is the command outcome: the
// run starts, so the orchestrator CLI is called and no usage error is printed
// (issue #337).
test("the other modes and a mode-free run still take the PR flags", async () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // One repo serves every run: creating a repo spawns six `git` processes, which
  // is most of the cost of a run on Windows, and no run here changes the repo.
  const repo = await createTempRepo();

  try {
    for (const flags of [["--mode", "work-first"], ["--mode", "review-first"], []]) {
      let orchestratorCalls = 0;
      const agents = {
        codex: {
          async run() {
            orchestratorCalls += 1;
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
        // The gate is declared but never evaluated: this orchestrator finishes
        // with no reviewer turn, so the gate refuses and the run ends on exit 1
        // with a gate reason rather than a usage error.
        await main([...BASE, ...flags, "--pr", "42", "--require-ci", "42", "--cwd", repo], agents);
        // The run started, so the orchestrator CLI was called at least once, and
        // no usage error named a review-only refusal.
        expect(orchestratorCalls).toBeGreaterThan(0);
        expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("review-only"));
      } finally {
        process.exitCode = origExitCode;
      }
    }
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies the headless --mode accepts the same three values as the
// interactive path and refuses any other, so a caller learns the mode names from
// one list on both paths. The check is the command outcome: a known value starts
// the run, an unknown one exits 1 with the message (issue #337).
test("--mode takes the interactive mode values", async () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // One repo serves every run: see the PR flags test above.
  const repo = await createTempRepo();

  try {
    for (const mode of ["work-first", "review-first", "review-only"]) {
      let orchestratorCalls = 0;
      const agents = {
        codex: {
          async run() {
            orchestratorCalls += 1;
            return JSON.stringify({ action: "abort", reason: "done" });
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
        await main([...BASE, "--mode", mode, "--cwd", repo], agents);
        expect(orchestratorCalls).toBe(1);
      } finally {
        process.exitCode = origExitCode;
      }
    }

    await main([...BASE, "--mode", "nope", "--cwd", repo]);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "--mode must be one of work-first, review-first, review-only, got: nope",
      ),
    );
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies a repeated --mode takes the last value, the way every
// other repeated single-value flag on this path already behaves, such as --task,
// so the flag adds no new rule. The check is the command outcome: the last value
// decides, so review-only last refuses the PR flag and work-first last accepts
// it (issue #337).
test("a repeated --mode takes the last value", async () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const refused = await createTempRepo();
    try {
      await main([
        ...BASE,
        "--mode",
        "work-first",
        "--mode",
        "review-only",
        "--pr",
        "42",
        "--cwd",
        refused,
      ]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("review-only rejects that gate"),
      );
    } finally {
      process.exitCode = origExitCode;
      await removePath(refused);
    }

    const accepted = await createTempRepo();
    let orchestratorCalls = 0;
    const agents = {
      codex: {
        async run() {
          orchestratorCalls += 1;
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
        [...BASE, "--mode", "review-only", "--mode", "work-first", "--pr", "42", "--cwd", accepted],
        agents,
      );
      // work-first won, so the declaration was accepted and the run started.
      expect(orchestratorCalls).toBeGreaterThan(0);
    } finally {
      process.exitCode = origExitCode;
      await removePath(accepted);
    }
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
  }
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

// Usefulness: verifies a run with no --mode writes the origin/main transcript,
// so a consumer of that file sees no field this flag introduced. The comparison
// is the recorded file: the same top-level keys, the same option keys, and the
// same event list a run without the flag wrote before it (issue #337). A
// transcript inside the work tree also holds `runNonce`, and nothing else is added
// (ADR 0027), so the test runs once for each location.
test.each([
  { where: "outside the work tree", inTree: false, added: [] },
  { where: "inside the work tree", inTree: true, added: ["runNonce"] },
])("a mode-free run writes the origin/main transcript shape $where", async ({ inTree, added }) => {
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
  // origin/main wrote these keys, and no more, for a run that names no mode.
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
    await removePath(repo);
  }
});

// Usefulness: acceptance (#669) — a real SIGINT while an execa child runs ends the run through its
// handler (exit 130, transcript written), not by re-raised signal. A child process is needed: the
// execa exit handler re-raises the signal only when no other SIGINT listener remains. Windows has
// no signals, so `kill("SIGINT")` ends the process there at once and the case cannot run.
test.skipIf(process.platform === "win32")(
  "a real SIGINT during a child turn exits 130 and writes the transcript",
  async () => {
    const repo = await createTempRepo();
    const transcriptPath = join(repo, "transcript.json");
    const runner = [
      `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
      `import { exec } from ${JSON.stringify(pathToFileURL(CLI.replace("cli.mjs", "lib/exec.mjs")).href)};`,
      "const stall = { async run(_prompt, { signal }) {",
      '  console.log("ready");',
      '  await exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal });',
      "} };",
      "const ok = { async run() { return 'ok'; } };",
      "await main(process.argv.slice(1), { codex: stall, claude: ok, agy: ok });",
    ].join("\n");
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runner,
          "--",
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
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await within(
        new Promise((resolve) =>
          child.stdout.on("data", (chunk) => /ready/.test(chunk) && resolve()),
        ),
        20_000,
        "The stalled turn start",
      );
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 20_000, "The CLI exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
      expect(transcript.exitCode).toBe(130);
      expect(transcript.error).toContain("Interrupted by SIGINT");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(repo);
    }
  },
  60_000,
);

// Usefulness: acceptance (#669) — the SIGINT listener stays registered while the run handles the
// first signal, so the exit handler of execa finds another listener and does not re-raise it.
// Holds on every platform, unlike the real-signal case above.
test("the SIGINT listener of a run stays registered after the signal fires", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const before = process.listenerCount("SIGINT");
  let during;
  const fakeAgents = {
    codex: {
      async run() {
        process.emit("SIGINT");
        during = process.listenerCount("SIGINT");
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
    },
    claude: {
      async run() {
        return "ok";
      },
    },
    agy: {
      async run() {
        return "ok";
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
        "t",
        "--cwd",
        repo,
      ],
      fakeAgents,
    );
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

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

const CONTINUE_BASE = [
  "--orchestrator",
  "codex",
  "--worker",
  "claude",
  "--reviewer",
  "agy",
  "--task",
  "long task",
];
const CONTINUE_ROLES = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy"];
const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

// Runs `fn(repo, transcriptPath, errorSpy)` with a clean exit-code and error state. The
// repo is a directory with a `.git` directory and `git` is answered from memory
// (`cleanRepoGit`), so the test starts no `git` process.
async function withContinueRepo(fn) {
  const repo = await mkdtemp(join(tmpdir(), "cli-test-clean-repo-"));
  await mkdir(join(repo, ".git"));
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

// Each fake agent assigns a session id on its first call, as a real adapter does,
// and records the id it held when the call arrived.
function sessionAgents(orchReplies, seen) {
  let orchCall = 0;
  const adapter = (name, reply) => ({
    async run(state, prompt) {
      seen[name].push({ sessionId: state.sessionId, prompt });
      state.sessionId ??= `${name}-session`;
      return reply(prompt);
    },
  });
  return {
    codex: adapter("codex", () => orchReplies[orchCall++]),
    claude: adapter("claude", () => "worker ok"),
    agy: adapter("agy", () => "reviewer ok"),
  };
}

// Usefulness: verifies --continue-from resumes the earlier orchestrator, worker,
// and reviewer sessions with a new step budget, and records the source (#362).
test("--continue-from resumes the earlier role sessions with a new budget", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    const review = JSON.stringify({ action: "run_reviewer", prompt: "r" });
    const seen = { codex: [], claude: [], agy: [] };
    const first = sessionAgents([work, review, work], seen);
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "2", "--transcript", transcriptPath],
      first,
    );
    expect(process.exitCode).toBe(2);
    expect(seen.codex.map((call) => call.sessionId)).toEqual([
      null,
      "codex-session",
      "codex-session",
    ]);

    const second = { codex: [], claude: [], agy: [] };
    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--max-steps",
        "3",
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([review, FINISH], second),
    );

    expect(process.exitCode).toBe(0);
    expect(second.codex[0].sessionId).toBe("codex-session");
    expect(second.codex[0].prompt).toMatch(/continues an earlier run/i);
    expect(second.agy[0].sessionId).toBe("agy-session");
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.options.continueFrom).toBe(transcriptPath);
    expect(transcript.options.maxSteps).toBe(3);
    expect(transcript.roles.worker.sessionId).toBe("claude-session");
  });
});

// Usefulness: verifies a pre-assigned worker session id is in the transcript before the CLI runs,
// with its unconfirmed mark, so a parent killed during a first turn leaves a record that
// --continue-from resumes after the ownership check (#564). No other test reads the transcript
// mid-turn.
test("a pre-assigned session id reaches the transcript before the turn and --continue-from restores it", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    let midTurn = null;
    const agents = sessionAgents([work], { codex: [], claude: [], agy: [] });
    agents.claude = {
      async run(state, _prompt, options) {
        state.sessionUnconfirmed = true;
        await options.onSessionAssigned("pre-worker");
        midTurn = await readFile(transcriptPath, "utf8");
        throw new Error("parent killed");
      },
    };
    await main([...CONTINUE_BASE, "--cwd", repo, "--transcript", transcriptPath], agents);

    const record = JSON.parse(midTurn);
    expect(record.roles.worker).toMatchObject({
      sessionId: "pre-worker",
      sessionUnconfirmed: true,
    });
    expect(record.roles.reviewer.sessionId).toBeNull();

    // The mid-turn file is what a kill leaves behind.
    await writeFile(transcriptPath, midTurn);
    let resumed = null;
    const next = sessionAgents([work, FINISH], { codex: [], claude: [], agy: [] });
    next.claude = {
      async run(state) {
        resumed = { sessionId: state.sessionId, unconfirmed: state.sessionUnconfirmed };
        return "worker ok";
      },
    };
    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      next,
    );
    expect(resumed).toEqual({ sessionId: "pre-worker", unconfirmed: true });
  });
});

// Usefulness: verifies --continue-from refuses, before any turn, a claude session that a live
// process still holds (#647), through the real process table. No other CLI test starts a holder.
test("--continue-from refuses a claude session that a live process holds", async (ctx) => {
  // A sandbox can deny the process table (ADR 0019: `ps` exits 127 with `operation not permitted`).
  // The read then fails, the check fails open, and the run exits 0. The test fails only when the
  // read works and the refusal is missing.
  if (!processTableReadable) {
    ctx.skip("The host process table cannot be read, so the check fails open here.");
  }
  const heldId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--transcript", transcriptPath],
      sessionAgents([work, FINISH], { codex: [], claude: [], agy: [] }),
    );
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    transcript.roles.worker.sessionId = heldId;
    await writeFile(transcriptPath, JSON.stringify(transcript));
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", heldId], {
      stdio: "ignore",
    });
    try {
      const seen = { codex: [], claude: [], agy: [] };
      await main(
        [...CONTINUE_BASE, "--cwd", repo, "--continue-from", transcriptPath],
        sessionAgents([FINISH], seen),
      );
      expect(process.exitCode).toBe(1);
      expect(seen.codex).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

// Usefulness: verifies the transcript carries the gate state across --continue-from through the
// CLI (#393): a reviewer accept recorded by the first run satisfies --require-accept in the
// continued run on the unchanged tree, so the continued run dispatches no reviewer.
test("--continue-from restores the recorded reviewer accept on an unchanged tree", async () => {
  const repo = await createTempRepo();
  // Outside the work tree: a transcript inside it is an untracked file that changes the tree.
  const transcriptDir = await mkdtemp(join(tmpdir(), "cli-test-gate-transcript-"));
  const transcriptPath = join(transcriptDir, "run.json");
  const origExitCode = process.exitCode;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const accept = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";
    const reviewerCalls = [];
    const agents = (orchReplies, reviewerReply) => {
      let call = 0;
      return {
        codex: { run: async () => orchReplies[call++] },
        claude: { run: async () => "worker ok" },
        agy: {
          run: async () => {
            reviewerCalls.push(reviewerReply);
            return reviewerReply;
          },
        },
      };
    };
    const args = [
      ...CONTINUE_BASE,
      "--cwd",
      repo,
      "--require-accept",
      "--transcript",
      transcriptPath,
    ];
    await main(
      args,
      agents(
        [
          JSON.stringify({ action: "run_worker", prompt: "w" }),
          JSON.stringify({ action: "run_reviewer", prompt: "r" }),
          FINISH,
        ],
        accept,
      ),
    );
    expect(process.exitCode).toBe(0);
    expect(reviewerCalls.length).toBe(1);

    await main([...args, "--continue-from", transcriptPath], agents([FINISH], accept));
    expect(process.exitCode).toBe(0);
    expect(reviewerCalls.length).toBe(1);
  } finally {
    process.exitCode = origExitCode;
    logSpy.mockRestore();
    await removePath(repo);
    await removePath(transcriptDir);
  }
});

// Usefulness: verifies an edited transcript cannot bypass --require-accept (#393 review): a
// forged `gate` record that claims an accept is ignored, because the restore reads only the
// reviewer and worker result events, and the last reviewer turn here rejected.
test("--continue-from ignores a forged gate record that claims an accept", async () => {
  const repo = await createTempRepo();
  const transcriptDir = await mkdtemp(join(tmpdir(), "cli-test-gate-transcript-"));
  const transcriptPath = join(transcriptDir, "run.json");
  const origExitCode = process.exitCode;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const reject = "Conclusion: no.\nWhy: no.\nBlockers: none.\nChecks: t\nVerdict: reject";
    const accept = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";
    const reviewerReplies = [reject, accept];
    let reviewerCalls = 0;
    const agents = (orchReplies) => {
      let call = 0;
      return {
        codex: { run: async () => orchReplies[call++] },
        claude: { run: async () => "worker ok" },
        agy: { run: async () => reviewerReplies[reviewerCalls++] },
      };
    };
    const args = [
      ...CONTINUE_BASE,
      "--cwd",
      repo,
      "--require-accept",
      "--transcript",
      transcriptPath,
    ];
    await main(
      args,
      agents([
        JSON.stringify({ action: "run_worker", prompt: "w" }),
        JSON.stringify({ action: "run_reviewer", prompt: "r" }),
        FINISH,
      ]),
    );
    expect(process.exitCode).toBe(1);

    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    const reviewed = transcript.events.findLast(
      (event) => event.type === "result" && event.role === "reviewer",
    ).result.reviewed;
    transcript.gate = {
      workerRan: true,
      reviewerRan: true,
      reviewerTurnDispatched: true,
      acceptedSinceWorker: true,
      lastReviewed: reviewed,
    };
    await writeFile(transcriptPath, JSON.stringify(transcript));

    await main(
      [...args, "--continue-from", transcriptPath],
      agents([FINISH, JSON.stringify({ action: "run_reviewer", prompt: "r" }), FINISH]),
    );
    expect(process.exitCode).toBe(0);
    expect(reviewerCalls).toBe(2);
  } finally {
    process.exitCode = origExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
    await removePath(repo);
    await removePath(transcriptDir);
  }
});

const GATE_ACCEPT = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";
const GATE_REJECT = "Conclusion: no.\nWhy: no.\nBlockers: none.\nChecks: t\nVerdict: reject";
const RUN_WORKER = JSON.stringify({ action: "run_worker", prompt: "w" });
const RUN_REVIEWER = JSON.stringify({ action: "run_reviewer", prompt: "r" });

// Runs a --require-accept headless run whose reviewer replies come from `reviewerReplies`,
// lets `tamper(transcript)` edit the written transcript, then continues it with a finish that
// the gate refuses unless it restored an accept. Returns the reviewer calls of the continuation
// and the exit code. The transcript sits outside the work tree, so the tree stays unchanged.
async function continueAfterEdit({ firstOrch, reviewerReplies, tamper }) {
  const repo = await createTempRepo();
  const transcriptDir = await mkdtemp(join(tmpdir(), "cli-test-gate-transcript-"));
  const transcriptPath = join(transcriptDir, "run.json");
  const origExitCode = process.exitCode;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let reviewerCalls = 0;
    const agents = (orchReplies) => {
      let call = 0;
      return {
        codex: { run: async () => orchReplies[call++] },
        claude: { run: async () => "worker ok" },
        agy: { run: async () => reviewerReplies[reviewerCalls++] ?? GATE_ACCEPT },
      };
    };
    const args = [
      ...CONTINUE_BASE,
      "--cwd",
      repo,
      "--require-accept",
      "--transcript",
      transcriptPath,
    ];
    await main(args, agents(firstOrch));
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    tamper(transcript);
    await writeFile(transcriptPath, JSON.stringify(transcript));
    const before = reviewerCalls;
    await main(
      [...args, "--continue-from", transcriptPath],
      agents([FINISH, RUN_REVIEWER, FINISH]),
    );
    return { exitCode: process.exitCode, reviewerCalls: reviewerCalls - before };
  } finally {
    process.exitCode = origExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
    await removePath(repo);
    await removePath(transcriptDir);
  }
}

const ACCEPTED_RUN = [RUN_WORKER, RUN_REVIEWER, FINISH];

// Usefulness: verifies an incomplete later turn cancels the restore (#393 review): a worker turn
// that started after the accept and never returned a result (a canceled or failed turn) can have
// changed the tree, so the continuation needs a new reviewer turn.
test("--continue-from resets when a worker invocation follows the accepted review", async () => {
  const { exitCode, reviewerCalls } = await continueAfterEdit({
    firstOrch: ACCEPTED_RUN,
    reviewerReplies: [GATE_ACCEPT],
    tamper: (transcript) => {
      const gate = transcript.events.pop();
      transcript.events.push({ type: "invocation", role: "worker", status: "error" }, gate);
    },
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Usefulness: verifies a transcript whose later reviewer result was deleted does not restore the
// earlier accept (#393 review): the recorded result count no longer matches the events.
test("--continue-from resets when a result event was deleted", async () => {
  const { exitCode, reviewerCalls } = await continueAfterEdit({
    firstOrch: [RUN_WORKER, RUN_REVIEWER, RUN_REVIEWER, FINISH, FINISH],
    reviewerReplies: [GATE_ACCEPT, GATE_REJECT],
    tamper: (transcript) => {
      const last = transcript.events.findLastIndex((event) => event.type === "result");
      transcript.events.splice(last, 1);
    },
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Usefulness: verifies an earlier result event with an unknown role resets (#393 review). The
// replay accepts only `worker` and `reviewer` result events, so the edit cannot hide the worker
// turn that makes a reviewer reject count as a review of work.
test("--continue-from resets when an earlier result event has a malformed role", async () => {
  const { exitCode, reviewerCalls } = await continueAfterEdit({
    firstOrch: [RUN_WORKER, RUN_REVIEWER, FINISH, FINISH],
    reviewerReplies: [GATE_REJECT],
    tamper: (transcript) => {
      transcript.events.find((event) => event.type === "result" && event.role === "worker").role =
        "wrk";
    },
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Usefulness: verifies reordered reviewer results cannot let an obsolete accept replace the
// latest rejection (#393 review): the replay in file order ends on the rewritten accept, which
// differs from the state the run recorded, so the gate resets.
test("--continue-from resets when reviewer results were reordered", async () => {
  const { exitCode, reviewerCalls } = await continueAfterEdit({
    firstOrch: [RUN_WORKER, RUN_REVIEWER, RUN_REVIEWER, FINISH, FINISH],
    reviewerReplies: [GATE_ACCEPT, GATE_REJECT],
    tamper: (transcript) => {
      const at = transcript.events.flatMap((event, i) =>
        event.type === "result" && event.role === "reviewer" ? [i] : [],
      );
      const [a, b] = at;
      [transcript.events[a], transcript.events[b]] = [transcript.events[b], transcript.events[a]];
    },
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Usefulness: verifies a transcript with no gate record resets, as every transcript did before
// the restore existed (#393 review), even when its events end on a reviewer accept.
test("--continue-from resets when the transcript has no gate record", async () => {
  const { exitCode, reviewerCalls } = await continueAfterEdit({
    firstOrch: ACCEPTED_RUN,
    reviewerReplies: [GATE_ACCEPT],
    tamper: (transcript) => {
      transcript.events = transcript.events.filter((event) => event.type !== "gate");
    },
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Runs continueAfterEdit with `edit` applied to the last reviewer result event.
async function continueAfterResultEdit(edit) {
  return continueAfterEdit({
    firstOrch: ACCEPTED_RUN,
    reviewerReplies: [GATE_ACCEPT],
    tamper: (transcript) => {
      edit(transcript.events.findLast((e) => e.type === "result" && e.role === "reviewer").result);
    },
  });
}

// Usefulness: verifies a null reviewer response in the events the restore reads resets instead
// of aborting the run (#393 review). One edit per test keeps each inside the test timeout (#556).
test("--continue-from resets, and does not abort, on a null reviewer response", async () => {
  const { exitCode, reviewerCalls } = await continueAfterResultEdit((result) => {
    result.response = null;
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Usefulness: verifies a reviewed head that is not a string resets instead of aborting the run
// (#393 review). Separate from the null-response case so each fits the test timeout (#556).
test("--continue-from resets, and does not abort, on a non-string reviewed head", async () => {
  const { exitCode, reviewerCalls } = await continueAfterResultEdit((result) => {
    result.reviewed.head = { not: "a head" };
  });
  expect(exitCode).toBe(0);
  expect(reviewerCalls).toBe(1);
});

// Usefulness: verifies a changed role kind or model is refused before any turn
// runs, and that the refusal leaves the earlier transcript unchanged even when
// --transcript names the same file (#362).
test("--continue-from refuses a changed role and keeps the transcript", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const seen = { codex: [], claude: [], agy: [] };
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], seen),
    );
    const before = await readFile(transcriptPath, "utf8");

    const calls = { codex: [], claude: [], agy: [] };
    const changed = [
      [
        ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "codex"],
        "reviewer was agy in the earlier run, not codex",
      ],
      [
        [...CONTINUE_ROLES, "--worker-model", "opus"],
        'worker model was (omitted) in the earlier run, not "opus"',
      ],
    ];
    for (const [roleArgs, message] of changed) {
      errorSpy.mockClear();
      await main(
        [
          ...roleArgs,
          "--task",
          "long task",
          "--cwd",
          repo,
          "--continue-from",
          transcriptPath,
          "--transcript",
          transcriptPath,
        ],
        sessionAgents([FINISH], calls),
      );
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(message);
    }
    expect(calls.codex).toEqual([]);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);
  });
});

// Usefulness: verifies a CLI default that resolves to another model than the earlier run recorded
// is refused before any turn of the run and leaves the transcript unchanged, and an unchanged model
// continues (#394).
test("--continue-from refuses a changed resolved model and keeps the transcript", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    const reporting = (model, seen) => {
      const agents = sessionAgents([work, FINISH], seen);
      const run = agents.claude.run;
      agents.claude.run = async (state, prompt, options) => {
        state.resolvedModel = model;
        return run(state, prompt, options);
      };
      return agents;
    };
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      reporting("model-1", { codex: [], claude: [], agy: [] }),
    );
    const before = await readFile(transcriptPath, "utf8");
    expect(JSON.parse(before).roles.worker.resolvedModel).toBe("model-1");

    const args = [
      ...CONTINUE_BASE,
      "--cwd",
      repo,
      "--continue-from",
      transcriptPath,
      "--transcript",
      transcriptPath,
    ];
    const changed = { codex: [], claude: [], agy: [] };
    await main(args, reporting("model-2", changed));
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      'worker resolved to "model-1" in the earlier run, not "model-2"',
    );
    expect(changed.codex).toEqual([]);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);

    process.exitCode = undefined;
    await main(args, reporting("model-1", { codex: [], claude: [], agy: [] }));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(await readFile(transcriptPath, "utf8")).roles.worker.resolvedModel).toBe(
      "model-1",
    );
  });
});

// Runs a first headless run that stops on the step limit, then records a resolved model for the
// worker in its transcript, as a Claude or Copilot turn would. `fn(repo, transcriptPath, errorSpy)`
// then continues it.
async function withRecordedModel(fn, recordedModel = "model-1") {
  const repo = await createTempRepo();
  const transcriptPath = join(await mkdtemp(join(tmpdir(), "cli-test-probe-")), "run.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], { codex: [], claude: [], agy: [] }),
    );
    const recorded = JSON.parse(await readFile(transcriptPath, "utf8"));
    recorded.roles.worker.resolvedModel = recordedModel;
    await writeFile(transcriptPath, JSON.stringify(recorded));
    process.exitCode = undefined;
    await fn(repo, transcriptPath, errorSpy);
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    logSpy.mockRestore();
    await removePath(repo);
    await removePath(dirname(transcriptPath));
  }
}

const continueArgs = (repo, transcriptPath) => [
  ...CONTINUE_BASE,
  "--cwd",
  repo,
  "--continue-from",
  transcriptPath,
  "--transcript",
  transcriptPath,
];

// Usefulness: the resolved-model probe runs under the mutation check of a child turn, so a probe
// that changes the work tree halts the continuation with exit 1 before any turn, and the earlier
// transcript stays whole (#394).
test("--continue-from halts when the probe changes the work tree", async () => {
  await withRecordedModel(async (repo, transcriptPath, errorSpy) => {
    const before = await readFile(transcriptPath, "utf8");
    const seen = { codex: [], claude: [], agy: [] };
    const agents = sessionAgents([FINISH], seen);
    agents.claude.run = async () => {
      await writeFile(join(repo, "probe-leak.txt"), "leak\n");
      return "OK";
    };
    await main(continueArgs(repo, transcriptPath), agents);
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toMatch(/mutat/i);
    expect(seen.codex).toEqual([]);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);
  });
});

// Usefulness: after a turn that named no single model (recorded null), an unchanged model B must not be
// refused, and a B-to-A change must not be compared against a stale A. The run continues, tells the
// operator that the check did not run, and starts no probe (#394).
test.each([["model-1"], ["model-2"]])(
  "--continue-from compares nothing after an unresolved turn, probe would say %s",
  async (probeModel) => {
    await withRecordedModel(async (repo, transcriptPath, errorSpy) => {
      const seen = { codex: [], claude: [], agy: [] };
      const work = JSON.stringify({ action: "run_worker", prompt: "w" });
      const agents = sessionAgents([work, FINISH], seen);
      const run = agents.claude.run;
      agents.claude.run = async (state, prompt, options) => {
        state.resolvedModel = probeModel;
        return run(state, prompt, options);
      };
      await main(continueArgs(repo, transcriptPath), agents);
      // The only Claude call resumes the earlier session: no probe (a new session) ran.
      expect(seen.claude.map((call) => call.sessionId)).toEqual(["claude-session"]);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(
        /did not run for worker \(claude\), because the latest turn of the earlier run did not name one model/,
      );
      expect(errorSpy.mock.calls.flat().join("\n")).not.toMatch(/resolved to/);
    }, null);
  },
);

// Usefulness: a SIGINT during the probe cancels it through the run's signal and refuses the
// continuation with exit 130, before any turn, leaving the earlier transcript whole (#394).
test("--continue-from cancels a probe on SIGINT and exits 130", async () => {
  await withRecordedModel(async (repo, transcriptPath) => {
    const before = await readFile(transcriptPath, "utf8");
    const seen = { codex: [], claude: [], agy: [] };
    const agents = sessionAgents([FINISH], seen);
    let probeSignal;
    agents.claude.run = async (_state, _prompt, options) => {
      probeSignal = options.signal;
      process.emit("SIGINT");
      const err = new Error("canceled");
      err.isCanceled = true;
      throw err;
    };
    const listenersBefore = process.listenerCount("SIGINT");
    await main(continueArgs(repo, transcriptPath), agents);
    expect(process.exitCode).toBe(130);
    expect(probeSignal?.aborted).toBe(true);
    expect(seen.codex).toEqual([]);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });
});

// Usefulness: verifies a real SIGINT during a stalled process-table read ends the continued run
// with exit 130 before any turn, and ends the read's shim, so the holder check cannot defeat
// cancellation (#647). A child process is needed: a real signal exercises the exit handler of execa.
test.skipIf(process.platform === "win32")(
  "--continue-from exits 130 on SIGINT during a stalled holder check",
  async () => {
    const shim = await createPsShim("__STALL__");
    let repo;
    let child;
    try {
      repo = await createTempRepo();
      const role = (kind, sessionId) => ({ kind, model: null, effort: null, sessionId });
      const transcript = join(shim.dir, "run.json");
      await writeFile(
        transcript,
        JSON.stringify({
          task: "long task",
          cwd: repo,
          roles: {
            orchestrator: role("codex", null),
            worker: role("claude", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
            reviewer: role("agy", null),
          },
          events: [],
        }),
      );
      child = spawn(
        process.execPath,
        [CLI, ...CONTINUE_BASE, "--cwd", repo, "--continue-from", transcript],
        {
          env: { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH}` },
          stdio: "ignore",
        },
      );
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      // The shim beats only after the read started, so the signal cancels a running read.
      await shim.ready();
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 15_000, "The CLI exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      // The cancel ends the shim before its 10 s ceiling (11.2 s at most).
      expect(await shim.heartbeatStopped()).toBe(true);
    } finally {
      // Ends only the child that this test spawned, through its handle, when it still runs.
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await shim.cleanup();
      if (repo) {
        await removePath(repo);
      }
    }
  },
  30_000,
);

// Usefulness: verifies --continue-from takes a value, in both forms.
test("--continue-from requires a value and accepts the inline form", () => {
  expect(() => parseArgs([...CONTINUE_BASE, "--continue-from"])).toThrow();
  expect(parseArgs([...CONTINUE_BASE, "--continue-from=run.json"]).continueFrom).toMatch(
    /run\.json$/,
  );
  expect(parseArgs(CONTINUE_BASE).continueFrom).toBeNull();
});

// Usefulness: verifies a continuation whose --transcript names the --continue-from
// file keeps every earlier event, in order, and appends the new ones after them
// (#362 review). The earlier run's outcome is kept in a boundary event.
test("--continue-from with the same --transcript path keeps the earlier events", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    const review = JSON.stringify({ action: "run_reviewer", prompt: "r" });
    const seen = { codex: [], claude: [], agy: [] };
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], seen),
    );
    const earlier = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(earlier.exitCode).toBe(2);
    expect(earlier.events.length).toBeGreaterThan(0);

    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--max-steps",
        "2",
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([review, FINISH], { codex: [], claude: [], agy: [] }),
    );

    const after = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(after.events.slice(0, earlier.events.length)).toEqual(earlier.events);
    const boundary = after.events[earlier.events.length];
    expect(boundary).toMatchObject({
      type: "continued",
      earlier: { exitCode: 2, error: "Step limit reached with work remaining." },
    });
    expect(after.events.slice(earlier.events.length + 1).map((event) => event.type)).toContain(
      "result",
    );
    expect(after.exitCode).toBe(0);
  });
});

// Usefulness: verifies a different --transcript path holds only the new run's events.
test("--continue-from with another --transcript path records only the new events", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], { codex: [], claude: [], agy: [] }),
    );
    const next = join(repo, "next.json");
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--continue-from", transcriptPath, "--transcript", next],
      sessionAgents([FINISH], { codex: [], claude: [], agy: [] }),
    );
    const after = JSON.parse(await readFile(next, "utf8"));
    expect(after.events.some((event) => event.type === "continued")).toBe(false);
  });
});

// Usefulness: verifies a large earlier event is read and kept whole by a same-path
// continuation: no size limit, truncation, or split (#362 review).
test("--continue-from keeps a large earlier event whole", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], { codex: [], claude: [], agy: [] }),
    );
    const earlier = JSON.parse(await readFile(transcriptPath, "utf8"));
    const big = `${"x".repeat(8 * 1024 * 1024)}\n${"é😀".repeat(1000)}end`;
    earlier.events.push({ type: "result", role: "worker", result: { response: big }, at: "t" });
    await writeFile(transcriptPath, JSON.stringify(earlier, null, 2), "utf8");

    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([FINISH], { codex: [], claude: [], agy: [] }),
    );

    const after = JSON.parse(await readFile(transcriptPath, "utf8"));
    const kept = after.events[earlier.events.length - 1];
    expect(kept.result.response.length).toBe(big.length);
    expect(kept.result.response === big).toBe(true);
  });
});

// Well above the smallest spread that threw in a standalone bisection of
// [].push(...list, {}): 124,862 elements on Node v26.8.1 and 125,217 on Node
// v22.23.3. With a spread restored at the call site in src/cli.mjs, this test
// failed on both versions at this count.
const EARLIER_EVENTS = 500_000;

// Usefulness: verifies a same-path continuation reads a written transcript with
// more events than an argument spread can pass, and rewrites it with every earlier
// event in order, then the boundary event. The earlier transcript is written
// directly, so one run of the real read-and-write path is all the test pays for.
test("--continue-from rewrites a large written transcript with every earlier event", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const role = (kind) => ({ kind, model: null, effort: null, sessionId: "s" });
    const events = Array.from({ length: EARLIER_EVENTS }, (_, index) => ({
      type: "e",
      index,
    }));
    await writeFile(
      transcriptPath,
      JSON.stringify({
        task: "long task",
        cwd: repo,
        options: { maxSteps: 1 },
        roles: { orchestrator: role("codex"), worker: role("claude"), reviewer: role("agy") },
        events,
        exitCode: 2,
        error: "Step limit reached with work remaining.",
      }),
      "utf8",
    );

    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([FINISH], { codex: [], claude: [], agy: [] }),
    );

    expect(process.exitCode).toBe(0);
    const after = JSON.parse(await readFile(transcriptPath, "utf8"));
    const count = EARLIER_EVENTS;
    expect(after.events[0].index).toBe(0);
    expect(after.events[count - 1].index).toBe(count - 1);
    expect(after.events[count].type).toBe("continued");
    expect(after.events.length).toBeGreaterThan(count + 1);
  });
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
