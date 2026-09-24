import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isEntryPoint } from "../../src/lib/entrypoint.mjs";

async function withArgv1(value, run) {
  const original = process.argv[1];
  process.argv[1] = value;
  try {
    return await run();
  } finally {
    process.argv[1] = original;
  }
}

// Usefulness: verifies the entry-point check resolves real paths, so a bin that
// reaches the file through a symlinked package directory (pnpm dlx, pnpm global,
// npm on POSIX) still runs main() instead of exiting with no output.
test("entry point detection follows a symlinked package directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "entrypoint-"));
  try {
    const realDir = join(dir, "real");
    await mkdir(realDir);
    const modulePath = join(realDir, "cli.mjs");
    await writeFile(modulePath, "");
    const linkedDir = join(dir, "linked");
    // A junction on Windows and a directory symlink on POSIX. Both work without
    // elevated privileges, and both defeat a plain path compare.
    await symlink(realDir, linkedDir, "junction");

    await withArgv1(join(linkedDir, "cli.mjs"), () => {
      expect(isEntryPoint(modulePath)).toBe(true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Usefulness: verifies a different process entry point is not mistaken for this
// module, so importing the module never runs the CLI.
test("entry point detection rejects a different module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "entrypoint-"));
  try {
    const modulePath = join(dir, "cli.mjs");
    const otherPath = join(dir, "other.mjs");
    await writeFile(modulePath, "");
    await writeFile(otherPath, "");

    await withArgv1(otherPath, () => {
      expect(isEntryPoint(modulePath)).toBe(false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Usefulness: verifies a missing argv[1] is not treated as the entry point, so
// an embedded import of the module stays inert.
test("entry point detection rejects a missing argv[1]", async () => {
  await withArgv1(undefined, () => {
    expect(isEntryPoint("C:/nowhere/cli.mjs")).toBe(false);
  });
});
