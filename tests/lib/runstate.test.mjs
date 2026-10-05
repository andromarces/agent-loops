import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  STALE_LOCK_GRACE_MS,
  readState,
  readStatesForSession,
  statePaths,
  withStateLock,
  writeSessionEntry,
} from "../../src/lib/runstate.mjs";
import { deadPid, removePath, restoreRunsRoot } from "../runtime-helpers.mjs";

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

// Usefulness: verifies the lock is exclusive under concurrent contenders:
// exactly one call runs its critical section and the others reject.
// Atomic creation (#176) removes the half-written-lock window, but the
// removal race remains: a contender that loses the link race can still read
// after the winner releases, so both fail-closed refusals stay valid here.
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
  expect(await readdir(dir)).toEqual([]);
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

// Usefulness: verifies a lock temp file left by a crashed process (dead pid) is
// pruned on the next acquisition, while a live contender's temp is preserved
// (#178). Nothing else scans the lock directory, so this is the only cleanup.
test("withStateLock prunes a dead owner's temp file and keeps a live one", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const orphan = `state.lock.${await deadPid()}.0.tmp`;
  const live = `state.lock.${process.pid}.7.tmp`;
  await writeFile(join(dir, orphan), "{}", "utf8");
  await writeFile(join(dir, live), "{}", "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([live]);
});

const CLAIM_ID = "a".repeat(64);

async function deadOwnerText() {
  return JSON.stringify({ pid: await deadPid(), startedAt: "old", nonce: "n" });
}

// Usefulness: verifies a claim file left by a crashed process is removed on the next acquisition even when no stale lock exists, so it no longer waits for a contender to meet the same stale lock (#377). A live claim, an unreadable claim, and a foreign file with a similar name stay.
test("withStateLock removes a dead owner's orphan claim and keeps every other file", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const live = JSON.stringify({ pid: process.pid, startedAt: "now", nonce: "n" });
  const keep = {
    [`state.lock.reap.${"b".repeat(64)}`]: live,
    [`state.lock.reap.${"c".repeat(64)}`]: "not json",
    [`state.lock.reap.${"d".repeat(63)}`]: await deadOwnerText(),
    [`other.lock.reap.${CLAIM_ID}`]: await deadOwnerText(),
  };
  await writeFile(join(dir, `state.lock.reap.${CLAIM_ID}`), await deadOwnerText(), "utf8");
  for (const [name, text] of Object.entries(keep)) {
    await writeFile(join(dir, name), text, "utf8");
  }

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect((await readdir(dir)).sort()).toEqual(Object.keys(keep).sort());
});

function guardNameFor(claimName, text) {
  const id = createHash("sha256")
    .update(JSON.stringify([claimName, text]))
    .digest("hex");
  return `state.lock.reap.${id}`;
}

// Usefulness: verifies the scan never takes over the guard claim of a dead claim, even when that guard is an unfilled file older than the grace window (a live contender that created it and has not yet written or finished). Taking it over would delete a live claim and let two contenders act on one claim (#377).
test("withStateLock leaves a dead claim whose guard claim is unfilled and old", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const claimName = `state.lock.reap.${CLAIM_ID}`;
  const text = await deadOwnerText();
  await writeFile(join(dir, claimName), text, "utf8");
  const guard = join(dir, guardNameFor(claimName, text));
  await writeFile(guard, "", "utf8");
  const past = new Date(Date.now() - 5 * STALE_LOCK_GRACE_MS);
  await utimes(guard, past, past);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect((await readdir(dir)).sort()).toEqual([claimName, basename(guard)].sort());
  expect(await readFile(guard, "utf8")).toBe("");
});

// Usefulness: verifies the scan leaves a dead claim whose guard claim is held by a live contender, so exactly one contender acts on each claim (#377).
test("withStateLock leaves a dead claim whose guard claim a live contender holds", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const claimName = `state.lock.reap.${CLAIM_ID}`;
  const text = await deadOwnerText();
  await writeFile(join(dir, claimName), text, "utf8");
  const guard = guardNameFor(claimName, text);
  const liveText = JSON.stringify({ pid: process.pid, startedAt: "now", nonce: "n" });
  await writeFile(join(dir, guard), liveText, "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect((await readdir(dir)).sort()).toEqual([claimName, guard].sort());
  expect(await readFile(join(dir, guard), "utf8")).toBe(liveText);
});

