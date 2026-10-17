import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { createTempRepo, exists, removePath, scripted } from "./runtime-helpers.mjs";

const SCRATCH_PARENT = ".agent-loop";

// Runs one reviewer turn whose adapter reports the scratch folder it saw, then runs `act` in it.
async function reviewerTurn(repo, act, { signal } = {}) {
  const seen = {};
  const adapter = scripted([
    async (state, prompt) => {
      const [id] = await readdir(join(repo, SCRATCH_PARENT, "rev"));
      seen.dir = join(repo, SCRATCH_PARENT, "rev", id);
      seen.id = id;
      seen.prompt = prompt;
      return act(seen);
    },
  ]);
  const run = () =>
    runChild({
      agents: { rev: adapter },
      role: { kind: "rev", sessionId: null },
      roleName: "reviewer",
      prompt: "review it",
      cwd: repo,
      signal,
    });
  return { run, seen };
}

// Usefulness: verifies acceptance #920 — the reviewer prompt names the runtime scratch folder, and
// the runtime removes it after an ok turn, so cleanup does not depend on a delete the reviewer may be refused.
test("an ok reviewer turn gets a scratch folder that the runtime removes afterward", async () => {
  const repo = await createTempRepo();
  try {
    const { run, seen } = await reviewerTurn(repo, async ({ dir }) => {
      await mkdir(join(dir, "cache"));
      await writeFile(join(dir, "cache", "out.txt"), "probe\n");
      return "done";
    });
    const result = await run();
    expect(result.status).toBe("ok");
    expect(seen.prompt).toContain(seen.id);
    expect(await exists(seen.dir)).toBe(false);
    expect(await exists(join(repo, SCRATCH_PARENT))).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the removal runs after a handled error turn too, so a failed reviewer
// leaves no scratch output behind (#920).
test("an error reviewer turn still removes the scratch folder", async () => {
  const repo = await createTempRepo();
  try {
    const { run, seen } = await reviewerTurn(repo, async ({ dir }) => {
      await writeFile(join(dir, "out.txt"), "probe\n");
      throw new Error("adapter failed");
    });
    expect((await run()).status).toBe("error");
    expect(await exists(seen.dir)).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the removal runs after a canceled turn, so an interrupt leaves no scratch
// output behind (#920).
test("a canceled reviewer turn still removes the scratch folder", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  try {
    const { run, seen } = await reviewerTurn(
      repo,
      async ({ dir }) => {
        await writeFile(join(dir, "out.txt"), "probe\n");
        controller.abort();
        throw new ExecError("canceled", { isCanceled: true });
      },
      { signal: controller.signal },
    );
    await expect(run()).rejects.toMatchObject({ isCanceled: true });
    expect(await exists(seen.dir)).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a real mutation is still reported and the scratch folder is still removed,
// so the removal never hides a mutation (#920).
test("a reviewer mutation is still reported and the scratch folder is removed", async () => {
  const repo = await createTempRepo();
  try {
    const { run, seen } = await reviewerTurn(repo, async ({ dir }) => {
      await writeFile(join(dir, "out.txt"), "probe\n");
      await writeFile(join(repo, "leak.txt"), "leak\n");
      return "done";
    });
    await expect(run()).rejects.toThrow(MutationError);
    expect(await exists(seen.dir)).toBe(false);
    expect((await execa("git", ["status", "--porcelain"], { cwd: repo })).stdout).toContain(
      "leak.txt",
    );
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies acceptance #920 — a write to an ignored path is still no reviewer mutation,
// next to the scratch folder, so the new folder did not widen what the mutation check flags.
test("a reviewer write to an ignored path is no mutation", async () => {
  const repo = await createTempRepo();
  try {
    await writeFile(join(repo, ".gitignore"), "cache/\n");
    await execa("git", ["add", ".gitignore"], { cwd: repo });
    await execa("git", ["commit", "-m", "ignore cache"], { cwd: repo });
    const { run } = await reviewerTurn(repo, async () => {
      await mkdir(join(repo, "cache"));
      await writeFile(join(repo, "cache", "out.txt"), "probe\n");
      return "done";
    });
    expect((await run()).status).toBe("ok");
    expect(await exists(join(repo, "cache", "out.txt"))).toBe(true);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a worker turn gets no scratch folder, because only the reviewer prompt
// names one (#920).
test("a worker turn creates no scratch folder", async () => {
  const repo = await createTempRepo();
  try {
    let during;
    const adapter = scripted([
      async () => {
        during = await exists(join(repo, SCRATCH_PARENT));
        return "done";
      },
    ]);
    await runChild({
      agents: { work: adapter },
      role: { kind: "work", sessionId: null },
      roleName: "worker",
      prompt: "do it",
      cwd: repo,
    });
    expect(during).toBe(false);
  } finally {
    await removePath(repo);
  }
});
