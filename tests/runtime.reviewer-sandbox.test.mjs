import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { exec } from "../src/lib/exec.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { runLoop } from "../src/runtime.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";

vi.mock("../src/lib/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(),
}));

// Behavior of the Codex reviewer sandbox modes (issue #421, ADR 0019, ADR 0038). Every role runs the real
// Codex adapter against a mocked CLI, so the assertions read the argv each turn received.

const READ_ONLY = 'sandbox_mode="read-only"';
const NO_SANDBOX = 'sandbox_mode="danger-full-access"';
const WORKSPACE_WRITE = 'sandbox_mode="workspace-write"';
const NETWORK_OFF = "sandbox_workspace_write.network_access=false";
const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };

const roles = {
  orchestrator: { kind: "codex", sessionId: null },
  worker: { kind: "codex", sessionId: null },
  reviewer: { kind: "codex", sessionId: null },
};

const reply = (text, thread) => ({
  stdout: [
    { type: "thread.started", thread_id: thread },
    { type: "item.completed", item: { type: "agent_message", text } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  stderr: "",
});

const repos = [];
afterEach(async () => {
  vi.mocked(exec).mockReset();
  for (const repo of repos.splice(0)) {
    await removePath(repo);
  }
});

/**
 * Runs orchestrator -> reviewer -> orchestrator(finish) and returns the argv and prompt of each
 * Codex call. `onReviewer(repo)` runs inside the reviewer turn.
 */
async function reviewerRun(options = {}, onReviewer = async () => {}) {
  const repo = await createTempRepo();
  repos.push(repo);
  const orchestratorTurns = [
    JSON.stringify({ action: "run_reviewer", prompt: "check it" }),
    JSON.stringify({ action: "finish", summary: SUMMARY }),
  ];
  const calls = [];
  vi.mocked(exec).mockImplementation(async (_cmd, args, opts) => {
    const isReviewer = opts.input.includes("Instructions:\ncheck it");
    calls.push({ role: isReviewer ? "reviewer" : "orchestrator", args, prompt: opts.input });
    if (isReviewer) {
      await onReviewer(repo);
      return reply("reviewed", "th-rev");
    }
    return reply(orchestratorTurns.shift(), "th-orch");
  });
  const run = () => runLoop({ task: "Task", cwd: repo, maxSteps: 5, roles, ...options });
  return { repo, calls, run };
}

const argsOf = (calls, role) => calls.filter((c) => c.role === role).map((c) => c.args.join(" "));

// Usefulness: verifies a run with no mode input gives the Codex reviewer no sandbox on a new and a
// resumed session, while every orchestrator turn keeps the read-only invocation (ADR 0038).
test("with no mode input the Codex reviewer runs with no sandbox and the orchestrator stays read-only", async () => {
  const { calls, run } = await reviewerRun();
  expect((await run()).exitCode).toBe(0);
  const [reviewer] = argsOf(calls, "reviewer");
  expect(reviewer).toContain(NO_SANDBOX);
  expect(reviewer).not.toContain(READ_ONLY);
  for (const args of argsOf(calls, "orchestrator")) {
    expect(args).toContain(READ_ONLY);
    expect(args).not.toContain("danger-full-access");
  }
});

// Usefulness: verifies each opt-in mode reproduces its present invocation on the reviewer turn only,
// and that the orchestrator turns stay read-only whatever the mode (ADR 0038, Guard 1 of #421).
test.each([
  ["read-only", [READ_ONLY], ["workspace-write", "danger-full-access", NETWORK_OFF]],
  ["workspace-write", [WORKSPACE_WRITE, NETWORK_OFF], [READ_ONLY, "danger-full-access"]],
])("with --reviewer-sandbox %s only the reviewer turn gets that mode", async (mode, has, lacks) => {
  const { calls, run } = await reviewerRun({ reviewerSandbox: mode });
  expect((await run()).exitCode).toBe(0);
  const [reviewer] = argsOf(calls, "reviewer");
  for (const part of has) expect(reviewer).toContain(part);
  for (const part of lacks) expect(reviewer).not.toContain(part);
  const orchestrator = argsOf(calls, "orchestrator");
  expect(orchestrator).toHaveLength(2);
  for (const args of orchestrator) {
    expect(args).toContain(READ_ONLY);
    expect(args).not.toContain("workspace-write");
    expect(args).not.toContain("danger-full-access");
  }
});

// Usefulness: verifies the orchestrator repair turn stays read-only in every mode (Guard 1 of #421).
test.each(["none", "read-only", "workspace-write"])(
  "with the %s reviewer mode the orchestrator repair turn stays read-only",
  async (reviewerSandbox) => {
    const repo = await createTempRepo();
    repos.push(repo);
    const turns = ["not json", JSON.stringify({ action: "finish", summary: SUMMARY })];
    const argvs = [];
    vi.mocked(exec).mockImplementation(async (_cmd, args) => {
      argvs.push(args.join(" "));
      return reply(turns.shift(), "th-orch");
    });
    await runLoop({ task: "Task", cwd: repo, maxSteps: 5, roles, reviewerSandbox });
    expect(argvs).toHaveLength(2);
    for (const args of argvs) {
      expect(args).toContain(READ_ONLY);
      expect(args).not.toContain("workspace-write");
      expect(args).not.toContain("danger-full-access");
    }
  },
);

// Usefulness: verifies the mutation check still wraps the reviewer turn in every mode, so an edit
// that a wider sandbox allows halts the run with a MutationError and stays on disk (ADR 0038).
test.each(["none", "read-only", "workspace-write"])(
  "with the %s reviewer mode a reviewer edit halts the run with a MutationError",
  async (reviewerSandbox) => {
    const { repo, run } = await reviewerRun({ reviewerSandbox }, (dir) =>
      writeFile(join(dir, "leak.txt"), "leak\n"),
    );
    await expect(run()).rejects.toThrow(MutationError);
    await expect(readFile(join(repo, "leak.txt"), "utf8")).resolves.toBe("leak\n");
  },
);

// Usefulness: verifies the reviewer prompt states the actual mode for each mode, and the
// workspace-write line names no repository-specific tool (ADR 0038, Guard 2 of #421).
test.each([
  [undefined, /no sandbox/],
  ["none", /no sandbox/],
  ["read-only", /read-only sandbox/],
  ["workspace-write", /workspace-write sandbox/],
])(
  "the reviewer prompt states the mode for reviewerSandbox %s",
  async (reviewerSandbox, pattern) => {
    const { calls, run } = await reviewerRun(reviewerSandbox ? { reviewerSandbox } : {});
    await run();
    const prompt = calls.find((c) => c.role === "reviewer").prompt;
    expect(prompt).toMatch(pattern);
    if (reviewerSandbox === "workspace-write") {
      expect(prompt).toMatch(/local binary/);
      expect(prompt).not.toMatch(/pnpm|vitest|npm|yarn|node_modules/);
    }
    expect(prompt).toContain("Do not write to GitHub or any remote");
    expect(prompt).toContain(
      "Do not change a tracked file or an untracked file that Git does not ignore, including a cache file, and do not change Git state.",
    );
  },
);

// Usefulness: verifies the orchestrator prompt of the headless loop states the actual mode, and
// that the orchestrator mutation check still halts an orchestrator edit in every mode (ADR 0038).
test.each(["none", "read-only", "workspace-write"])(
  "with the %s reviewer mode an orchestrator edit still halts the run with a MutationError",
  async (reviewerSandbox) => {
    const repo = await createTempRepo();
    repos.push(repo);
    vi.mocked(exec).mockImplementation(async (_cmd, args) => {
      expect(args.join(" ")).toContain(READ_ONLY);
      await writeFile(join(repo, "orch-leak.txt"), "leak\n");
      return reply(JSON.stringify({ action: "run_reviewer", prompt: "check it" }), "th-orch");
    });
    await expect(
      runLoop({ task: "Task", cwd: repo, maxSteps: 5, roles, reviewerSandbox }),
    ).rejects.toThrow(MutationError);
    await expect(readFile(join(repo, "orch-leak.txt"), "utf8")).resolves.toBe("leak\n");
  },
);

// Usefulness: verifies a reviewer that is not Codex gets no mode input and no mode line, whatever
// the run input says, so no prompt claims a sandbox that no adapter applies (ADR 0038).
test("a reviewer that is not Codex gets no sandbox input and no mode line", async () => {
  const repo = await createTempRepo();
  repos.push(repo);
  const seen = [];
  const orch = [
    JSON.stringify({ action: "run_reviewer", prompt: "check it" }),
    JSON.stringify({ action: "finish", summary: SUMMARY }),
  ];
  const agents = {
    orch: { run: async () => orch.shift() },
    rev: {
      run: async (_state, prompt, options) => {
        seen.push({ prompt, options });
        return "reviewed";
      },
    },
  };
  await runLoop({
    task: "Task",
    cwd: repo,
    maxSteps: 5,
    agents,
    roles: {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "orch", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    },
    reviewerSandbox: "none",
  });
  expect(seen).toHaveLength(1);
  expect(seen[0].options).not.toHaveProperty("sandbox");
  expect(seen[0].prompt).not.toMatch(/sandbox/i);
});

// Usefulness: verifies a worker turn never receives the reviewer mode input, in any mode, so the
// worker keeps its own invocation (ADR 0038).
test.each(["none", "read-only", "workspace-write"])(
  "with the %s reviewer mode a worker turn gets no sandbox input",
  async (reviewerSandbox) => {
    const repo = await createTempRepo();
    repos.push(repo);
    const turns = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const workerArgs = [];
    vi.mocked(exec).mockImplementation(async (_cmd, args, opts) => {
      if (opts.input.includes("Instructions:\nwork")) {
        workerArgs.push(args.join(" "));
        return reply("worker done", "th-work");
      }
      return reply(turns.shift(), "th-orch");
    });
    // Fresh role state, so the worker starts a new session and its prompt carries the preamble.
    const fresh = structuredClone(roles);
    await runLoop({ task: "Task", cwd: repo, maxSteps: 5, roles: fresh, reviewerSandbox });
    expect(workerArgs).toHaveLength(1);
    expect(workerArgs[0]).not.toContain("sandbox_mode");
  },
);
