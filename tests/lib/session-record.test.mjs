import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  isInside,
  readSessionRecord,
  removeSessionRecord,
  writeSessionRecord,
} from "../../src/lib/session-record.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
let dir;
let transcript;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "session-record-")));
  transcript = join(dir, "run.json");
});

afterEach(async () => {
  await removeSessionRecord(transcript);
  await rm(dir, { recursive: true, force: true });
});

const NONCE = "33333333-3333-4333-8333-333333333333";

const fields = (extra = {}) => ({
  cwd: dir,
  runNonce: NONCE,
  transcriptSha256: "a".repeat(64),
  role: "reviewer",
  sessionId: ID,
  ...extra,
});

// Usefulness: verifies a record is read back only for the transcript state it was written for, and
// that removal leaves nothing to read (ADR 0027).
test("a record binds to one transcript digest and goes away on removal", async () => {
  await writeSessionRecord(transcript, fields());
  const bound = { digest: "a".repeat(64), cwd: dir, runNonce: NONCE };
  expect(await readSessionRecord(transcript, bound)).toEqual({ role: "reviewer", sessionId: ID });
  expect(await readSessionRecord(transcript, { ...bound, digest: "b".repeat(64) })).toBeNull();
  expect(await readSessionRecord(transcript, { ...bound, cwd: join(dir, "x") })).toBeNull();
  expect(await readSessionRecord(transcript, { ...bound, runNonce: ID })).toBeNull();
  expect(await readSessionRecord(transcript, { ...bound, runNonce: [NONCE] })).toBeNull();
  await removeSessionRecord(transcript);
  expect(await readSessionRecord(transcript, bound)).toBeNull();
});

// Usefulness: verifies a role that the loop never records is refused, so a crafted record cannot
// name the worker.
test("a record for a role other than the orchestrator or reviewer is refused", async () => {
  await writeSessionRecord(transcript, fields({ role: "worker" }));
  expect(
    await readSessionRecord(transcript, { digest: "a".repeat(64), cwd: dir, runNonce: NONCE }),
  ).toBeNull();
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
