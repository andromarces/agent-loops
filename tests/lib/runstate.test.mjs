import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { STALE_LOCK_GRACE_MS, statePaths, withStateLock } from "../../src/lib/runstate.mjs";
import { deadPid } from "../runtime-helpers.mjs";

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs = [];
});

// Usefulness: verifies the lock is exclusive under concurrent contenders:
// exactly one call runs its critical section and the others reject.
test("withStateLock admits exactly one concurrent contender", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");

  let running = 0;
  let maxRunning = 0;
  let completed = 0;
  const contenders = await Promise.all(
    Array.from({ length: 6 }, () =>
      withStateLock(lockFile, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        // Long enough that every contender reaches the lock while it is held.
        await new Promise((resolve) => setTimeout(resolve, 400));
        running -= 1;
        completed += 1;
        return "ran";
      }).catch((err) => err.message),
    ),
  );

  expect(maxRunning).toBe(1);
  expect(completed).toBe(1);
  expect(contenders.filter((value) => value === "ran").length).toBe(1);
  for (const message of contenders.filter((value) => value !== "ran")) {
    expect(message).toMatch(/locked by a live process|not readable yet/);
  }
});

// Usefulness: verifies a lock held by a live pid rejects the contender and is
// left in place for its owner.
test("withStateLock rejects while a live pid holds the lock", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
  expect(JSON.parse(await readFile(lockFile, "utf8")).pid).toBe(process.pid);
});

// Usefulness: verifies a fresh unparseable lock is never stolen — the contender
// rejects and removes nothing (regression: an empty lock admitted a second owner).
test("withStateLock never steals a fresh unreadable lock", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "", "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(/not readable yet/);
  expect(await readFile(lockFile, "utf8")).toBe("");
});

// Usefulness: verifies a dead-pid lock is stale: it is removed and the call proceeds.
test("withStateLock removes a dead-pid lock as stale", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: await deadPid(), startedAt: "2026-01-01T00:00:00Z" }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

// Usefulness: verifies an unreadable lock older than the grace window is
// treated as stale, removed, and the call proceeds.
test("withStateLock removes an old unreadable lock as stale", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "", "utf8");
  const past = new Date(Date.now() - 5 * STALE_LOCK_GRACE_MS);
  await utimes(lockFile, past, past);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

// Usefulness: verifies `--cwd` variants that differ only in the Windows drive
// letter resolve to one state directory.
test("statePaths normalizes the drive letter", async () => {
  const repo = await tempDir();

  const lower = statePaths({ cwd: repo.replace(/^[A-Za-z]:/, (d) => d.toLowerCase()) });
  const upper = statePaths({ cwd: repo.replace(/^[A-Za-z]:/, (d) => d.toUpperCase()) });
  expect(lower.stateDir).toBe(upper.stateDir);
});

// Usefulness: verifies an unexpanded session placeholder cannot register a
// session index under a parent that never matches (#149), and that a real id
// shape still resolves.
test("statePaths refuses an unexpanded session placeholder", () => {
  for (const bad of [
    "${CLAUDE_SESSION_ID}",
    "$CLAUDE_SESSION_ID",
    "%CODEX_THREAD_ID%",
    "`id`",
    "ses id",
    "../../etc",
  ]) {
    expect(() => statePaths({ parentSession: bad })).toThrow(/Invalid session id/);
  }
  expect(statePaths({ parentSession: "ses_abc123" }).sessionIndexFile).toBeTruthy();
});
