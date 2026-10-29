import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { snapshot } from "../../src/lib/snapshot.mjs";
import { removePath } from "../runtime-helpers.mjs";

// Probes of the reads a snapshot makes: the most file reads in flight, and the order of the events.
const probe = vi.hoisted(() => ({ flying: 0, max: 0, events: [] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    readFile: async (...args) => {
      probe.flying += 1;
      probe.max = Math.max(probe.max, probe.flying);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await original.readFile(...args);
      } finally {
        probe.flying -= 1;
        probe.events.push("hashed");
      }
    },
  };
});

vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    execBounded: (command, args, ...rest) => {
      probe.events.push(`git ${args[0]}`);
      return original.execBounded(command, args, ...rest);
    },
  };
});

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

async function createRepo(names) {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-concurrent-"));
  await execa("git", ["init"], { cwd: dir });
  for (const name of names) {
    await writeFile(join(dir, name), `content of ${name}\n`);
  }
  return dir;
}

const NAMES = Array.from({ length: 100 }, (_, i) => `${i % 2 === 0 ? "f" : "F"}${i}.txt`);

// Usefulness: verifies the dirty files hash together but in bounded batches (issue #1187), so a
// large work tree neither hashes one file at a time nor opens every file at once (EMFILE).
test("a snapshot hashes dirty files concurrently within a bound", async () => {
  const repo = await createRepo(NAMES);
  try {
    probe.max = 0;
    await snapshot(repo, {});
    expect(probe.max).toBeGreaterThan(1);
    expect(probe.max).toBeLessThanOrEqual(32);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the `ls-files` and `rev-parse HEAD` reads start while files still hash
// (issue #1187), since neither depends on the hashes.
test("a snapshot starts the index and HEAD reads before the file hashes finish", async () => {
  const repo = await createRepo(NAMES);
  try {
    probe.events.length = 0;
    await snapshot(repo, {});
    const lastHashed = probe.events.lastIndexOf("hashed");
    expect(probe.events.indexOf("git ls-files")).toBeLessThan(lastHashed);
    expect(probe.events.indexOf("git rev-parse", probe.events.indexOf("git status"))).toBeLessThan(
      lastHashed,
    );
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the entries keep the `localeCompare` order and the plain SHA-256 of each
// file, so a recorded digest still matches after the change (issue #1187, `--continue-from`).
test("a snapshot orders entries by localeCompare and hashes each file as before", async () => {
  const repo = await createRepo(NAMES);
  try {
    const { workTree } = await snapshot(repo, {});
    expect(workTree.map((entry) => entry.path)).toEqual(
      [...NAMES].sort((a, b) => a.localeCompare(b)),
    );
    for (const entry of workTree) {
      expect(entry.hash).toBe(sha256Hex(`content of ${entry.path}\n`));
    }
  } finally {
    await removePath(repo);
  }
});
