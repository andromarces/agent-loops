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

const roles = {
  orchestrator: { kind: "orch", sessionId: null },
  worker: { kind: "work", sessionId: null },
  reviewer: { kind: "rev", sessionId: null },
};

const summary = (open) => ({ changed: "a", verified: "b", deferred: "c", notDone: "d", open });

// Usefulness: verifies the headless parent receives only the names that the re-read still holds.
// A finish is accepted even when its summary lists a name removed after the turn (issue #1559).
test("a headless run carries the re-read names and never refuses a finish for them", async () => {
  const repo = await cleanRepo();
  const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
  const stays = "stays-probe";
  const gone = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review the change" }),
      async () => {
        await rm(join(temp, stays));
        await rm(join(temp, gone));
        return JSON.stringify({ action: "finish", summary: summary(`left ${stays} ${gone}`) });
      },
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(temp, stays), "");
        await writeFile(join(temp, gone), "");
        return "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept";
      },
    ]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles,
      tmpdirSettle: { boundMs: 40, intervalMs: 10 },
      agents: {
        orch: orchAdapter,
        work: scripted(["worker did task"]),
        rev: reviewerAdapter,
      },
    });

    const reviewerPrompt = orchAdapter.recorded.at(-1).prompt;
    expect(result.exitCode).toBe(0);
    expect(result.summary.open).toBe(`left ${stays} ${gone}`);
    expect(reviewerPrompt).toContain('"inheritedTmpdirPresent"');
    expect(reviewerPrompt).toContain(stays);
    expect(reviewerPrompt).toContain(gone);
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
    await removePath(repo);
  }
});

// Usefulness: verifies acceptance on the headless path. A name that another process removes during
// the settle wait is absent from the result prompt, so the finish summary can leave it out (issue
// #1569).
test("a headless run drops a name removed during the settle wait", async () => {
  const repo = await cleanRepo();
  const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
  const stays = "stays-probe";
  const gone = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review the change" }),
      JSON.stringify({ action: "finish", summary: summary("none") }),
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(temp, stays), "");
        await writeFile(join(temp, gone), "");
        setTimeout(() => {
          void rm(join(temp, gone));
        }, 400);
        return "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept";
      },
    ]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles,
      tmpdirSettle: { boundMs: 2_000, intervalMs: 20 },
      agents: {
        orch: orchAdapter,
        work: scripted(["worker did task"]),
        rev: reviewerAdapter,
      },
    });

    const reviewerPrompt = orchAdapter.recorded.at(-1).prompt;
    const match = reviewerPrompt.match(/"inheritedTmpdirPresent": \[([\s\S]*?)\n  \]/);
    const present = JSON.parse(`[${match[1]}]`);
    expect(result.exitCode).toBe(0);
    expect(present).toContain(stays);
    expect(present).not.toContain(gone);
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
    await removePath(repo);
  }
});

// Usefulness: verifies acceptance. The headless path waits only after an accept, so a reject or
// unknown verdict keeps the single read and adds no wait (issue #1569).
test("a headless run does not wait after a reject or unknown verdict", async () => {
  for (const verdict of ["reject", "unknown"]) {
    const repo = await cleanRepo();
    const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
    const name = "stays-after-review.tmp";
    try {
      for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
      const orchReplies = [
        JSON.stringify({ action: "run_worker", prompt: "start work" }),
        JSON.stringify({ action: "run_reviewer", prompt: "review the change" }),
        JSON.stringify({ action: "finish", summary: summary("none") }),
      ];
      const orchAdapter = scripted(orchReplies);
      const reviewerAdapter = scripted([
        async () => {
          await writeFile(join(temp, name), "");
          return `Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: ${verdict}`;
        },
      ]);

      const result = await runLoop({
        task: "Task 1",
        cwd: repo,
        maxSteps: 5,
        roles,
        tmpdirSettle: { boundMs: 60_000, intervalMs: 60_000 },
        agents: {
          orch: orchAdapter,
          work: scripted(["worker did task"]),
          rev: reviewerAdapter,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(orchAdapter.recorded.at(-1).prompt).toContain(name);
    } finally {
      vi.unstubAllEnvs();
      await removePath(temp);
      await removePath(repo);
    }
  }
});

// Usefulness: verifies the result prompt caps the re-read names at 20 and redacts them, as every
// other path field does (issue #1559, ADR 0017).
test("a headless result prompt caps and redacts the re-read names", async () => {
  const repo = await cleanRepo();
  const temp = await mkdtemp(join(tmpdir(), "runtime-inherited-"));
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, temp);
    vi.stubEnv("PROBE_API_TOKEN", "s3cr3t-value-9402");
    const first = Array.from({ length: 11 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    first.push("probe-s3cr3t-value-9402");
    const second = Array.from({ length: 12 }, (_, i) => `b${String(i).padStart(2, "0")}`);
    const leaving = (names) => async () => {
      for (const name of names) await writeFile(join(temp, name), "");
      return "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept";
    };
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "first review" }),
      JSON.stringify({ action: "run_reviewer", prompt: "second review" }),
      JSON.stringify({ action: "finish", summary: summary("none") }),
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted([leaving(first), leaving(second)]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles,
      tmpdirSettle: { boundMs: 40, intervalMs: 10 },
      agents: {
        orch: orchAdapter,
        work: scripted(["worker did task"]),
        rev: reviewerAdapter,
      },
    });

    const prompt = orchAdapter.recorded.at(-1).prompt;
    const match = prompt.match(/"inheritedTmpdirPresent": \[([\s\S]*?)\n  \]/);
    const present = JSON.parse(`[${match[1]}]`);
    expect(result.exitCode).toBe(0);
    expect(present).toHaveLength(20);
    expect(JSON.stringify(present)).not.toContain("s3cr3t-value-9402");
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
    await removePath(repo);
  }
});

// Usefulness: verifies a run with no reviewer turn carries no re-read field. The parent then has
// no inherited temporary directory names to report (issue #1559).
test("a worker result prompt carries no inherited temporary directory re-read", async () => {
  const repo = await cleanRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "finish", summary: summary("none") }),
    ];
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles,
      agents: {
        orch: orchAdapter,
        work: scripted(["worker did task"]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).not.toContain("inheritedTmpdirPresent");
  } finally {
    await removePath(repo);
  }
});
