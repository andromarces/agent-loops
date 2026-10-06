import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  processStartTime,
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
  let refused = 0;
  // The winner holds the lock until the other five are refused, so every
  // contender meets a held lock without a timing assumption.
  const everyoneElseRefused = Promise.withResolvers();
  const contenders = await Promise.all(
    Array.from({ length: 6 }, () =>
      withStateLock(lockFile, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await everyoneElseRefused.promise;
        running -= 1;
        completed += 1;
        return "ran";
      }).catch((err) => {
        refused += 1;
        if (refused === 5) {
          everyoneElseRefused.resolve();
        }
        return err.message;
      }),
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

const MARKER_TOKEN = "b".repeat(32);
const OLD_AGE = new Date(0);

// Usefulness: verifies an unwritten lock is never stolen while its writer is
// still in flight, at any age: the writer's temp marker (named with its live pid)
// is the only evidence of the owner before the content exists (regression: an
// empty lock admitted a second owner).
test("withStateLock never steals an unwritten lock of a running writer", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "", "utf8");
  await writeFile(`${lockFile}.${process.pid}.${MARKER_TOKEN}.900001.tmp`, "{}", "utf8");
  await utimes(lockFile, OLD_AGE, OLD_AGE);

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(/not readable yet/);
  expect(await readFile(lockFile, "utf8")).toBe("");
});

// Usefulness: verifies the marker that an older agent-loop version writes (no
// token in its name) also protects an unwritten lock, so a mixed-version fleet
// keeps the guarantee for every writer that leaves a marker.
test("withStateLock honors the marker name that an older version writes", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "", "utf8");
  await writeFile(`${lockFile}.${process.pid}.900001.tmp`, "{}", "utf8");
  await utimes(lockFile, OLD_AGE, OLD_AGE);

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(/not readable yet/);
});

// Usefulness: verifies a fresh unwritten lock with no marker is kept: a running
// writer of an older version that created the file and writes no marker must not
// lose it to the new reaper (version skew; regression for the review of #488).
test("withStateLock keeps a fresh unwritten lock that has no marker", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "", "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(/not readable yet/);
  expect(await readFile(lockFile, "utf8")).toBe("");
});

// Usefulness: verifies an unparseable lock that has no marker and is older than
// the grace window is stale, so a crashed or foreign empty lock does not block
// the next contender forever.
test("withStateLock removes an old unparseable lock that has no marker", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "", "utf8");
  await utimes(lockFile, OLD_AGE, OLD_AGE);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

const CLAIM_NAME = `state.lock.reap.${"a".repeat(64)}`;