// Usefulness: verifies a chain of dead claims, each guarding the one before it, is cleared from the guard end by one acquisition (#377).
test("withStateLock clears a chain of dead claims", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const first = `state.lock.reap.${CLAIM_ID}`;
  const firstText = await deadOwnerText();
  const second = guardNameFor(first, firstText);
  await writeFile(join(dir, first), firstText, "utf8");
  await writeFile(join(dir, second), await deadOwnerText(), "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
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
// session entry under a parent that never matches (#149), and that a real id
// shape still resolves.
test("statePaths refuses an unexpanded session placeholder", () => {
  for (const bad of [
    "${CLAUDE_SESSION_ID}",
    "$CLAUDE_SESSION_ID",
    "%CODEX_THREAD_ID%",
    "<parent-session-id>",
    "`id`",
    "ses id",
    "../../etc",
  ]) {
    expect(() => statePaths({ parentSession: bad })).toThrow(/Invalid session id/);
  }
  expect(statePaths({ parentSession: "ses_abc123" }).sessionRunsDir).toBeTruthy();
});

// Usefulness: verifies the per-run entry name matches the state directory name
// and is stable across archives, while a different work tree gets a different
// entry, so a parent session can register several concurrent runs without one
// overwriting another (#212).
test("statePaths names each session entry after its work tree", async () => {
  const repoA = await tempDir();
  const repoB = await tempDir();
  const parentSession = "ses_multi";

  const a = statePaths({ cwd: repoA, parentSession });
  const b = statePaths({ cwd: repoB, parentSession });
  expect(a.sessionEntryFile).toBe(join(a.sessionRunsDir, basename(a.stateDir)));
  expect(a.sessionEntryFile).not.toBe(b.sessionEntryFile);
  // The state file path is constant across archives, so the entry stays valid
  // for the next run in the same work tree.
  expect(statePaths({ cwd: repoA, parentSession }).sessionEntryFile).toBe(a.sessionEntryFile);
  // The legacy index path is a file, not the new directory, so the two coexist.
  expect(a.legacyIndexFile).not.toBe(a.sessionRunsDir);
});

// Usefulness: verifies a temp file left by an interrupted atomic entry write is
// never read as a run entry, so a crashed write cannot register a spurious run
// or a duplicate of a real one (#212).
test("readStatesForSession ignores an entry temp file", async () => {
  const runsRoot = await tempDir();
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
  try {
    const cwd = await tempDir();
    const paths = statePaths({ cwd, parentSession: "ses_tmp" });
    await mkdir(dirname(paths.stateFile), { recursive: true });
    await writeFile(
      paths.stateFile,
      JSON.stringify({ parentSession: "ses_tmp", lifecycle: "active" }),
      "utf8",
    );
    await writeSessionEntry(paths.sessionEntryFile, paths.stateFile);
    await mkdir(paths.sessionRunsDir, { recursive: true });
    await writeFile(join(paths.sessionRunsDir, "deadbeef.tmp"), `${paths.stateFile}\n`, "utf8");

    expect(await readStatesForSession("ses_tmp")).toEqual([
      { parentSession: "ses_tmp", lifecycle: "active" },
    ]);
  } finally {
    restoreRunsRoot();
  }
});

// Usefulness: verifies a state file that is valid JSON but not an object throws with its path; no other test reaches this error path.
test("readState throws on a state file that is not a JSON object", async () => {
  const dir = await tempDir();
  const stateFile = join(dir, "state.json");

  for (const text of ["[]", "null", "7"]) {
    await writeFile(stateFile, text);
    await expect(readState(stateFile)).rejects.toThrow(
      `State file is not a JSON object: ${stateFile}`,
    );
  }
});
