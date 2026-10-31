import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vite-plus/test";
import { execa } from "execa";
import { snapshot } from "../src/lib/snapshot.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  REPORT,
  stdinPrompt,
  withRepo,
  WORKER_REPLY,
} from "./role-helpers.mjs";
import { removePath } from "./runtime-helpers.mjs";
import { createBarrierTest } from "./barrier-test.mjs";

// Answers `git` from memory for the tests that switch it on (see
// `gitWhileDotGitExists` in runtime-helpers.mjs); every other test reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

afterEach(async () => {
  gitDouble.answer = null;
  await cleanup();
});

// Usefulness: verifies requirement "a worker envelope carries the work tree state from a snapshot
// taken after the turn" (issue #910): a worker that leaves an uncommitted change shows clean: false
// before any reviewer runs, and a worker that leaves none shows clean: true at the real head.
test("worker dispatch reports the work tree state from after the turn", async () => {
  const repo = await newRunRepo();
  const dirtyingWorker = recordingAdapter([
    async (_state, _prompt, options) => {
      await writeFile(join(options.cwd, "init.txt"), "left uncommitted\n");
      return WORKER_REPLY;
    },
  ]);
  const agents = { fake1: dirtyingWorker, fake2: recordingAdapter([]) };

  const dirty = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(dirty.payload.workTree).toEqual({ head: (await snapshot(repo)).head, clean: false });
  expect(dirty.payload.reviewed).toBeUndefined();

  await writeFile(join(repo, "init.txt"), "hello\n");
  await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  const state = await readRepoState(repo);
  expect(state.lastResult.workTree.clean).toBe(true);
  expect(state.lastResult.workTree.head).toMatch(/^[0-9a-f]{40}$/);
});

// Usefulness: verifies requirement "a worker turn that changes shared Git state reports the item
// names beside workTree, and a turn that changes none carries no field" (issue #984). The
// work tree snapshot alone shows clean: true for a hook or remote change made from a linked work tree.
test("worker dispatch reports shared Git state changed outside the work tree", async () => {
  const repo = await newRunRepo();
  const parent = await mkdtemp(join(tmpdir(), "role-dispatch-linked-"));
  const linked = join(parent, "linked");
  await execa("git", ["worktree", "add", "-b", "linked-branch", linked], { cwd: repo });
  try {
    const sharedChangingWorker = recordingAdapter([
      async (_state, _prompt, options) => {
        await execa("git", ["remote", "add", "origin", "https://user:token-9@example.test/a.git"], {
          cwd: options.cwd,
        });
        await execa("git", ["config", "core.hooksPath", "private-hooks"], { cwd: options.cwd });
        return WORKER_REPLY;
      },
    ]);
    const agents = { fake1: sharedChangingWorker, fake2: recordingAdapter([]) };

    const changed = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(changed.payload.workTree.clean).toBe(true);
    expect(changed.payload.sharedGitChanged).toEqual(["core.hooksPath", "remote.origin"]);
    expect(JSON.stringify(changed.payload)).not.toMatch(/token-9|private-hooks/);
    expect((await readRepoState(linked)).lastResult.sharedGitChanged).toEqual([
      "core.hooksPath",
      "remote.origin",
    ]);

    const unchanged = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(unchanged.payload.workTree).toBeDefined();
    expect(unchanged.payload).not.toHaveProperty("sharedGitChanged");
  } finally {
    await removePath(parent);
  }
});

