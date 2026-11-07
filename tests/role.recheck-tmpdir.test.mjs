import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { SPAWNED_RUN_ENV } from "../src/lib/exec.mjs";
import { cwdHash, statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role/index.mjs";
import { removePath } from "./fs-helpers.mjs";
import { deadPid } from "./process-helpers.mjs";
import {
  GATE_SUMMARY,
  REPORT,
  cleanup,
  dispatchArgv,
  finishCall,
  initWorkerRun,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});

const recheck = (repo, extra = ["--parent-session", "parent-sess-1"], deps = {}) =>
  executeRoleCommand(withRepo(["recheck-tmpdir", "--cwd", "<repo>", ...extra], repo), {
    tmpdirSettle: { boundMs: 20, intervalMs: 10 },
    ...deps,
  });

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

// The poll tests read only the state file, so they need no Git repository and no dispatch.
async function newStateRun() {
  await setup();
  const repo = await mkdtemp(join(tmpdir(), "role-recheck-state-"));
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  await mkdir(paths.stateDir, { recursive: true });
  await writeState(paths.stateFile, {
    cwd: repo,
    parentSession: "parent-sess-1",
    lifecycle: "active",
    inheritedTmpdirNames: [],
  });
  return repo;
}

async function dispatchReviewerTurn(repo, reply) {
  return executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([reply]) },
    stdin: stdinPrompt,
  });
}

// Usefulness: verifies acceptance. A name gone at the later read is left out, and a name that
// stays is kept (issue #1559). The command writes no state.
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

// Usefulness: verifies acceptance. A name removed during the wait returns before the bound. A GUID
// `.tmp` file that another process removes stays out of the finish summary (issue #1569).
test("recheck-tmpdir returns before the bound once a name removed during the wait is gone", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const name = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = [name];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, name), "");
    let clock = 0;

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      tmpdirSettle: {
        boundMs: 60_000,
        intervalMs: 5_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          await rm(join(dir, name));
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.payload.inheritedTmpdirEntries).toEqual([]);
    expect(clock).toBeLessThan(60_000);
  });
});

// Usefulness: verifies a name that stays until the final read is reported, and the command ends by
// the bound (issue #1569).
test("recheck-tmpdir reports a name that stays until the final read", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = ["stays.txt"];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, "stays.txt"), "");
    let clock = 0;

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      tmpdirSettle: {
        boundMs: 30,
        intervalMs: 10,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    });

    expect(result.payload.inheritedTmpdirEntries).toEqual(["stays.txt"]);
    expect(clock).toBe(15);
    expect(clock).toBeLessThanOrEqual(30);
  });
});

// Usefulness: verifies requirement "a later poll whose read fails keeps every name still listed"
// (issue #1569). A lost name can hide a leftover.
test("recheck-tmpdir keeps every name when a later poll fails", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = ["a.tmp", "b.tmp"];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, "a.tmp"), "");
    let clock = 0;
    let reads = 0;

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      read: async () => {
        reads += 1;
        if (reads === 1) return ["a.tmp"];
        throw new Error("EACCES");
      },
      tmpdirSettle: {
        boundMs: 20,
        intervalMs: 10,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    });

    expect(result.payload.inheritedTmpdirEntries).toEqual(["a.tmp"]);
    expect(reads).toBeGreaterThan(1);
  });
});

// Usefulness: verifies a missing inherited directory keeps every name and pays no wait (issue
// #1569).
test("recheck-tmpdir keeps every name when the inherited directory is missing", async () => {
  const repo = await newStateRun();
  const state = await readRepoState(repo);
  state.inheritedTmpdirNames = ["a.tmp", "gone.tmp"];
  await writeState(statePaths({ cwd: repo }).stateFile, state);
  let slept = false;
  for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, join(repo, "missing-tmpdir"));

  const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
    tmpdirSettle: {
      sleep: async () => {
        slept = true;
      },
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.inheritedTmpdirEntries).toEqual(["a.tmp", "gone.tmp"]);
  expect(slept).toBe(false);
});

