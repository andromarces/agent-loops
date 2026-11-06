import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Usefulness: verifies acceptance — a GUID .tmp name that the reviewer turn reported and that is
// gone at the finish re-read never reaches the accepted finish summary as an `open` item (issue
// #1559). The first finish still lists it, and the runtime refuses that finish with no child turn.
test("a finish that still lists an entry the finish re-read no longer holds is refused", async () => {
  const repo = await cleanRepo();
  const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
  const name = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
    const summary = (open) => ({ changed: "a", verified: "b", deferred: "c", notDone: "d", open });
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review the change" }),
      async () => {
        await rm(join(temp, name));
        return JSON.stringify({ action: "finish", summary: summary(`left ${name}`) });
      },
      JSON.stringify({ action: "finish", summary: summary("none") }),
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(temp, name), "");
        return "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept";
      },
    ]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: {
        orch: orchAdapter,
        work: scripted(["worker did task"]),
        rev: reviewerAdapter,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.open).toBe("none");
    expect(orchAdapter.recorded.at(-1).prompt).toContain(name);
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
    await removePath(repo);
  }
});

// Usefulness: verifies requirement "a name that still exists at the finish re-read stays reportable
// under open" (issue #1559), so the re-check drops only a gone name.
test("a finish that lists an entry the finish re-read still holds is accepted", async () => {
  const repo = await cleanRepo();
  const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
  const name = "stays-probe";
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
    const summary = (open) => ({ changed: "a", verified: "b", deferred: "c", notDone: "d", open });
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review the change" }),
      JSON.stringify({ action: "finish", summary: summary(`left ${name}`) }),
    ];
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(temp, name), "");
        return "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept";
      },
    ]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker did task"]),
        rev: reviewerAdapter,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.open).toBe(`left ${name}`);
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
    await removePath(repo);
  }
});
