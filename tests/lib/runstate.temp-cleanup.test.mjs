import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withStateLock } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

// A real partial owner write is not reproducible on demand, so `writeFile` is
// stubbed to create the file and then fail, the shape of a write cut short by a
// full disk or a Windows sharing violation. The mock applies to the whole
// module, so the real-filesystem cases stay in runstate.test.mjs (#353).
const realFs = await vi.importActual("node:fs/promises");

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  writeFile: vi.fn(async (...args) => await realFs.writeFile(...args)),
}));

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-temp-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(writeFile).mockClear();
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

// Usefulness: verifies a lock owner write that fails partway leaves no
// `state.lock.<pid>.<n>.tmp` behind. The prune never removes a temp owned by the
// running process, so a leftover survives every later acquisition and every
// later directory listing (#353).
test("a lock owner write that fails partway leaves no temp file", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  vi.mocked(writeFile).mockImplementationOnce(async (file, text, options) => {
    await realFs.writeFile(file, "", options);
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toMatchObject({
    code: "ENOSPC",
  });

  expect(await readdir(dir)).toEqual([]);
});
