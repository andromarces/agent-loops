import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory, as `runtime.test.mjs` does: the case asserts no Git result.
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

import { runLoop } from "../src/runtime.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { cleanRepoGit, createCleanRepoDir } from "./git-helpers.mjs";

afterEach(() => {
  gitDouble.answer = null;
});

async function cleanRepo() {
  gitDouble.answer = cleanRepoGit;
  return createCleanRepoDir();
}

const roles = {
  orchestrator: { kind: "orch", sessionId: null },
  worker: { kind: "work", sessionId: null },
  reviewer: { kind: "rev", sessionId: null },
};

const summary = (open) => ({ changed: "a", verified: "b", deferred: "c", notDone: "d", open });

// Usefulness: verifies acceptance #1616 on the headless path. A reviewer turn's directory
// difference reaches the result prompt as a diagnostic, no re-read field is added, and a finish
// that lists the name is accepted.
test("a headless run carries the inherited temporary directory entries as diagnostics", async () => {
  const repo = await cleanRepo();
  const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
  const left = "m54-3db54ca8";
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review the change" }),
      JSON.stringify({ action: "finish", summary: summary(`left ${left}`) }),
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(temp, left), "");
        return "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept";
      },
    ]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles,
      agents: {
        orch: orchAdapter,
        work: scripted(["worker did task"]),
        rev: reviewerAdapter,
      },
    });

    const reviewerPrompt = orchAdapter.recorded.at(-1).prompt;
    expect(result.exitCode).toBe(0);
    expect(result.summary.open).toBe(`left ${left}`);
    expect(reviewerPrompt).toContain('"inheritedTmpdirEntries"');
    expect(reviewerPrompt).toContain(left);
    expect(reviewerPrompt).not.toContain('"inheritedTmpdirPresent"');
    expect(reviewerPrompt).not.toContain('"inheritedTmpdirSettled"');
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
    await removePath(repo);
  }
});
