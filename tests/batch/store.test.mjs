import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  acquireClaim,
  batchPaths,
  createBatchStore,
  listBatches,
  readLoop,
  readManifest,
  releaseClaim,
  updateLoop,
  updateManifest,
} from "../../src/batch/store.mjs";
import { removePath } from "../fs-helpers.mjs";

const REPO = "C:\\work\\repo";
const REPO_KEY = "abcabcabcabc";

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "batch-store-"));
}

function manifest(id, issues = [1, 2]) {
  return {
    id,
    repo: REPO,
    createdAt: "2026-11-09T00:00:00.000Z",
    base: "main",
    workTreeRoot: "C:\\work\\repo-batch",
    issues,
    status: "running",
    settings: { loops: 1, maxSteps: 10 },
  };
}

function loop(issue) {
  return {
    issue,
    status: "queued",
    reason: null,
    attempts: 0,
    stepsUsed: 0,
    remainingSteps: 10,
    branch: `batch/x/${issue}`,
    workTree: null,
    transcript: null,
    log: null,
    pid: null,
    startTime: null,
    pr: null,
    cleanup: null,
  };
}

// Usefulness: a claim is an exclusive file that exactly one contender wins.
test("two claim acquisitions for one issue produce exactly one winner", async () => {
  const root = await tempRoot();
  try {
    const base = { batchId: "b1", issue: 7, repo: REPO, workTree: null, pid: process.pid };
    const [a, b] = await Promise.all([
      acquireClaim(root, REPO_KEY, 7, { ...base, batchId: "b1" }),
      acquireClaim(root, REPO_KEY, 7, { ...base, batchId: "b2" }),
    ]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    const winner = a.acquired ? a : b;
    const text = await readFile(batchPaths(root).claim(REPO_KEY, 7), "utf8");
    expect(JSON.parse(text).batchId).toBe(winner.record.batchId);
  } finally {
    await removePath(root);
  }
});

// Usefulness: an unparseable claim counts as held, so a partial write never frees the issue.
test("an unparseable claim counts as held", async () => {
  const root = await tempRoot();
  try {
    const file = batchPaths(root).claim(REPO_KEY, 7);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{");
    const result = await acquireClaim(root, REPO_KEY, 7, { batchId: "b1", pid: 1 });
    expect(result.acquired).toBe(false);
    expect(result.held).toBe(true);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a dead owner's claim is taken over only when the caller proves it may, after
// re-reading the same content under the claim lock.
test("a stale claim is replaced only when the caller allows it", async () => {
  const root = await tempRoot();
  try {
    const file = batchPaths(root).claim(REPO_KEY, 8);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ batchId: "old", issue: 8, repo: REPO, pid: 2 ** 30, startTime: null }),
    );
    const refused = await acquireClaim(root, REPO_KEY, 8, { batchId: "new", pid: process.pid });
    expect(refused).toMatchObject({ acquired: false, stale: true, owner: "old" });
    const taken = await acquireClaim(
      root,
      REPO_KEY,
      8,
      { batchId: "new", pid: process.pid },
      {
        onStale: async (record) => record.batchId === "old",
      },
    );
    expect(taken.acquired).toBe(true);
  } finally {
    await removePath(root);
  }
});

// Usefulness: releasing a claim that is not there is a no-op that writes nothing.
test("a no-op claim release writes nothing", async () => {
  const root = await tempRoot();
  try {
    const wrote = await releaseClaim(root, REPO_KEY, 9, { batchId: "b1" });
    expect(wrote).toBe(false);
    await expect(readdir(batchPaths(root).claims)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await removePath(root);
  }
});

// Usefulness: a claim of another batch is never released by this one.
test("a claim of another batch is kept", async () => {
  const root = await tempRoot();
  try {
    await acquireClaim(root, REPO_KEY, 10, { batchId: "b1", pid: process.pid });
    expect(await releaseClaim(root, REPO_KEY, 10, { batchId: "b2" })).toBe(false);
    expect((await readdir(batchPaths(root).claims)).length).toBeGreaterThan(0);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a status read sees the manifest and the loops with no write.
test("a batch store writes the manifest and one queued loop per issue", async () => {
  const root = await tempRoot();
  try {
    await createBatchStore(root, manifest("b1"), [loop(1), loop(2)]);
    const read = await readManifest(root, "b1");
    expect(read.issues).toEqual([1, 2]);
    expect((await readLoop(root, "b1", 1)).status).toBe("queued");
    expect((await listBatches(root)).map((entry) => entry.id)).toEqual(["b1"]);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a no-op checkpoint update leaves the file byte- and mtime-identical.
test("a checkpoint update with no change writes nothing", async () => {
  const root = await tempRoot();
  try {
    await createBatchStore(root, manifest("b1"), [loop(1)]);
    const file = batchPaths(root).loop("b1", 1);
    const before = await stat(file, { bigint: true });
    const wrote = await updateLoop(root, "b1", 1, () => undefined);
    const after = await stat(file, { bigint: true });
    expect(wrote).toBe(false);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.size).toBe(before.size);
  } finally {
    await removePath(root);
  }
});

// Usefulness: the manifest is written only when a field changes.
test("a manifest update with no change writes nothing", async () => {
  const root = await tempRoot();
  try {
    await createBatchStore(root, manifest("b1"), [loop(1)]);
    const file = batchPaths(root).manifest("b1");
    const before = await stat(file, { bigint: true });
    expect(await updateManifest(root, "b1", (value) => value)).toBe(false);
    const after = await stat(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
  } finally {
    await removePath(root);
  }
});

// Usefulness: the claims directory is a sibling of the batch directories, so a list skips it.
test("the batch list skips the claims directory", async () => {
  const root = await tempRoot();
  try {
    await createBatchStore(root, manifest("b1"), [loop(1)]);
    await acquireClaim(root, REPO_KEY, 1, { batchId: "b1", pid: process.pid });
    const ids = (await listBatches(root)).map((entry) => entry.id);
    expect(ids).toEqual(["b1"]);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a failed update does not poison the in-process chain and leaves no unhandled
// rejection for the next update.
test("a failed checkpoint update does not break the next update", async () => {
  const root = await tempRoot();
  try {
    await createBatchStore(root, manifest("b1"), [loop(1)]);
    await expect(
      updateLoop(root, "b1", 1, () => {
        throw new Error("writer failed");
      }),
    ).rejects.toThrow("writer failed");
    const wrote = await updateLoop(root, "b1", 1, (value) => ({
      ...value,
      attempts: value.attempts + 1,
    }));
    expect(wrote).toBe(true);
    expect((await readLoop(root, "b1", 1)).attempts).toBe(1);
  } finally {
    await removePath(root);
  }
});
