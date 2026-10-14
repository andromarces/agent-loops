import { mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { writeTextAtomic } from "../../src/install/fsutil.mjs";
import { removePath } from "../runtime-helpers.mjs";

// A real Windows EPERM needs another process to hold the destination open, so
// this file stubs `rename` to inject the failure. The stub applies to the whole
// module, so the real-filesystem cases stay in fsutil.test.mjs (#790).
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  rename: vi.fn(),
}));

const realFs = await vi.importActual("node:fs/promises");

let dir;

beforeEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(realFs.rename);
  dir = await mkdtemp(join(tmpdir(), "fsutil-rename-"));
});

afterEach(async () => {
  await removePath(dir);
});

// Usefulness: verifies a transient rename failure on a retryable code is retried
// and the write lands, so a brief Windows reader hold no longer aborts install (#790).
test("writeTextAtomic retries a rename that fails with EPERM, EACCES, or EBUSY", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const target = join(dir, `settings-${code}.json`);
    vi.mocked(rename).mockImplementationOnce(async () => {
      throw Object.assign(new Error(`${code}: rename failed`), { code });
    });

    await writeTextAtomic(target, "data");

    expect(await readFile(target, "utf8")).toBe("data");
  }
  expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