// Usefulness: verifies requirement "a worker turn that changes the lockfile reports its path, and a
// turn that changes none carries no field" (issue #1180). The parent installs once before the first
// dispatch, so a lockfile change is the only sign that the next reviewer sees stale dependencies.
test("worker dispatch reports a lockfile change by path and omits the field otherwise", async () => {
  const repo = await newRunRepo();
  const lockfileWorker = recordingAdapter([
    async (_state, _prompt, options) => {
      await writeFile(join(options.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return WORKER_REPLY;
    },
    async (_state, _prompt, options) => {
      await writeFile(join(options.cwd, "notes.txt"), "not a lockfile\n");
      return WORKER_REPLY;
    },
    async (_state, _prompt, options) => {
      await writeFile(join(options.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
      return WORKER_REPLY;
    },
  ]);
  const agents = { fake1: lockfileWorker, fake2: recordingAdapter([]) };

  const changed = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(changed.payload.lockfileChanged).toEqual(["pnpm-lock.yaml"]);
  expect((await readRepoState(repo)).lastResult.lockfileChanged).toEqual(["pnpm-lock.yaml"]);

  const unchanged = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(unchanged.payload.status).toBe("ok");
  expect(unchanged.payload).not.toHaveProperty("lockfileChanged");

  const edited = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(edited.payload.lockfileChanged).toEqual(["pnpm-lock.yaml"]);
});

// Usefulness: verifies requirement "an interrupted worker dispatch reports the lockfile change in the
// envelope and `lastResult`" (issue #1180): after a resume, an unchanged turn cannot recover the
// reinstall signal, so the canceled turn that edited the lockfile must carry it.
test("a canceled worker dispatch still reports the lockfile it changed", async () => {
  const repo = await newRunRepo();
  const cancelingWorker = recordingAdapter([
    async (_state, _prompt, options) => {
      await writeFile(join(options.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      throw Object.assign(new Error("canceled"), { isCanceled: true });
    },
  ]);
  const agents = { fake1: cancelingWorker, fake2: recordingAdapter([]) };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(130);
  expect(result.payload.lockfileChanged).toEqual(["pnpm-lock.yaml"]);
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("interrupted");
  expect(state.lastResult.lockfileChanged).toEqual(["pnpm-lock.yaml"]);
});

// Runs `body(linked, repo)` with a linked work tree of a fresh repository. The worker adapters of
// the shared Git tests act on the linked work tree.
async function withLinkedWorkTree(body) {
  const repo = await newRunRepo();
  const parent = await mkdtemp(join(tmpdir(), "role-dispatch-linked-"));
  const linked = join(parent, "linked");
  await execa("git", ["worktree", "add", "-b", "linked-branch", linked], { cwd: repo });
  try {
    await body(linked, repo);
  } finally {
    await removePath(parent);
  }
}

// Usefulness: verifies requirement "a worker turn that fails after it changed shared Git state
// still reports the item names" (issue #984): the failed turn is the one that most needs the report.
test("a failed worker turn still reports the shared Git state it changed", async () => {
  await withLinkedWorkTree(async (linked) => {
    const failingWorker = recordingAdapter([
      async (_state, _prompt, options) => {
        await execa("git", ["remote", "add", "origin", "https://user:token-9@example.test/a.git"], {
          cwd: options.cwd,
        });
        throw new Error("adapter failed after the change");
      },
    ]);
    const agents = { fake1: failingWorker, fake2: recordingAdapter([]) };

    const failed = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(failed.payload).toMatchObject({ role: "worker", status: "error" });
    expect(failed.payload.sharedGitChanged).toEqual(["remote.origin"]);
    expect(JSON.stringify(failed.payload)).not.toContain("token-9");
    expect((await readRepoState(linked)).lastResult.sharedGitChanged).toEqual(["remote.origin"]);
  });
});

// Usefulness: verifies requirement "an unreadable shared Git state omits the field instead of
// reporting a false change" (issue #984): a post-turn `git config` read that exits unexpectedly
// would otherwise read as every remote removed and core.hooksPath unset.
test("a worker turn whose post-turn shared Git read fails reports no shared Git change", async () => {
  await withLinkedWorkTree(async (linked, repo) => {
    await execa("git", ["remote", "add", "origin", "https://example.test/a.git"], { cwd: repo });
    await execa("git", ["config", "core.hooksPath", "hooks-a"], { cwd: repo });
    const { execa: realExeca } = await vi.importActual("execa");
    const breakingWorker = recordingAdapter([
      async () => {
        gitDouble.answer = (command, args, options) =>
          args[0] === "config"
            ? { exitCode: 128, stdout: "", stderr: "fatal: bad config line 1" }
            : realExeca(command, args, options);
        return WORKER_REPLY;
      },
    ]);
    const agents = { fake1: breakingWorker, fake2: recordingAdapter([]) };

    const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(result.payload.status).toBe("ok");
    expect(result.payload).not.toHaveProperty("sharedGitChanged");
  });
});

// Usefulness: verifies requirement "an interrupted worker dispatch reports the shared Git change in
// the envelope and `lastResult`" (issue #1224): a canceled turn that changed `core.hooksPath` or a
// remote leaves no other trace, and the change affects every work tree of the repository.
test("a canceled worker dispatch still reports the shared Git state it changed", async () => {
  await withLinkedWorkTree(async (linked) => {
    const cancelingWorker = recordingAdapter([
      async (_state, _prompt, options) => {
        await execa("git", ["remote", "add", "origin", "https://user:token-9@example.test/a.git"], {
          cwd: options.cwd,
        });
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
    ]);
    const agents = { fake1: cancelingWorker, fake2: recordingAdapter([]) };

    const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(result.exitCode).toBe(130);
    expect(result.payload.sharedGitChanged).toEqual(["remote.origin"]);
    expect(JSON.stringify(result.payload)).not.toContain("token-9");
    const state = await readRepoState(linked);
    expect(state.lifecycle).toBe("interrupted");
    expect(state.lastResult.sharedGitChanged).toEqual(["remote.origin"]);
  });
});

// Usefulness: verifies requirement "a failed shared Git read warns without the Git stderr or a
// hook path, and leaves the envelope and the state file free of both" (issue #992): the unit tests
// cover the thrown error, and only a dispatch covers the warning that the worker turn writes.
test("a failed shared Git read warns without a marker and reports no shared Git change", async () => {
  const marker = "secret-marker-9402";
  await withLinkedWorkTree(async (linked, repo) => {
    await execa("git", ["config", "core.hooksPath", `/${marker}/hooks`], { cwd: repo });
    const { execa: realExeca } = await vi.importActual("execa");
    const breakingWorker = recordingAdapter([
      async () => {
        gitDouble.answer = (command, args, options) =>
          args[0] === "config"
            ? { exitCode: 128, stdout: "", stderr: `fatal: bad config line in /${marker}/hooks` }
            : realExeca(command, args, options);
        return WORKER_REPLY;
      },
    ]);
    const agents = { fake1: breakingWorker, fake2: recordingAdapter([]) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
        agents,
        stdin: stdinPrompt,
      });
      const warnings = errorSpy.mock.calls.map((call) => call.join(" "));
      expect(warnings.some((line) => line.includes("shared Git state read failed"))).toBe(true);
      expect(warnings.join("\n")).not.toContain(marker);
      expect(result.payload.status).toBe("ok");
      expect(result.payload).not.toHaveProperty("sharedGitChanged");
      expect(JSON.stringify(result.payload)).not.toContain(marker);
      const { lastResult } = await readRepoState(linked);
      expect(lastResult).not.toHaveProperty("sharedGitChanged");
      expect(JSON.stringify(lastResult)).not.toContain(marker);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Usefulness: verifies the dispatch seam carries the optional Checks, Notes,
// and Deferred labels from a reviewer turn into the envelope (issue #214,
// issue #217).
test("reviewer dispatch carries the optional Checks, Notes, and Deferred labels", async () => {
  const repo = await newRunRepo();

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-notes";
    return `${REPORT}\nChecks: npm test\nNotes: tidy the helper later\nDeferred: migrate the legacy path\nVerdict: accept`;
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toMatchObject({
    checks: "npm test",
    notes: "tidy the helper later",
    deferred: "migrate the legacy path",
  });
});

// Usefulness: verifies each parser case below reaches the envelope through `raw` at the dispatch
// seam instead of being dropped, so the next turn still sees the text (issues #229, #240, #243, #249).
test.each([
  {
    name: "a list that a blank line separates from its empty label",
    extra: "\nNotes:\n\n- item one\n- item two",
    expected: "item one",
  },
  {
    name: "a decorated label",
    extra: "\nNotes: tidy\n**Deferred:** migrate the legacy path",
    expected: "migrate the legacy path",
  },
  {
    name: "a spaceless bullet under a label with a value",
    extra: "\nDeferred: later\n-migrate the legacy path",
    expected: "migrate the legacy path",
  },
  {
    name: "a list under the Blockers label",
    extra: "\nBlockers: see below\n* real blocker",
    expected: "real blocker",
  },
  {
    name: "a list under a shadowed earlier label",
    extra: "\nNotes: first pass\n- dropped item\nNotes: second pass",
    expected: "dropped item",
  },
])("worker dispatch carries $name into raw", async ({ extra, expected }) => {
  const repo = await newRunRepo();

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-raw";
    return `${REPORT}${extra}`;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toContain(expected);
});

// Usefulness: verifies the dispatch seam when the closing block does not parse
// — the payload carries a null report and the raw response, so a caller can
// still inspect what the child returned instead of guessing.
test("reviewer dispatch exposes a null report and the raw response when the block does not parse", async () => {
  const repo = await newRunRepo();

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-raw";
    return "looks fine, but no verdict line here";
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.verdict).toBe("unknown");
  expect(result.payload.raw).toContain("looks fine");
});

// Usefulness: verifies a closing block longer than the old 2000-character bound
// keeps its whole text in `raw`, including a dropped list near the head, so the
// flagged line still fails safe when the block is long (issue #268). A tail-only
// fallback loses the head of the block, so this test fails against that behavior.
test("worker dispatch carries the whole response in raw when the closing block is long", async () => {
  const repo = await newRunRepo();

  const response = [
    "Conclusion: done",
    "Notes: see below",
    "* dropped marker ALPHA",
    `Why: ${"x".repeat(2500)}`,
    "Blockers: none",
  ].join("\n");

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-long-raw";
    return response;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toBe(response);
});

// Usefulness: verifies requirement "a denied shell call shows in the result of the turn" (issue #713) at the envelope: the parent sees `shellDenied`, and the role state keeps no stale flag.
test("worker dispatch carries shellDenied in the envelope when the adapter flags a denied shell call", async () => {
  const repo = await newRunRepo();

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-denied";
    state.shellDenied = true;
    return REPORT;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.status).toBe("ok");
  expect(result.payload.shellDenied).toBe(true);
  expect((await readRepoState(repo)).roles.worker).not.toHaveProperty("shellDenied");
});

// Usefulness: verifies requirement "the flag follows read-only turns too" (issue #713, ADR 0035): a reviewer envelope carries `shellDenied`, and a later reviewer turn with no denial carries none.
test("reviewer dispatch carries shellDenied only for the turn that had it", async () => {
  const repo = await newRunRepo();

  const reviewer = recordingAdapter([
    (state) => {
      state.sessionId = "rev-denied";
      state.shellDenied = true;
      return `${REPORT}\nVerdict: accept`;
    },
    `${REPORT}\nVerdict: accept`,
  ]);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const deps = { agents: { fake1: recordingAdapter([]), fake2: reviewer }, stdin: stdinPrompt };
  const first = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), deps);
  const second = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), deps);

  expect(first.payload.shellDenied).toBe(true);
  expect(second.payload.status).toBe("ok");
  expect(second.payload).not.toHaveProperty("shellDenied");
});

// Usefulness: verifies requirement "the envelope names a transient failure" (issue #1012): a reviewer turn that fails with a flagged error carries `transient`, the step stays charged, and a later plain failure carries no field.
test("reviewer dispatch carries transient in the error envelope only for a flagged failure", async () => {
  const repo = await newRunRepo();

  const reviewer = recordingAdapter([
    () => {
      throw Object.assign(new Error("codex exited with code 1."), { transient: "capacity" });
    },
    () => {
      throw new Error("codex exited with code 1.");
    },
  ]);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const deps = { agents: { fake1: recordingAdapter([]), fake2: reviewer }, stdin: stdinPrompt };
  const first = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), deps);
  const stepsAfterFirst = (await readRepoState(repo)).stepsUsed;
  const second = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), deps);

  expect(first.exitCode).toBe(1);
  expect(first.payload).toMatchObject({ role: "reviewer", status: "error", transient: "capacity" });
  expect(stepsAfterFirst).toBe(2);
  expect(second.payload.status).toBe("error");
  expect(second.payload).not.toHaveProperty("transient");
});