// Usefulness: verifies a cancel during the wait ends with the SIGINT envelope and deletes nothing
// (issue #1569).
test("recheck-tmpdir ends a canceled wait without deleting a name", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = ["stays.txt"];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, "stays.txt"), "");
    const controller = new AbortController();
    let clock = 0;

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      signal: controller.signal,
      tmpdirSettle: {
        boundMs: 60_000,
        intervalMs: 5_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          controller.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      },
    });

    expect(result.exitCode).toBe(130);
    expect(result.payload.error).toBe("Interrupted by SIGINT");
    expect(existsSync(join(dir, "stays.txt"))).toBe(true);
    expect(clock).toBeLessThan(60_000);
  });
});

// Usefulness: verifies acceptance. An empty name list returns at once with no wait (issue #1569).
test("recheck-tmpdir waits for no name when the run recorded none", async () => {
  const repo = await newStateRun();
  let slept = false;

  const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
    tmpdirSettle: {
      sleep: async () => {
        slept = true;
      },
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.inheritedTmpdirEntries).toEqual([]);
  expect(slept).toBe(false);
});

// Usefulness: verifies requirement "several reviewer turns that report overlapping names are
// re-checked once" (issue #1559). A name created again counts as present.
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

// Usefulness: verifies scope cut (issue #1559). A finish never refuses a summary because it lists
// a name that the later read no longer holds. The parent rule alone keeps the name out.
test("finish accepts a summary that lists a name the later read no longer holds", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const name = "9f2d2c11-1f2a-4bb3-9c5d-6a7b8c9d0e1f.tmp";
    await dispatchReviewerTurn(repo, leaving(dir, [name]));
    await rm(join(dir, name));

    const accepted = await finishCall(repo, [], {
      stdin: async () => JSON.stringify({ ...GATE_SUMMARY, open: `left ${name}` }),
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.payload.lifecycle).toBe("finished");
    expect((await readRepoState(repo)).summary.open).toBe(`left ${name}`);
  });
});

// Usefulness: verifies requirement "the command requires the stored parent session id, as extend
// does" (issue #1559). A missing id and a different id are both refused and read nothing.
test("recheck-tmpdir refuses a missing or wrong parent session", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);

  const missing = await recheck(repo, []);
  expect(missing.exitCode).toBe(1);
  expect(missing.payload.error).toContain("recheck-tmpdir requires --parent-session");

  const wrong = await recheck(repo, ["--parent-session", "another-session"]);
  expect(wrong.exitCode).toBe(1);
  expect(wrong.payload.error).toContain("--parent-session does not match");
});

// Usefulness: verifies acceptance of issue #1575. A parent that finished the run first can still
// get the names that remain, and the terminal re-read writes no state and deletes nothing.
test("recheck-tmpdir re-reads a terminal run and still writes no state or deletes a name", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const gone = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
    const stays = "stays.txt";
    await writeFile(join(dir, gone), "");
    await writeFile(join(dir, stays), "");
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = [gone, stays];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    expect((await finishCall(repo)).exitCode).toBe(0);
    const before = await readRepoState(repo);
    await rm(join(dir, gone));

    const result = await recheck(repo);
    expect(result.exitCode).toBe(0);
    expect(result.payload).toEqual({
      status: "ok",
      lifecycle: "finished",
      inheritedTmpdirEntries: [stays],
    });
    expect(existsSync(join(dir, stays))).toBe(true);
    expect(existsSync(statePaths({ cwd: repo }).lockFile)).toBe(false);
    expect(await readRepoState(repo)).toEqual(before);
  });
});

// Usefulness: verifies requirement "a state file written before inheritedTmpdirNames existed still
// reports its reviewer names" (issue #1559). Those names live in lastResult on origin/main.
test("recheck-tmpdir includes the names that a legacy state holds in lastResult", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const state = await readRepoState(repo);
    delete state.inheritedTmpdirNames;
    state.lastResult = {
      role: "reviewer",
      status: "ok",
      inheritedTmpdirEntries: ["legacy.tmp", "gone-legacy.tmp"],
    };
    state.turns = [{ role: "reviewer", status: "ok", verdict: "accept", head: null, at: "t" }];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, "legacy.tmp"), "");

    const result = await recheck(repo);
    expect(result.payload.inheritedTmpdirEntries).toEqual(["legacy.tmp"]);
  });
});

