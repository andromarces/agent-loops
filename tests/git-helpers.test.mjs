import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, inject, test } from "vite-plus/test";
import { exists, removePath } from "./fs-helpers.mjs";
import { cleanRepoGit, createTempRepo, untrackedFilesGit } from "./git-helpers.mjs";

const options = { cwd: tmpdir() };
const expected = ["rev-parse", "--verify", "-q", "HEAD"];
const merged = ["rev-parse", "--verify -q", "HEAD"];

// Usefulness: acceptance (#514) — a merged-argument call reads differently from the expected call in the error.
test("cleanRepoGit error for a merged-argument call differs from the expected call text", () => {
  const message = (args) => {
    try {
      cleanRepoGit("git", args, options);
    } catch (error) {
      return error.message;
    }
    return undefined;
  };
  expect(message(expected)).toBeUndefined();
  expect(message(merged)).toBeDefined();
  expect(message(merged)).not.toBe(`unexpected git call: ${expected.join(" ")}`);
});

// Usefulness: acceptance (#514) — the same holds for `untrackedFilesGit`, which delegates unknown calls.
test("untrackedFilesGit error for a merged-argument call differs from the expected call text", async () => {
  const error = await untrackedFilesGit("git", merged, options).catch((caught) => caught);
  expect(error.message).toContain("unexpected git call");
  expect(error.message).not.toBe(`unexpected git call: ${expected.join(" ")}`);
});

// Usefulness: acceptance (#1458) — each copy inherits the template setting that turns
// off automatic Git maintenance.
test("a temporary repository turns off automatic git maintenance", async () => {
  const first = await createTempRepo();
  const second = await createTempRepo();
  try {
    for (const repo of [first, second]) {
      expect(
        (await execa("git", ["config", "--get", "maintenance.auto"], { cwd: repo })).stdout,
      ).toBe("false");
      expect((await execa("git", ["config", "--get", "gc.auto"], { cwd: repo })).stdout).toBe("0");
    }
  } finally {
    await removePath(first);
    await removePath(second);
  }
});

// Usefulness: acceptance (#1854) — both copies come from one provided template, and a write in one leaves it unchanged.
test("two temporary repositories copy from one provided template", async () => {
  const template = inject("gitTemplate");
  expect(typeof template).toBe("string");
  const first = await createTempRepo();
  const second = await createTempRepo();
  try {
    await writeFile(join(first, "extra.txt"), "x\n");
    expect(await exists(join(template, "extra.txt"))).toBe(false);
    for (const repo of [first, second]) {
      expect((await execa("git", ["log", "--format=%s"], { cwd: repo })).stdout).toBe("init");
    }
  } finally {
    await removePath(first);
    await removePath(second);
  }
});

// Usefulness: (#1417) a copy owns its `.git`; a changed config, hook, or ref in one case
// reaches no other copy.
test("a change in one temporary repository reaches no other copy", async () => {
  const first = await createTempRepo();
  const second = await createTempRepo();
  let third;
  try {
    await execa("git", ["config", "user.name", "Changed"], { cwd: first });
    await writeFile(join(first, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    await writeFile(join(first, "extra.txt"), "x\n");
    await execa("git", ["add", "extra.txt"], { cwd: first });
    await execa("git", ["commit", "-m", "extra"], { cwd: first });
    third = await createTempRepo();

    for (const repo of [second, third]) {
      expect(await exists(join(repo, ".git", "objects", "info", "alternates"))).toBe(false);
      expect(await exists(join(repo, "extra.txt"))).toBe(false);
      expect(await exists(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect((await execa("git", ["config", "user.name"], { cwd: repo })).stdout).toBe("Tester");
      expect((await execa("git", ["log", "--format=%s"], { cwd: repo })).stdout).toBe("init");
      expect(await readFile(join(repo, ".git", "config"), "utf8")).not.toContain(first);
    }
  } finally {
    await removePath(first);
    await removePath(second);
    if (third !== undefined) await removePath(third);
  }
});
