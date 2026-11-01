import { tmpdir } from "node:os";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { main, parseArgs } from "../src/cli.mjs";
import { createBodyBarrier } from "./body-barrier.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";
import { prGateGh } from "./gh-doubles.mjs";

// Tests that spy on console.error and read process.exitCode run through the barrier. A body that
// passes its timeout under load keeps running, and its late cleanup would clear the spy calls and
// exit code of the next test (issue #935). Waiting here, not in each test, bounds that for all of
// them. The wait outlasts testTimeout, so a body that ends late still ends before the next test. A
// body that never ends costs one wait, then every later test fails at once naming it.
const bodyBarrier = createBodyBarrier();
beforeEach(() => bodyBarrier.settled(), 60_000);
const spyTest = (name, body) => test(name, () => bodyBarrier.run(body, name));

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

// Usefulness: verifies the headless loop takes a PR number for the finish gate and defaults it off.
// It rejects any value that is not a positive integer. A bad PR number then fails at parse time,
// not inside the gate (issue #293).
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

// Usefulness: verifies the run PR declaration takes a positive integer and defaults to absent. It
// rejects any other value, so a run cannot declare a PR that the gate cannot read (issue #302).
test("--pr declares the run PR and takes a positive integer", () => {
  expect(parseArgs(BASE).pr).toBeNull();
  expect(parseArgs([...BASE, "--pr", "42"]).pr).toBe(42);
  expect(parseArgs([...BASE, "--pr=7"]).pr).toBe(7);
  for (const bad of ["0", "abc"]) {
    expect(() => parseArgs([...BASE, "--pr", bad])).toThrow("--pr must be a positive integer.");
  }
});

// Usefulness: verifies the headless loop takes the test command and its bound, and defaults both
// off. It refuses a blank command, a bound with no command, and a bound that is not a positive
// integer. A bad value fails at parse time, so the run never starts with a command that it cannot
// run (issue #420).
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

// Usefulness: verifies the headless loop takes --reviewer-sandbox with the two opt-in modes. The
// mode is unset by default. Another value or a non-Codex reviewer is refused, so the flag never
// silently does nothing while the prompt says it is on (ADR 0038).
test("--reviewer-sandbox parses both modes, defaults unset, and needs a Codex reviewer", () => {
  expect(parseArgs(BASE).reviewerSandbox).toBeNull();
  const codexReviewer = BASE.map((v) => (v === "agy" ? "codex" : v));
  for (const mode of ["read-only", "workspace-write"]) {
    expect(parseArgs([...codexReviewer, "--reviewer-sandbox", mode]).reviewerSandbox).toBe(mode);
    expect(parseArgs([...codexReviewer, `--reviewer-sandbox=${mode}`]).reviewerSandbox).toBe(mode);
  }
  expect(() => parseArgs([...codexReviewer, "--reviewer-sandbox", "none"])).toThrow(
    "--reviewer-sandbox must be one of read-only, workspace-write, got: none",
  );
  expect(() => parseArgs([...BASE, "--reviewer-sandbox", "read-only"])).toThrow(
    "--reviewer-sandbox requires --reviewer codex.",
  );
});

// Usefulness: verifies the kept alias means --reviewer-sandbox workspace-write, so existing scripts
// keep their meaning. A conflicting pair is refused in either order (ADR 0038).
test("--reviewer-workspace-write stays an alias of --reviewer-sandbox workspace-write", () => {
  const codexReviewer = BASE.map((v) => (v === "agy" ? "codex" : v));
  expect(parseArgs([...codexReviewer, "--reviewer-workspace-write"]).reviewerSandbox).toBe(
    "workspace-write",
  );
  expect(
    parseArgs([
      ...codexReviewer,
      "--reviewer-workspace-write",
      "--reviewer-sandbox",
      "workspace-write",
    ]).reviewerSandbox,
  ).toBe("workspace-write");
  for (const pair of [
    ["--reviewer-workspace-write", "--reviewer-sandbox", "read-only"],
    ["--reviewer-sandbox", "read-only", "--reviewer-workspace-write"],
  ]) {
    expect(() => parseArgs([...codexReviewer, ...pair])).toThrow(
      "--reviewer-workspace-write conflicts with --reviewer-sandbox read-only.",
    );
  }
  expect(() => parseArgs([...BASE, "--reviewer-workspace-write"])).toThrow(
    "--reviewer-sandbox requires --reviewer codex.",
  );
  expect(() => parseArgs([...codexReviewer, "--reviewer-workspace-write=1"])).toThrow(
    "--reviewer-workspace-write does not take a value.",
  );
});