// Usefulness: verifies the read deletes and writes nothing. A file, a directory, and a kept turn
// directory stay in place, and no state lock appears (issue #1559).
test("recheck-tmpdir deletes nothing and creates no lock", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const file = join(dir, "keep.txt");
    const sub = join(dir, "keep-dir");
    const kept = join(dir, "al-Kept12");
    await writeFile(file, "");
    await mkdir(sub);
    await mkdir(kept);
    await writeFile(join(kept, "leftover.txt"), "x");
    const info = lstatSync(kept, { bigint: true });
    const state = await readRepoState(repo);
    state.lifecycle = "interrupted";
    state.lastDispatch = {
      role: "worker",
      at: new Date().toISOString(),
      turnTmpdir: {
        dir: kept,
        parentReal: dirname(realpathSync.native(kept)),
        device: String(info.dev),
        inode: String(info.ino),
        child: { pid: await deadPid() },
      },
    };
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    expect(existsSync(statePaths({ cwd: repo }).lockFile)).toBe(false);

    const result = await recheck(repo);
    expect(result.exitCode).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(sub)).toBe(true);
    expect(existsSync(join(kept, "leftover.txt"))).toBe(true);
    expect(existsSync(statePaths({ cwd: repo }).lockFile)).toBe(false);
  });
});

// Usefulness: verifies a dispatch keeps the legacy lastResult names. The next re-read reports a
// name that only lastResult held before the dispatch replaced it (issue #1559).
test("a dispatch keeps the legacy lastResult names for the next re-read", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);
  await withInheritedDir(async (dir) => {
    const state = await readRepoState(repo);
    delete state.inheritedTmpdirNames;
    state.lastResult = {
      role: "reviewer",
      status: "ok",
      inheritedTmpdirEntries: ["legacy.tmp"],
    };
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, "legacy.tmp"), "");

    const dispatched = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    });
    expect(dispatched.exitCode).toBe(0);

    const result = await recheck(repo);
    expect(result.payload.inheritedTmpdirEntries).toEqual(["legacy.tmp"]);
  });
});

// Usefulness: verifies a changed init flag is refused, as every parent command refuses it. The
// command shares the origin/main init-field check (issue #1559).
test("recheck-tmpdir refuses a changed init flag", async () => {
  const repo = await newRunRepo();
  await initWorkerRun(repo);

  const changed = await recheck(repo, [
    "--parent-session",
    "parent-sess-1",
    "--task",
    "Other task.",
  ]);
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--task cannot be changed after init");
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

// Usefulness: verifies requirement "a child role never runs the parent read" (issue #1559). The
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
// the inherited directory" (issue #1559). Each unsafe name cannot be re-checked, so it stays
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
// the reporting boundary" (issue #1559, ADR 0017). A recorded name can echo a secret value.
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

// Usefulness: verifies acceptance. A held-open Windows name leaves inheritedTmpdirEntries, appears
// in inheritedTmpdirSettled, and the probe writes and deletes nothing (issue #1600).
test("recheck-tmpdir reports a held-open Windows name apart from the possible leftovers", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const name = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = [name];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, name), "keep");

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      platform: "win32",
      probe: async () => "held",
      tmpdirSettle: { boundMs: 60_000, intervalMs: 5_000 },
    });

    expect(result.payload).toEqual({
      status: "ok",
      lifecycle: "active",
      inheritedTmpdirEntries: [],
      inheritedTmpdirSettled: [name],
    });
    expect(await readFile(join(dir, name), "utf8")).toBe("keep");
  });
});

// Usefulness: verifies acceptance. A Windows name that no process holds open stays a possible run
// leftover (issue #1600).
test("recheck-tmpdir keeps a Windows name that no process holds open", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const name = "stays.txt";
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = [name];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, name), "");

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      platform: "win32",
      probe: async () => "free",
    });

    expect(result.payload.inheritedTmpdirEntries).toEqual([name]);
    expect(result.payload).not.toHaveProperty("inheritedTmpdirSettled");
  });
});

