import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  appearedInInheritedTmpdir,
  snapshotInheritedTmpdir,
} from "../../src/lib/inherited-tmpdir-entries.mjs";
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

// Usefulness: verifies requirement "turn directories are not reported", because the runtime
// removes them and a concurrent turn creates them, so listing them would bury a real probe directory.
test("leaves out a turn temporary directory", async () => {
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "al-AbC123"));
  await mkdir(join(root, "probe-1"));
  expect(await appearedInInheritedTmpdir(before)).toEqual(["probe-1"]);
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