// Usefulness: verifies the issue #452 acceptance: a claim file left by a crashed
// takeover is removed by a later acquisition that meets no stale lock, so the
// leftover file does not outlive the next lock holder.
test("withStateLock removes an orphaned claim file outside a takeover", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(
    join(dir, CLAIM_NAME),
    JSON.stringify({ pid: await deadPid(), startedAt: "2026-01-01T00:00:00Z", nonce: "n" }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies an old unwritten claim file whose writer left a marker
// with a dead pid is an orphan, so a crash inside the exclusive-create window
// does not leave a file that only a takeover removes.
test("withStateLock removes an old unwritten claim file whose writer is dead", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const claimFile = join(dir, CLAIM_NAME);
  await writeFile(claimFile, "", "utf8");
  await utimes(claimFile, OLD_AGE, OLD_AGE);
  await writeFile(`${claimFile}.${await deadPid()}.${MARKER_TOKEN}.900001.tmp`, "{}", "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies the issue #452 acceptance: the unwritten claim file of a
// running process is kept at any age, because its marker protects it and no age
// can expire it. Without this, two processes could act on one claim.
test("withStateLock keeps an unwritten claim file of a running process at any age", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const claimFile = join(dir, CLAIM_NAME);
  await writeFile(claimFile, "", "utf8");
  await writeFile(`${claimFile}.${process.pid}.${MARKER_TOKEN}.900001.tmp`, "{}", "utf8");
  await utimes(claimFile, OLD_AGE, OLD_AGE);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readFile(claimFile, "utf8")).toBe("");
});

// Usefulness: verifies a fresh unwritten claim with no marker is kept by the
// scan, so the claim of a running older-version writer is never removed
// (version skew; regression for the review of #488).
test("withStateLock keeps a fresh unwritten claim file that has no marker", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(join(dir, CLAIM_NAME), "", "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readFile(join(dir, CLAIM_NAME), "utf8")).toBe("");
});

// Usefulness: verifies an old unwritten claim with no marker is an orphan, so the
// grace path ends: the leftover of a crash in an older version is removed.
test("withStateLock removes an old unwritten claim file that has no marker", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const claimFile = join(dir, CLAIM_NAME);
  await writeFile(claimFile, "", "utf8");
  await utimes(claimFile, OLD_AGE, OLD_AGE);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a written claim whose pid is alive is never removed by the
// scan, so the claim of a running takeover keeps its exclusion.
test("withStateLock keeps the claim file of a live process", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const claim = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00Z" });
  await writeFile(join(dir, CLAIM_NAME), claim, "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readFile(join(dir, CLAIM_NAME), "utf8")).toBe(claim);
});

// Usefulness: verifies a marker left by a crashed process (dead pid, per-process
// token in its name) is pruned on the next acquisition, while a live contender's
// marker is preserved (#178). Nothing else scans the lock directory, so this is
// the only cleanup.
test("withStateLock prunes a dead owner's temp file and keeps a live one", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const orphan = `state.lock.${await deadPid()}.${MARKER_TOKEN}.0.tmp`;
  const live = `state.lock.${process.pid}.${MARKER_TOKEN}.900001.tmp`;
  await writeFile(join(dir, orphan), "{}", "utf8");
  await writeFile(join(dir, live), "{}", "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([live]);
});

// Usefulness: verifies the prune never deletes a marker that has no token in its
// name (`<pid>.<n>.tmp`, written by an older version). That name is shared by every
// process that reuses the pid, so a pid query cannot prove the file orphaned:
// the query reads dead, the pid is reused and the new process writes its marker
// at the same path, and the delete would remove a live writer's marker (review of
// #488). The file holds the reusing process's marker, and every pid query reads
// dead for that pid, which is the state the delete would act on.
test("withStateLock never deletes a marker of an older version by pid liveness", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const pid = await deadPid();
  const marker = join(dir, `state.lock.${pid}.0.tmp`);
  await writeFile(marker, "reused", "utf8");
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target === pid) {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }
    return realKill(target, signal);
  });

  try {
    await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  } finally {
    kill.mockRestore();
  }

  expect(await readFile(marker, "utf8")).toBe("reused");
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

// Usefulness: verifies the state directory name stays the first 12 hex digits of
// the SHA-256 of the canonical cwd, so existing run state stays reachable.
test("statePaths names the state directory by the cwd SHA-256 prefix", () => {
  const cwd = resolve("/some/work/tree");
  // Production lowercases a Windows drive letter before it hashes.
  const canonical = cwd.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
  const expected = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  expect(basename(statePaths({ cwd }).stateDir)).toBe(expected);
});

// Usefulness: verifies null stays an invalid session id, so a caller must map
// an absent session to undefined.
test("statePaths rejects a null parentSession", () => {
  expect(() => statePaths({ parentSession: null })).toThrow(/Invalid session id/);
});

const REUSED_START = "Thu Jan  1 00:00:00 1970";

// Usefulness: verifies the issue #498 acceptance: a lock whose pid is alive but
// whose recorded start time differs is a reused pid, so it is taken over. Without
// the start time, a dead owner's lock stays until the unrelated process exits.
test("withStateLock takes over a lock whose live pid has a different start time", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: "old", startTime: REUSED_START }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
});

// Usefulness: verifies a lock whose pid and start time both match a running
// process stays busy, so the start-time check never removes a live owner's lock.
test("withStateLock keeps a lock whose live pid has the same start time", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const startTime = await processStartTime(process.pid);
  expect(startTime).toEqual(expect.any(String));
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: "old", startTime }),
    "utf8",
  );
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);
  expect(fn).not.toHaveBeenCalled();
});

// Usefulness: verifies a lock of an older version, written without a start time,
// keeps the pid-only check, so an upgrade never frees a live owner's lock.
test("withStateLock keeps a lock without a start time while its pid is alive", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: "old" }), "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a new lock records the owner's start time, so a later
// contender can tell a reused pid from the owner.
test("withStateLock records the owner start time in the lock", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");

  const content = await withStateLock(lockFile, async () => readFile(lockFile, "utf8"));

  expect(JSON.parse(content).startTime).toBe(await processStartTime(process.pid));
});

// Usefulness: verifies the orphan-claim scan applies the same reuse check, so a
// claim of a dead owner whose pid was reused is removed (issue #498).
test("withStateLock removes a claim whose live pid has a different start time", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(
    join(dir, CLAIM_NAME),
    JSON.stringify({ pid: process.pid, startedAt: "old", nonce: "n", startTime: REUSED_START }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([]);
});