// Usefulness: verifies a fail-closed path. A probe that throws keeps the name in the possible
// leftovers and adds no settled field (issue #1600).
test("recheck-tmpdir keeps a Windows name whose probe throws", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const name = "a.tmp";
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = [name];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, name), "");

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      platform: "win32",
      probe: async () => {
        throw new Error("EACCES");
      },
    });

    expect(result.payload.inheritedTmpdirEntries).toEqual([name]);
    expect(result.payload).not.toHaveProperty("inheritedTmpdirSettled");
  });
});

// Usefulness: verifies acceptance. A settled name is redacted and capped exactly like the possible
// leftovers (issue #1600).
test("recheck-tmpdir redacts and caps a settled name", async () => {
  const repo = await newStateRun();
  vi.stubEnv("PROBE_API_TOKEN", "s3cr3t-value-9402");
  const names = ["a-probe-s3cr3t-value-9402"];
  for (let i = 0; i < 24; i += 1) names.push(`p${String(i).padStart(2, "0")}`);
  const state = await readRepoState(repo);
  state.inheritedTmpdirNames = names;
  await writeState(statePaths({ cwd: repo }).stateFile, state);

  const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
    read: async () => names,
    platform: "win32",
    probe: async () => "held",
  });

  expect(result.payload.inheritedTmpdirEntries).toEqual([]);
  const settled = result.payload.inheritedTmpdirSettled;
  expect(settled).toHaveLength(20);
  expect(settled).toContain("a-probe-[redacted:PROBE_API_TOKEN]");
  expect(JSON.stringify(settled)).not.toContain("s3cr3t-value-9402");
});

// Usefulness: verifies a fail-closed path. A first read that fails keeps every name and settles
// none (issue #1600).
test("recheck-tmpdir keeps every name when the first read fails", async () => {
  const repo = await newStateRun();
  const names = ["a.tmp", "b.tmp"];
  const state = await readRepoState(repo);
  state.inheritedTmpdirNames = names;
  await writeState(statePaths({ cwd: repo }).stateFile, state);

  const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
    read: async () => {
      throw new Error("EACCES");
    },
    platform: "win32",
    probe: async () => "held",
  });

  expect(result.payload.inheritedTmpdirEntries).toEqual(names);
  expect(result.payload).not.toHaveProperty("inheritedTmpdirSettled");
});

// Usefulness: verifies a cancel during a probe returns the cancel result and keeps every name
// (issue #1600).
test("recheck-tmpdir keeps every name when a probe is canceled", async () => {
  const repo = await newStateRun();
  await withInheritedDir(async (dir) => {
    const name = "a.tmp";
    const state = await readRepoState(repo);
    state.inheritedTmpdirNames = [name];
    await writeState(statePaths({ cwd: repo }).stateFile, state);
    await writeFile(join(dir, name), "");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await recheck(repo, ["--parent-session", "parent-sess-1"], {
      signal: controller.signal,
      read: async () => [name],
      platform: "win32",
      probe: () => new Promise(() => {}),
      tmpdirSettle: { boundMs: 60_000, intervalMs: 60_000 },
    });

    expect(result.exitCode).toBe(130);
    expect(result.payload.error).toBe("Interrupted by SIGINT");
    expect(existsSync(join(dir, name))).toBe(true);
    expect((await readRepoState(repo)).inheritedTmpdirNames).toEqual([name]);
  });
});

// Usefulness: verifies a cancel through settle.signal aborts the ancestry read before its bound
// (issue #1600).
test("recheck-tmpdir cancels through settle.signal before the ancestry bound", async () => {
  const repo = await newStateRun();
  const base = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b-4321-ab12cd";
  const names = [`${base}-shm`, `${base}-wal`];
  const state = await readRepoState(repo);
  state.inheritedTmpdirNames = names;
  await writeState(statePaths({ cwd: repo }).stateFile, state);
  const controller = new AbortController();
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  const pending = recheck(repo, ["--parent-session", "parent-sess-1"], {
    read: async () => names,
    platform: "darwin",
    readAncestors: () => {
      release();
      return new Promise(() => {});
    },
    pidAlive: () => true,
    statFile: async () => ({ isFile: () => true }),
    tmpdirSettle: { boundMs: 60_000, intervalMs: 60_000, signal: controller.signal },
  });
  await started;
  controller.abort();
  const result = await pending;
  expect(result.exitCode).toBe(130);
  expect(result.payload.error).toBe("Interrupted by SIGINT");
});
