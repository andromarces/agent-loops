import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { symlinkOrSkip } from "../runtime-helpers.mjs";
import {
  isInside,
  readSessionRecord,
  removeSessionRecord,
  sessionRecordPath,
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
test("isInside follows a symlink and rejects a sibling directory", async (ctx) => {
  const root = join(dir, "root");
  const sibling = join(dir, "sibling");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(sibling);
  try {
    await symlink(join(root, "sub"), join(dir, "link"));
  } catch (err) {
    // A Windows host without symlink privilege refuses the call.
    if (err?.code === "EPERM") ctx.skip();
    throw err;
  }
  expect(await isInside(root, join(root, "sub", "run.json"))).toBe(true);
  expect(await isInside(root, join(dir, "link", "run.json"))).toBe(true);
  expect(await isInside(root, join(sibling, "run.json"))).toBe(false);
  expect(await isInside(root, join(root, "new", "deeper", "run.json"))).toBe(true);
});

// Usefulness: verifies a path behind a junction in the directory counts as inside even when the
// junction points outside, because Git for Windows follows the junction and lists the file as
// untracked (issue #613). A junction that points from outside into the directory still counts.
test("isInside counts a path behind a junction inside the directory, whatever its target", async (ctx) => {
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  const target = join(root, "sub");
  await mkdir(target, { recursive: true });
  await mkdir(outside);
  try {
    await symlink(outside, join(root, "jn"), "junction");
    await symlink(target, join(dir, "jin"), "junction");
  } catch (err) {
    // A junction exists on Windows only.
    if (err?.code === "EPERM" || err?.code === "ENOTSUP") ctx.skip();
    throw err;
  }
  if (process.platform !== "win32") ctx.skip();
  expect(await isInside(root, join(root, "jn", "t.json"))).toBe(true);
  expect(await isInside(root, join(dir, "jin", "t.json"))).toBe(true);
  expect(await isInside(root, join(outside, "t.json"))).toBe(false);
});

// Usefulness: verifies a file symlink outside the directory whose target is inside counts as inside
// (the write lands there), and a link inside that points outside still counts (path as written).
test("isInside judges the target of a file symlink as well as the path as written", async (ctx) => {
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlinkOrSkip(ctx, join(root, "t.json"), join(outside, "to-inside.json"));
  await symlinkOrSkip(ctx, join(outside, "t.json"), join(root, "to-outside.json"));
  expect(await isInside(root, join(outside, "to-inside.json"))).toBe(true);
  expect(await isInside(root, join(root, "to-outside.json"))).toBe(true);
  expect(await isInside(root, join(outside, "plain.json"))).toBe(false);
});

// Usefulness: verifies a link and its target share one session record, so the record the writer
// keeps for the target is the one a read through the link finds.
test("a file symlink and its target share one session record path", async (ctx) => {
  await symlinkOrSkip(ctx, join(dir, "t.json"), join(dir, "link.json"));
  expect(await sessionRecordPath(join(dir, "link.json"))).toBe(
    await sessionRecordPath(join(dir, "t.json")),
  );
});
