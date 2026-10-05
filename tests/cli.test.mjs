import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

// Answers `git` from memory for the tests that switch it on (see
// `withContinueRepo`); every other test reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { execa } from "execa";
import { main, parseArgs } from "../src/cli.mjs";
import { parseRoleArgs } from "../src/role.mjs";
import { cleanRepoGit, createTempRepo, removePath } from "./runtime-helpers.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

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
    // One orchestrator CLI call, then its validated finish action.
    expect(transcript.events.map((event) => event.type)).toEqual(["invocation", "action"]);
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
// same event list a run without the flag wrote before it (issue #337).
test("a mode-free run writes the origin/main transcript shape", async () => {
  const runOnce = async (extra) => {
    const repo = await createTempRepo();
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
      await main([...BASE, ...extra, "--cwd", repo, "--transcript", transcriptPath], agents);
      return JSON.parse(await readFile(transcriptPath, "utf8"));
    } finally {
      process.exitCode = origExitCode;
      await removePath(repo);
    }
  };

  const modeFree = await runOnce([]);
  // origin/main wrote these keys, and no more, for a run that names no mode.
  expect(Object.keys(modeFree).sort()).toEqual(
    ["cwd", "error", "events", "exitCode", "options", "roles", "task"].sort(),
  );
  expect(Object.keys(modeFree.options).sort()).toEqual(
    ["maxSteps", "pr", "requireAccept", "requireCi", "timeout"].sort(),
  );
  expect(modeFree.events.map((event) => event.type)).toEqual(["invocation", "action"]);

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

// Runs `fn(repo, transcriptPath)` with a temp repo and clean exit-code and error state.
// With `inMemoryGit`, the repo is a directory with a `.git` directory and `git` is
// answered from memory (`cleanRepoGit`), so the test starts no `git` process.
async function withContinueRepo(fn, { inMemoryGit = false } = {}) {
  let repo;
  if (inMemoryGit) {
    repo = await mkdtemp(join(tmpdir(), "cli-test-clean-repo-"));
    await mkdir(join(repo, ".git"));
    gitDouble.answer = cleanRepoGit;
  } else {
    repo = await createTempRepo();
  }
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
  await withContinueRepo(
    async (repo, transcriptPath) => {
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
    },
    { inMemoryGit: true },
  );
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
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
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
  } finally {
    process.exitCode = origExitCode;
    await removePath(repo);
  }
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
