import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  isInside,
  readSessionRecord,
  removeSessionRecord,
  writeSessionRecord,
} from "../../src/lib/session-record.mjs";

let dir;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "session-record-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Usefulness: verifies a record is the earlier run's only trace when the transcript file does not
// exist, and that removing it leaves nothing to read (ADR 0027).
test("a record is read when the transcript file is missing, and not after removal", async () => {
  const transcript = join(dir, "run.json");
  await writeSessionRecord(transcript, '{"a":1}');
  expect(await readSessionRecord(transcript)).toBe('{"a":1}');
  await removeSessionRecord(transcript);
  expect(await readSessionRecord(transcript)).toBeNull();
});

// Usefulness: verifies a record that a later transcript write superseded is never read, even when
// its removal failed, so --continue-from never goes back to an older session id.
test("a record older than the transcript file is ignored", async () => {
  const transcript = join(dir, "run.json");
  await writeSessionRecord(transcript, '{"a":1}');
  await writeFile(transcript, "{}");
  const later = new Date(Date.now() + 60_000);
  await utimes(transcript, later, later);
  expect(await readSessionRecord(transcript)).toBeNull();
  await removeSessionRecord(transcript);
});

// Usefulness: verifies a path counts as inside a directory by file identity, so a symlink into the
// directory counts and a sibling does not.
test("isInside follows a symlink and rejects a sibling directory", async () => {
  const root = join(dir, "root");
  const sibling = join(dir, "sibling");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(sibling);
  await symlink(join(root, "sub"), join(dir, "link"));
  expect(await isInside(root, join(root, "sub", "run.json"))).toBe(true);
  expect(await isInside(root, join(dir, "link", "run.json"))).toBe(true);
  expect(await isInside(root, join(sibling, "run.json"))).toBe(false);
  expect(await isInside(root, join(root, "new", "deeper", "run.json"))).toBe(true);
});
