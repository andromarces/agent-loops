import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

const writes = vi.hoisted(() => []);

vi.mock("../../src/lib/atomic-write.mjs", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    writeFileAtomic: async (file, text) => {
      let before = null;
      try {
        before = await readFile(file, "utf8");
      } catch {
        // A first write has no earlier record.
      }
      writes.push({ file, before, after: text });
      return actual.writeFileAtomic(file, text);
    },
  };
});

const { batchPaths } = await import("../../src/batch/store.mjs");
const { newBatchId, runBatch } = await import("../../src/batch/supervisor.mjs");
const { removePath } = await import("../fs-helpers.mjs");

const summary = {
  changed: "the change",
  verified: "the checks",
  deferred: "nothing",
  notDone: "nothing",
  open: "none",
};

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function fakeGh() {
  return async (args) => {
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: [] } }), stderr: "" };
      }
      if (args.includes("body")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            body: "## Problem\nMissing.\n\n## Acceptance\n\n- one check\n",
          }),
          stderr: "",
        };
      }
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "An issue" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
}

// A prepared batch for the write case: no Git process starts.
async function preparedLoop() {
  const workTreeRoot = await mkdtemp(join(tmpdir(), "batch-report-write-root-"));
  return {
    prepared: {
      id: newBatchId(),
      repo: "/repo",
      repoKey: "report-write-key",
      base: "main",
      workTreeRoot,
      issues: [1],
      loops: 1,
      maxSteps: 10,
      setupCmd: null,
      setupTimeout: 600,
      taskTemplate: "Work {issue}",
      testCmd: null,
      testCmdTimeout: null,
      timeout: 3600,
      reviewerSandbox: null,
      roles: {
        orchestrator: { kind: "codex", model: null, effort: null },
        worker: { kind: "claude", model: null, effort: null },
        reviewer: { kind: "agy", model: null, effort: null },
      },
    },
    workTreeRoot,
  };
}

const gitDeps = {
  createWorkTree: async ({ workTree, branch }) => ({
    path: workTree,
    canonicalPath: workTree,
    dev: "1",
    ino: "1",
    branch,
  }),
  verifyWorkTree: async () => null,
  reconcileLoop: async () => ({ status: "resume", reason: null, pr: null, requireCi: null }),
  cleanupLoop: async () => ({ removed: false, reason: "test" }),
};

// Usefulness: report building adds no loop checkpoint write beyond the status write.
test("a loop end writes the report in the same checkpoint write as the status", async () => {
  const { prepared, workTreeRoot } = await preparedLoop();
  try {
    const spawn = async ({ args }) => {
      const transcript = valueAfter(args, "--transcript");
      await writeFile(
        transcript,
        JSON.stringify({
          events: [{ type: "action", action: { action: "finish", summary } }, { type: "gate" }],
          exitCode: 0,
          error: null,
          warnings: [],
        }),
      );
      return {
        pid: process.pid,
        startTime: null,
        done: Promise.resolve({ exitCode: 0 }),
        kill: () => {},
        hardKill: () => {},
        close: () => {},
      };
    };
    await runBatch({
      prepared,
      runsRoot: join(workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: {
        ...gitDeps,
        notifier: async () => ({ spawned: false }),
        spawn,
        installSignal: false,
      },
    });
    const loopFile = batchPaths(join(workTreeRoot, "runs")).loop(prepared.id, 1);
    const transitions = writes
      .filter((write) => write.file === loopFile)
      .map((write) => ({
        before: write.before === null ? null : JSON.parse(write.before),
        after: JSON.parse(write.after),
      }));
    const reportWrites = transitions.filter(
      (state) => state.after.report != null && state.before?.report == null,
    );
    expect(reportWrites).toHaveLength(1);
    expect(reportWrites[0].before.status).toBe("running");
    expect(reportWrites[0].after.status).toBe("succeeded");
    expect(reportWrites[0].after.report.summary).toEqual({ ...summary, notes: null });
    expect(
      transitions.some(
        (state) =>
          JSON.stringify(state.after.report) !== JSON.stringify(state.before?.report) &&
          state.after.status === state.before?.status,
      ),
    ).toBe(false);
  } finally {
    await removePath(workTreeRoot);
  }
});