// Usefulness: verifies requirement "a reviewer turn that leaves a directory in the inherited
// temporary directory reports its name in the envelope and the state file, and a turn that leaves
// none carries no field" (issue #1024). The child-turn tests cover the read; only a dispatch
// covers the envelope and the state file.
test("reviewer dispatch reports a directory left in the inherited temporary directory", async () => {
  const repo = await newRunRepo();
  const temp = await mkdtemp(join(tmpdir(), "role-dispatch-inherited-"));
  try {
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temp);
    const leaving = recordingAdapter([
      async () => {
        await mkdir(join(temp, "m54-3db54ca8"));
        return WORKER_REPLY;
      },
    ]);
    const left = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: leaving },
      stdin: stdinPrompt,
    });
    expect(left.payload.inheritedTmpdirEntries).toEqual(["m54-3db54ca8"]);
    expect((await readRepoState(repo)).lastResult.inheritedTmpdirEntries).toEqual(["m54-3db54ca8"]);

    const clean = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    });
    expect(clean.payload).not.toHaveProperty("inheritedTmpdirEntries");
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
  }
});

// Usefulness: verifies requirement "a halted reviewer dispatch keeps the entries in the envelope
// and the state file" (issue #1024): a mutation halts the run through a thrown error, and the
// envelope is built from that error.
test("a halted reviewer dispatch reports a directory left in the inherited temporary directory", async () => {
  const repo = await newRunRepo();
  const temp = await mkdtemp(join(tmpdir(), "role-dispatch-inherited-"));
  try {
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temp);
    const mutating = recordingAdapter([
      async () => {
        await mkdir(join(temp, "m54-3db54ca8"));
        await writeFile(join(repo, "leak.txt"), "leak\n");
        return WORKER_REPLY;
      },
    ]);
    const halted = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: mutating },
      stdin: stdinPrompt,
    });
    expect(halted.exitCode).toBe(1);
    expect(halted.payload.inheritedTmpdirEntries).toEqual(["m54-3db54ca8"]);
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("halted");
    expect(state.lastResult.inheritedTmpdirEntries).toEqual(["m54-3db54ca8"]);
  } finally {
    vi.unstubAllEnvs();
    await removePath(temp);
  }
});