// Usefulness: verifies the headless path refuses a gate for another pull request at parse time. The
// refusal comes before any child turn runs and before the prompt is built. Both flags arrive on one
// command line there. A run that can never be gated never starts, so the prompt never has to
// describe a case it cannot reach. A matching gate is still accepted, and `--pr` alone is still
// accepted (issue #302).
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

// Usefulness: verifies a review-only headless run refuses --pr, --require-accept, and --require-ci
// before any child turn runs, with the interactive wordings. The two paths state one rule for a
// mode that can never reach a gate. The check is the command outcome: exit 1, the refusal on
// stderr, and no child CLI call (issue #337).
spyTest("a review-only run refuses the PR flags before any child turn", async () => {
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
  // The refusal comes from `parseArgs`, before any Git validation, so the run needs no repo.
  // Creating a repo spawns six `git` processes, which is most of the cost of a run on Windows.
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

// Usefulness: verifies a work-first or review-first run still takes the PR flags that the
// review-only run refuses. A run with no --mode takes them too, because only review-only rejects a
// gate. The check is the command outcome: the run starts, so the orchestrator CLI is called and no
// usage error is printed (issue #337).
spyTest("the other modes and a mode-free run still take the PR flags", async () => {
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // One repo serves every run, and no run here changes it. Creating a repo spawns six `git`
  // processes, which is most of the cost of a run on Windows.
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
        // The gate is declared but never evaluated. This orchestrator finishes with no reviewer
        // turn. The gate refuses, and the run ends on exit 1 with a gate reason, not a usage error.
        await main([...BASE, ...flags, "--pr", "42", "--require-ci", "42", "--cwd", repo], agents, {
          gh: prGateGh("1".repeat(40)),
        });
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

// Usefulness: verifies the headless --mode accepts the same three values as the interactive path
// and refuses any other. A caller learns the mode names from one list on both paths. The check is
// the command outcome: a known value starts the run, and an unknown one exits 1 with the message
// (issue #337).
spyTest("--mode takes the interactive mode values", async () => {
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

// Usefulness: verifies a repeated --mode takes the last value, as every other repeated single-value
// flag on this path does, such as --task. The flag adds no new rule. The check is the command
// outcome: the last value decides. Review-only last refuses the PR flag, and work-first last
// accepts it (issue #337).
spyTest("a repeated --mode takes the last value", async () => {
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
        { gh: prGateGh("1".repeat(40)) },
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

// Usefulness: verifies acceptance (#210). An empty inline value is rejected at parse time, as the
// space-separated form is, so a no-op flag value cannot pass through silently.
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

// Usefulness: verifies acceptance (#215). An empty inline value on a boolean flag is rejected as a
// value on a no-value flag, not as a missing value.
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

// Usefulness: acceptance (#816) — a role fault is reported before a --task and --task-file conflict,
// the order of the headless command, so the shared composition does not reorder the path-only check.
test("a missing role is reported before the task source conflict", () => {
  expect(() =>
    parseArgs([
      "--orchestrator",
      "codex",
      "--reviewer",
      "agy",
      "--task",
      "work",
      "--task-file",
      "task.txt",
    ]),
  ).toThrow("Missing required --worker.");
});

// Usefulness: verifies the headless --compare-head takes a positive integer PR number, as --pr and
// --require-ci do, so a bad value fails before any run starts (issue #1104).
test("--compare-head takes a positive integer PR number", () => {
  expect(parseArgs([...BASE]).compareHead).toBeNull();
  expect(parseArgs([...BASE, "--compare-head", "42"]).compareHead).toBe(42);
  expect(parseArgs([...BASE, "--compare-head=7"]).compareHead).toBe(7);
  for (const bad of ["0", "1.5", "abc"]) {
    expect(() => parseArgs([...BASE, "--compare-head", bad])).toThrow(
      "--compare-head must be a positive integer.",
    );
  }
});

// Usefulness: verifies --compare-head is refused with --pr, --require-ci, and --mode review-only
// before the run starts, because each of them settles the PR head by a gate or has no PR work
// (issue #1104).
test("--compare-head conflicts with --pr, --require-ci, and review-only", () => {
  for (const other of [
    ["--pr", "42"],
    ["--require-ci", "42"],
  ]) {
    expect(() => parseArgs([...BASE, "--compare-head", "42", ...other])).toThrow(
      "--compare-head cannot be combined with --pr or --require-ci",
    );
  }
  expect(() => parseArgs([...BASE, "--mode", "review-only", "--compare-head", "42"])).toThrow(
    "--compare-head compares a PR head, and review-only has no PR work",
  );
});
