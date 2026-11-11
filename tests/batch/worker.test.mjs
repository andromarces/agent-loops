import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { childArguments, runSetup, spawnHeadless } from "../../src/batch/worker.mjs";
import { removePath } from "../fs-helpers.mjs";

// A test never shows a desktop notification.
const noNotify = async () => ({ spawned: false, ok: true });

const prepared = {
  roles: {
    orchestrator: { kind: "codex", model: null, effort: null },
    worker: { kind: "claude", model: null, effort: null },
    reviewer: { kind: "agy", model: null, effort: null },
  },
  testCmd: null,
  testCmdTimeout: null,
  timeout: 60,
  reviewerSandbox: null,
};

function argsFor(loop, resume = { continueFrom: null, pr: null }) {
  return childArguments({
    prepared,
    loop: { remainingSteps: 5, ...loop },
    workTree: "C:/work",
    transcript: "run.json",
    maxSteps: 9,
    resume,
  });
}

// Usefulness: a review-only item never receives the gate flags that its mode refuses.
test("a review-only child gets no require-accept, pr, or require-ci", () => {
  const args = argsFor({
    kind: "pr",
    issue: "pr-7",
    number: 7,
    mode: "review-only",
    pr: 7,
    head: "a",
  });
  expect(args).toContain("--mode");
  expect(args[args.indexOf("--mode") + 1]).toBe("review-only");
  expect(args).not.toContain("--require-accept");
  expect(args).not.toContain("--pr");
  expect(args).not.toContain("--require-ci");
});

// Usefulness: a pull request review-first loop is gated on its own head.
test("a pull request review-first child gets its pr, require-ci, and mode", () => {
  const args = argsFor({
    kind: "pr",
    issue: "pr-7",
    number: 7,
    mode: "review-first",
    pr: 7,
    head: "a",
  });
  expect(args[args.indexOf("--mode") + 1]).toBe("review-first");
  expect(args[args.indexOf("--pr") + 1]).toBe("7");
  expect(args[args.indexOf("--require-ci") + 1]).toBe("7");
  expect(args).toContain("--require-accept");
});

// Usefulness: the real headless child writes its output to the log file (the one end-to-end run of this entry point).
test("the real headless child writes its output to the log file", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-spawn-"));
  const logPath = join(root, "child.log");
  try {
    await writeFile(logPath, "batch-spawn-earlier\n");
    const child = await spawnHeadless({ args: ["--help"], cwd: root, logPath });
    const { exitCode } = await child.done;
    expect(exitCode).toBe(0);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("batch-spawn-earlier\n");
    expect(log).toContain("Usage:");
  } finally {
    await removePath(root);
  }
});

// Usefulness: an interrupted setup stops promptly and runs no child.
test("an aborted setup returns without waiting for the timeout", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const run = runSetup({
    command: "setup",
    workTree: process.cwd(),
    timeoutSeconds: 60,
    signal: controller.signal,
    deps: {
      notifier: noNotify,
      execBounded: async (file, args, options) => {
        await new Promise((resolve) => {
          options.signal.addEventListener("abort", resolve, { once: true });
        });
        return { exitCode: 130 };
      },
    },
  });
  setTimeout(() => controller.abort(), 20);
  const ok = await run;
  expect(ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
});