// Usefulness: verifies requirement "a reviewer dispatch that changed the package store reports the
// names in the envelope and the state file, a halted dispatch keeps them, and a turn that changed
// none carries no field" (issue #1045). The child-turn tests cover the read; only a dispatch covers
// the envelope and the state file.
test("reviewer dispatch reports a package store change, halted or not", async () => {
  const repo = await newRunRepo();
  const store = await mkdtemp(join(tmpdir(), "role-dispatch-store-"));
  try {
    await mkdir(join(store, "v11", "projects"), { recursive: true });
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(
      join(repo, "node_modules", ".modules.yaml"),
      JSON.stringify({ storeDir: join(store, "v11") }),
    );
    const installing = (leak) =>
      recordingAdapter([
        async () => {
          await mkdir(join(store, "v11", "projects", leak ? "hash2" : "hash1"));
          if (leak) await writeFile(join(repo, "leak.txt"), "leak\n");
          return WORKER_REPLY;
        },
      ]);
    const left = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: installing(false) },
      stdin: stdinPrompt,
    });
    expect(left.payload.packageStoreEntries).toEqual(["v11/projects/hash1"]);
    expect((await readRepoState(repo)).lastResult.packageStoreEntries).toEqual([
      "v11/projects/hash1",
    ]);

    const clean = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    });
    expect(clean.payload).not.toHaveProperty("packageStoreEntries");

    const halted = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: installing(true) },
      stdin: stdinPrompt,
    });
    expect(halted.exitCode).toBe(1);
    expect(halted.payload.packageStoreEntries).toEqual(["v11/projects/hash2"]);
    expect((await readRepoState(repo)).lastResult.packageStoreEntries).toEqual([
      "v11/projects/hash2",
    ]);
  } finally {
    vi.unstubAllEnvs();
    await removePath(store);
  }
});
