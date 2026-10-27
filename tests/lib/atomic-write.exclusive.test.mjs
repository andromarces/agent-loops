import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal()),
  randomUUID: () => "fixed-token",
}));

const { writeFileAtomic } = await import("../../src/lib/atomic-write.mjs");

// Usefulness: verifies an exclusive write that finds its temp name taken fails and leaves the
// other file alone, since a cleanup must remove only a temp that the call created.
test("an exclusive write never deletes a temp file it did not create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loop-exclusive-"));
  try {
    const target = join(dir, "settings.json");
    const taken = `${target}.${process.pid}.fixed-token.tmp`;
    await writeFile(taken, "other");

    const error = await writeFileAtomic(target, "data", { exclusive: true }).catch((err) => err);

    expect(error.code).toBe("EEXIST");
    expect(await readFile(taken, "utf8")).toBe("other");
    expect((await readdir(dir)).sort()).toEqual([basename(taken)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
