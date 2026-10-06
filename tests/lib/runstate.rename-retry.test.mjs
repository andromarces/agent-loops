import { mkdtemp, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { writeSessionEntry } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

// A real Windows EPERM needs another process to hold the destination open, so
// it is not reproducible in-process on Linux or macOS CI. This file replaces
// `rename` with a stub that injects the failure per test; the base
// implementation is the real rename. The mock applies to the whole module, so
// the real-filesystem cases stay in runstate.test.mjs (#233).
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  rename: vi.fn(),
}));

const realFs = await vi.importActual("node:fs/promises");

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-rename-"));
  dirs.push(dir);
  return dir;
}

function renameError(code) {
  const err = new Error(`${code}: rename failed`);
  err.code = code;
  return err;
}

beforeEach(() => {
  vi.mocked(rename).mockReset().mockImplementation(realFs.rename);
});

afterEach(async () => {
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

// Usefulness: verifies a transient rename failure on each retryable code is
// retried and the write succeeds, so a brief Windows reader hold no longer
// aborts the CLI call (#233).
test("writeSessionEntry retries a transient rename failure on EPERM, EACCES, and EBUSY", async () => {
  const dir = await tempDir();
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const entryFile = join(dir, `entry-${code}`);
    vi.mocked(rename).mockImplementationOnce(async () => {
      throw renameError(code);
    });

    await writeSessionEntry(entryFile, "/runs/state.json");

    expect(await readFile(entryFile, "utf8")).toBe("/runs/state.json\n");
  }
});

// Usefulness: verifies a rename failure that persists past the old ~100 ms
// budget, here for 350 ms, is still retried and the write succeeds on each
// retryable code, so a reader that holds the destination almost continuously
// no longer aborts the write (#242).
test("writeSessionEntry retries a rename failure that persists for 350 ms on EPERM, EACCES, and EBUSY", async () => {
  const dir = await tempDir();
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const entryFile = join(dir, `entry-held-${code}`);
    const startedAt = Date.now();
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (Date.now() - startedAt < 350) {
        throw renameError(code);
      }
      return realFs.rename(from, to);
    });

    await writeSessionEntry(entryFile, "/runs/state.json");

    expect(await readFile(entryFile, "utf8")).toBe("/runs/state.json\n");
  }
});

// Usefulness: verifies a persistent rename failure still throws the original
// error, so the retry never masks the failure or hangs (#233).
test("writeSessionEntry rethrows the original error when the rename keeps failing", async () => {
  const dir = await tempDir();
  const original = renameError("EBUSY");
  vi.mocked(rename).mockImplementation(async () => {
    throw original;
  });

  await expect(writeSessionEntry(join(dir, "entry"), "/runs/state.json")).rejects.toBe(original);
});
