import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  appearedInInheritedTmpdir,
  snapshotInheritedTmpdir,
} from "../../src/lib/inherited-tmpdir-entries.mjs";
import { withTurnTmpdir } from "../../src/lib/turn-tmpdir.mjs";
import { removePath } from "../runtime-helpers.mjs";

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "entries-"));
  // `tmpdir()` reads these at call time, so the library lists the private directory.
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removePath(root);
});

// Usefulness: verifies requirement "report the entries that appeared directly in the inherited
// temporary directory during a turn" (issue #1024), and that an entry present before is not one.
test("lists only entries that appeared after the snapshot", async () => {
  await mkdir(join(root, "old-probe"));
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "m54-3db54ca8"));
  expect(await appearedInInheritedTmpdir(before)).toEqual(["m54-3db54ca8"]);
});

// Usefulness: verifies requirement "only the runtime's own turn directories are left out" (issue
// #1024): the directory that `withTurnTmpdir` created is not reported while it exists, and an
// unmanaged `al-` directory that a reviewer created is, so the prefix alone hides nothing.
test("leaves out the directory the runtime created and reports an unmanaged al- directory", async () => {
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "al-probe"));
  const seen = await withTurnTmpdir(async (env) => {
    expect(env).toBeDefined();
    return appearedInInheritedTmpdir(before);
  });
  expect(seen).toEqual(["al-probe"]);
});

// Usefulness: verifies requirement "a directory the runtime did not remove is reportable" (issue
// #1024): when the turn directory is renamed and its path recreated, the removal refuses the
// replacement by identity, and that replacement must not stay excluded by its name.
test("reports a replacement of the turn directory that the removal refused", async () => {
  const before = await snapshotInheritedTmpdir();
  let name;
  await withTurnTmpdir(async (env) => {
    name = basename(env.TMPDIR);
    await rename(env.TMPDIR, join(root, "moved-away"));
    await mkdir(env.TMPDIR);
  });
  const entries = await appearedInInheritedTmpdir(before);
  expect(entries).toContain(name);
});

// Usefulness: verifies requirement "a secret-named environment value in a name is redacted" (issue
// #1024, ADR 0017): a reviewer-chosen name can echo a value the process holds, and the list reaches
// the envelope, the state file, and the headless prompt.
test("redacts the value of a secret-named environment variable in a name", async () => {
  vi.stubEnv("PROBE_API_TOKEN", "s3cr3t-value-9402");
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "probe-s3cr3t-value-9402"));
  const entries = await appearedInInheritedTmpdir(before);
  expect(entries).toEqual(["probe-[redacted:PROBE_API_TOKEN]"]);
  expect(JSON.stringify(entries)).not.toContain("s3cr3t-value-9402");
});

// Usefulness: verifies requirement "an unreadable directory reports nothing instead of a false
// change", as a missing before-state would otherwise read as every entry new.
test("reports nothing when the snapshot could not be read", async () => {
  vi.stubEnv("TMPDIR", join(root, "missing"));
  vi.stubEnv("TEMP", join(root, "missing"));
  vi.stubEnv("TMP", join(root, "missing"));
  const before = await snapshotInheritedTmpdir();
  expect(before).toBeNull();
  expect(await appearedInInheritedTmpdir(before)).toEqual([]);
});

// Usefulness: verifies requirement "the field stays bounded" so a busy host cannot flood the envelope.
test("lists at most 20 names", async () => {
  const before = await snapshotInheritedTmpdir();
  for (let i = 0; i < 25; i += 1) await mkdir(join(root, `p${String(i).padStart(2, "0")}`));
  expect(await appearedInInheritedTmpdir(before)).toHaveLength(20);
});
