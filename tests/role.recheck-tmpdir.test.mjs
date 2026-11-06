import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { SPAWNED_RUN_ENV } from "../src/lib/exec.mjs";
import { cwdHash, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role/index.mjs";
import { removePath } from "./fs-helpers.mjs";
import {
  REPORT,
  cleanup,
  dispatchArgv,
  initWorkerRun,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});

const recheck = (repo) => executeRoleCommand(withRepo(["recheck-tmpdir", "--cwd", "<repo>"], repo));

/** A reviewer reply that writes `names` into the inherited temporary directory `dir`. */
const leaving = (dir, names) => async () => {
  for (const name of names) await writeFile(join(dir, name), "");
  return `${REPORT}\nVerdict: accept`;
};

async function withInheritedDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "role-recheck-"));
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, dir);
    return await run(dir);
  } finally {
    vi.unstubAllEnvs();
    await removePath(dir);
  }
}

async function dispatchReviewerTurn(repo, reply) {
  return executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([reply]) },
    stdin: stdinPrompt,
  });
}

// Usefulness: verifies acceptance — a GUID .tmp name that the reviewer turn reported and that is
// gone at the later read does not reach the re-check result, while a name that stays does, and the
// command writes no state (issue #1559).
test("recheck-tmpdir drops a name gone at the later read and keeps one that stays", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const name = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
    await dispatchReviewerTurn(repo, leaving(dir, [name, "stays.txt"]));
    const before = await readRepoState(repo);
    await rm(join(dir, name));

    const result = await recheck(repo);
    expect(result.exitCode).toBe(0);
    expect(result.payload).toEqual({
      status: "ok",
      lifecycle: "active",
      inheritedTmpdirEntries: ["stays.txt"],
    });
    expect(await readRepoState(repo)).toEqual(before);
  });
});

// Usefulness: verifies requirement "several reviewer turns that report overlapping names are
// re-checked once, and a name created again counts as present" (issue #1559).
test("recheck-tmpdir dedupes overlapping turns and keeps a name created again", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    await dispatchReviewerTurn(repo, leaving(dir, ["shared.tmp", "once.tmp"]));
    await dispatchReviewerTurn(repo, leaving(dir, ["shared.tmp"]));
    await rm(join(dir, "once.tmp"));
    await rm(join(dir, "shared.tmp"));
    await writeFile(join(dir, "shared.tmp"), "");

    const result = await recheck(repo);
    expect(result.payload.inheritedTmpdirEntries).toEqual(["shared.tmp"]);
    expect((await readRepoState(repo)).inheritedTmpdirNames.sort()).toEqual([
      "once.tmp",
      "shared.tmp",
    ]);
  });
});

// Usefulness: verifies requirement "a run with no reviewer turn reports no name" (issue #1559):
// nothing was recorded, so nothing is re-checked.
test("recheck-tmpdir reports no name for a run with no reviewer turn", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  const result = await recheck(repo);
  expect(result.exitCode).toBe(0);
  expect(result.payload.inheritedTmpdirEntries).toEqual([]);
});

// Usefulness: verifies requirement "a child role never runs the parent read" (issue #1559): the
// command is refused through the run marker, as extend is.
test("recheck-tmpdir is refused for a child role", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  vi.stubEnv(SPAWNED_RUN_ENV, cwdHash(repo));
  const result = await recheck(repo);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("refused for a child role");
});

// Usefulness: verifies requirement "a recorded name with a separator or .. never resolves outside
// the inherited directory" (issue #1559): each unsafe name cannot be re-checked, so it stays
// listed and no file outside the directory is read.
test("recheck-tmpdir keeps an unsafe recorded name and resolves no path", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = ["../outside.txt", "a/b", "kept.txt"];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, "kept.txt"), "");

    const result = await recheck(repo);
    expect(result.payload.inheritedTmpdirEntries).toEqual(["../outside.txt", "a/b", "kept.txt"]);
  });
});

// Usefulness: verifies requirement "the re-read reports names only, redacted and capped at 20 at
// the reporting boundary" (issue #1559, ADR 0017): a recorded name can echo a secret value.
test("recheck-tmpdir redacts and caps its reported names", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    vi.stubEnv("PROBE_API_TOKEN", "s3cr3t-value-9402");
    const names = ["a-probe-s3cr3t-value-9402"];
    for (let i = 0; i < 24; i += 1) names.push(`p${String(i).padStart(2, "0")}`);
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = names;
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    for (const name of names) await writeFile(join(dir, name), "");

    const result = await recheck(repo);
    const reported = result.payload.inheritedTmpdirEntries;
    expect(reported).toHaveLength(20);
    expect(reported).toContain("a-probe-[redacted:PROBE_API_TOKEN]");
    expect(JSON.stringify(reported)).not.toContain("s3cr3t-value-9402");
  });
});
