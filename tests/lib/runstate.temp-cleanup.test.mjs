import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withStateLock, writeState } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

// A real partial write is not reproducible on demand, so `writeFile` is stubbed
// to create the file and then fail, the shape of a write cut short by a full
// disk or a Windows sharing violation. The mock applies to the whole module, so
// the real-filesystem cases stay in runstate.test.mjs (#353).
const realFs = await vi.importActual("node:fs/promises");

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  writeFile: vi.fn(async (...args) => await realFs.writeFile(...args)),
  rm: vi.fn(async (...args) => await realFs.rm(...args)),
}));

/** Fails a write after it has created the file, the shape of a short write. */
function failWriteAfterCreate(code, message) {
  vi.mocked(writeFile).mockImplementationOnce(async (file, text, options) => {
    await realFs.writeFile(file, "", options);
    throw Object.assign(new Error(message), { code });
  });
}

function fsError(code, message) {
  return Object.assign(new Error(message), { code });
}

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-temp-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(writeFile)
    .mockReset()
    .mockImplementation(async (...a) => await realFs.writeFile(...a));
  vi.mocked(rm)
    .mockReset()
    .mockImplementation(async (...a) => await realFs.rm(...a));
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
  failWriteAfterCreate("ENOSPC", "ENOSPC: no space left on device");

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toMatchObject({
    code: "ENOSPC",
  });

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a cleanup failure never replaces the error that caused
// it. The caller acts on the write failure, so a temp that cannot be removed
// must not surface as the removal error instead (#353).
test("a temp file that cannot be removed does not replace the write error", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  failWriteAfterCreate("ENOSPC", "ENOSPC: no space left on device");
  vi.mocked(rm).mockRejectedValueOnce(fsError("EPERM", "EPERM: operation not permitted"));

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /ENOSPC: no space left on device/,
  );
});

// Usefulness: verifies a state write that fails partway leaves no
// `state.json.<pid>.tmp` behind. The state file and the lock temp share a
// directory, so the leftover is the same class of stray `.tmp` as #353.
test("a state write that fails partway leaves no temp file", async () => {
  const dir = await tempDir();
  const stateFile = join(dir, "state.json");
  failWriteAfterCreate("ENOSPC", "ENOSPC: no space left on device");

  await expect(writeState(stateFile, { lifecycle: "active" })).rejects.toMatchObject({
    code: "ENOSPC",
  });

  expect(await readdir(dir)).toEqual([]);
});
