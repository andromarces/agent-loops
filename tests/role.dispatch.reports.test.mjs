import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vite-plus/test";
import { execa } from "execa";
import { snapshot } from "../src/lib/snapshot.mjs";
import { executeRoleCommand } from "../src/role/index.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newCleanRunRepo,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  REPORT,
  stdinPrompt,
  withRepo,
  WORKER_REPLY,
} from "./role-helpers.mjs";
import { removePath } from "./fs-helpers.mjs";
import { roleReadsGit } from "./git-helpers.mjs";
import { createBarrierTest } from "./barrier-helpers.mjs";

// Answers `git` from memory for the tests that switch it on. See `gitWhileDotGitExists` in
// git-helpers.mjs, `roleReadsGit` for an unasserted read group, and `newCleanRunRepo` for the
// cases that assert no Git result. Every other test, and every other command, reaches the real
// `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      const answer =
        gitDouble.answer && command === "git" ? gitDouble.answer(command, args, options) : null;
      return answer ?? real.execa(command, args, options);
    },
  };
});

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

const newCleanRepo = () => newCleanRunRepo(gitDouble);

afterEach(async () => {
  gitDouble.answer = null;
  vi.unstubAllEnvs();
  await cleanup();
});

// Usefulness: verifies requirement "a worker envelope carries the work tree state from a snapshot
// taken after the turn" (issue #910): a worker that leaves an uncommitted change shows clean: false
// before any reviewer runs, and a worker that leaves none shows clean: true at the real head.
test("worker dispatch reports the work tree state from after the turn", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, lockfile: true, mainWorkTree: true });
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

// Usefulness: verifies acceptance "a repaired closing block is parsed and stored as the result
// report, and the original step stays charged" (issue #1615). The envelope carries the repaired
// report, and the repair runs as a second invocation inside the single charged step.
test("a null worker report is repaired inside one charged step", async () => {
  const repo = await newCleanRepo();
  const invalid = "Conclusion: done\nWhy: tests pass";
  const repaired =
    "Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: none\nNotes: none\nDeferred: none";
  const worker = recordingAdapter([invalid, repaired]);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: "none",
    notes: "none",
    deferred: "none",
  });
  expect(result.payload).not.toHaveProperty("raw");
  expect(worker.recorded).toHaveLength(2);
  expect(worker.recorded[1].incomingSessionId).toBe("sess-1");
  expect((await readRepoState(repo)).stepsUsed).toBe(1);
});

// Usefulness: verifies acceptance "a failed repair leaves the result not accepted, with the
// original response in raw" (issue #1615). The step stays charged and the envelope carries no
// repaired report.
test("a failed worker report repair leaves the original raw and the step charged", async () => {
  const repo = await newCleanRepo();
  const invalid = "Conclusion: done\nWhy: tests pass";
  const worker = recordingAdapter([invalid, invalid]);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toBe(invalid);
  expect(result.payload.reportMissingLabels).toEqual(["Blockers"]);
  expect(worker.recorded).toHaveLength(2);
  expect((await readRepoState(repo)).stepsUsed).toBe(1);
});

// Usefulness: verifies requirement "a worker turn whose adapter returns no string response fails"
// (issue #1496). The dispatch exits non-zero with `status: "error"`.
// The error names the missing string response, instead of `ok` with `report: null`.
test.each([
  { name: "missing", reply: async () => undefined, got: "undefined" },
  { name: "non-string", reply: async () => ({ ok: true }), got: "object" },
])("worker dispatch fails on a $name response", async ({ reply, got }) => {
  const repo = await newCleanRepo();
  const worker = recordingAdapter([reply]);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  expect(result.payload.error).toContain("no string response");
  expect(result.payload.error).toContain(got);
  expect(result.payload).not.toHaveProperty("report");
});

// Usefulness: verifies requirement "a worker turn that changes shared Git state reports the item
// names beside workTree, and a turn that changes none carries no field" (issue #984). The
// work tree snapshot alone shows clean: true for a hook or remote change made from a linked work tree.
test("worker dispatch reports shared Git state changed outside the work tree", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ lockfile: true, mainWorkTree: true });
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

// Usefulness: verifies requirement "a worker turn that writes a tracked main work tree file reports
// that path in the envelope" (issue #1448). A turn that leaves the main work tree unchanged carries
// no field. The linked work tree stays clean, so no other envelope field shows the change.
test("worker dispatch reports a main work tree change by path and omits the field otherwise", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, lockfile: true });
  const parent = await mkdtemp(join(tmpdir(), "role-dispatch-main-"));
  const linked = join(parent, "linked");
  await execa("git", ["worktree", "add", "-b", "linked-branch", linked], { cwd: repo });
  try {
    const mainChangingWorker = recordingAdapter([
      async () => {
        await writeFile(join(repo, "init.txt"), "changed in the main work tree\n");
        return WORKER_REPLY;
      },
      async () => WORKER_REPLY,
    ]);
    const agents = { fake1: mainChangingWorker, fake2: recordingAdapter([]) };

    const changed = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(changed.payload.workTree.clean).toBe(true);
    expect(changed.payload.mainWorkTreeChanged).toEqual(["init.txt"]);
    expect(JSON.stringify(changed.payload)).not.toMatch(/changed in the main work tree/);
    expect((await readRepoState(linked)).lastResult.mainWorkTreeChanged).toEqual(["init.txt"]);

    const unchanged = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), linked), {
      agents,
      stdin: stdinPrompt,
    });
    expect(unchanged.payload.workTree).toBeDefined();
    expect(unchanged.payload).not.toHaveProperty("mainWorkTreeChanged");
  } finally {
    await removePath(parent);
  }
});

// Usefulness: verifies that a worker dispatch reports a restored main work tree file in its
// envelope and its state record (issue #1556). The end-of-turn read cannot see the restored file,
// so a lost watch leaves the edit with no trace.
test("worker dispatch reports a main work tree change restored inside the turn", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, lockfile: true });
  const parent = await mkdtemp(join(tmpdir(), "role-dispatch-in-turn-"));
  const linked = join(parent, "linked");
  await execa("git", ["worktree", "add", "-b", "linked-branch", linked], { cwd: repo });
  try {
    const original = await readFile(join(repo, "init.txt"));
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let written = false;
    let watchHandle;
    const onMainWatch = (handle) => {
      watchHandle = handle;
    };
    const worker = recordingAdapter([
      async () => WORKER_REPLY,
      async () => {
        await writeFile(join(repo, "init.txt"), "changed inside the turn\n");
        written = true;
        await held;
        await writeFile(join(repo, "init.txt"), original);
        return WORKER_REPLY;
      },
    ]);
    const agents = { fake1: worker, fake2: recordingAdapter([]) };

    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
      agents,
      stdin: stdinPrompt,
      onMainWatch,
      mainWatchDeadlineMs: 60_000,
    });
    const run = executeRoleCommand(withRepo(dispatchArgv([], "worker"), linked), {
      agents,
      stdin: stdinPrompt,
      onMainWatch,
      mainWatchDeadlineMs: 60_000,
    }).catch((error) => ({ error }));
    await vi.waitFor(() => expect(written).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(watchHandle.seenFileCount()).toBeGreaterThan(0));
    release();
    const changed = await run;
    expect(changed.error).toBeUndefined();

    expect(changed.payload.mainWorkTreeChangedInTurn).toEqual(["init.txt"]);
    expect(changed.payload).not.toHaveProperty("mainWorkTreeChanged");
    expect((await readRepoState(linked)).lastResult.mainWorkTreeChangedInTurn).toEqual([
      "init.txt",
    ]);
  } finally {
    await removePath(parent);
  }
});

// Usefulness: verifies requirement "a changed key with userinfo reports no userinfo in the
// envelope, a log line, or the state file" (issue #1442). Only a dispatch covers all three.
test("worker dispatch redacts userinfo in a changed local key", async () => {
  await withLinkedWorkTree(async (linked) => {
    const marker = "redact-marker-1442";
    const worker = recordingAdapter([
      async (_state, _prompt, options) => {
        await execa(
          "git",
          ["config", "--local", `http.https://user:${marker}@example.test/.extraheader`, "value"],
          { cwd: options.cwd },
        );
        return WORKER_REPLY;
      },
    ]);
    const agents = { fake1: worker, fake2: recordingAdapter([]) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
        agents,
        stdin: stdinPrompt,
      });
      const name = "http.https://<redacted>@example.test/.extraheader";
      expect(result.payload.sharedGitChanged).toEqual([name]);
      const state = await readRepoState(linked);
      expect(state.lastResult.sharedGitChanged).toEqual([name]);
      const logs = errorSpy.mock.calls.map((call) => call.join(" "));
      expect(JSON.stringify(result.payload)).not.toContain(marker);
      expect(JSON.stringify(state)).not.toContain(marker);
      expect(logs.join("\n")).not.toContain(marker);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Usefulness: verifies requirement "a worker turn that changes the lockfile reports its path, and a
// turn that changes none carries no field" (issue #1180). The parent installs once before the first
// dispatch, so a lockfile change is the only sign that the next reviewer sees stale dependencies.
test("worker dispatch reports a lockfile change by path and omits the field otherwise", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, mainWorkTree: true });
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

// Usefulness: verifies a secret-named environment value in a dependency path is redacted in the
// envelope field, so the parent never receives the value.
test("worker dispatch redacts a secret value in a dependency path", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, mainWorkTree: true });
  const secretName = "AGENT_LOOP_TEST_TOKEN";
  const secretValue = "d1s7-very-secret-value";
  vi.stubEnv(secretName, secretValue);
  const secretWorker = recordingAdapter([
    async (_state, _prompt, options) => {
      const dir = join(options.cwd, secretValue);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "requirements.txt"), "one\n");
      return WORKER_REPLY;
    },
  ]);
  const agents = { fake1: secretWorker, fake2: recordingAdapter([]) };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(result.payload.lockfileChanged).toEqual([`[redacted:${secretName}]/requirements.txt`]);
  expect(result.payload.lockfileChanged.join(" ")).not.toContain(secretValue);
});

// Usefulness: verifies a secret value that matches a fixed root lockfile name does not change that
// name, while the non-Node path is redacted.
test("worker dispatch keeps a fixed root lockfile name byte-identical", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, mainWorkTree: true });
  const secretName = "AGENT_LOOP_TEST_TOKEN";
  const secretValue = "lock.yaml";
  vi.stubEnv(secretName, secretValue);
  const secretWorker = recordingAdapter([
    async (_state, _prompt, options) => {
      const dir = join(options.cwd, secretValue);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "requirements.txt"), "one\n");
      await writeFile(join(options.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return WORKER_REPLY;
    },
  ]);
  const agents = { fake1: secretWorker, fake2: recordingAdapter([]) };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(result.payload.lockfileChanged).toEqual([
    `[redacted:${secretName}]/requirements.txt`,
    "pnpm-lock.yaml",
  ]);
});

// Usefulness: verifies requirement "an interrupted worker dispatch reports the lockfile change in the
// envelope and `lastResult`" (issue #1180): after a resume, an unchanged turn cannot recover the
// reinstall signal, so the canceled turn that edited the lockfile must carry it.
test("a canceled worker dispatch still reports the lockfile it changed", async () => {
  const repo = await newRunRepo();
  gitDouble.answer = roleReadsGit({ sharedGit: true, mainWorkTree: true });
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
  gitDouble.answer = roleReadsGit({ lockfile: true, mainWorkTree: true });
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

// Usefulness: verifies requirement "a Git without --show-scope warns and reports no shared Git
// change" (issue #1387). A failed scoped read must warn and leave the field absent, never report a
// false change.
test("a git without --show-scope warns and reports no shared Git change", async () => {
  await withLinkedWorkTree(async (linked) => {
    const { execa: realExeca } = await vi.importActual("execa");
    const worker = recordingAdapter([
      async () => {
        gitDouble.answer = (command, args, options) =>
          args[0] === "config" && args.includes("--show-scope")
            ? { exitCode: 129, stdout: "", stderr: "error: unknown option `show-scope'" }
            : realExeca(command, args, options);
        return WORKER_REPLY;
      },
    ]);
    const agents = { fake1: worker, fake2: recordingAdapter([]) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), {
        agents,
        stdin: stdinPrompt,
      });
      const warnings = errorSpy.mock.calls.map((call) => call.join(" "));
      expect(warnings.some((line) => line.includes("shared Git state read failed"))).toBe(true);
      expect(warnings.join("\n")).not.toContain("show-scope");
      expect(result.payload.status).toBe("ok");
      expect(result.payload).not.toHaveProperty("sharedGitChanged");
    } finally {
      errorSpy.mockRestore();
    }
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
  const repo = await newCleanRepo();

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
    name: "an ordered list that two blank lines separate from its empty label",
    extra: "\nNotes:\n\n\n1. item one\n2. item two",
    expected: "item one",
  },
  {
    name: "a decorated label",
    extra: "\nNotes: tidy\n**Deferred**: migrate the legacy path",
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
  const repo = await newCleanRepo();

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

// Usefulness: verifies a null report names every required label it lacks in the envelope, the
// state file, and the warning (issue #1520). It names no response text. The first case is the
// reviewer report that starts at Why, where no Conclusion line and no prose line before it exist.
// Another case is comment shape B from the issue, without its Blockers line.
test.each([
  {
    name: "a block that starts at Why",
    response: "Why: tests pass\nBlockers: none\nChecks: npm test",
    labels: ["Conclusion"],
    warning: "lacks the required label Conclusion",
    absent: null,
  },
  {
    name: "a block without Why",
    response: [
      "The parser change lands with the new test.",
      "",
      "Step 2 of the issue is only partly met, because the reviewer reads the old path.",
      "",
      "Blockers: none",
      "Checks: pnpm test",
      "Notes: none",
      "Deferred: none",
    ].join("\n"),
    labels: ["Why"],
    warning: "lacks the required label Why",
    absent: null,
  },
  {
    name: "a folded list under Why",
    response: "Conclusion: done\nWhy:\n- tests pass\nChecks: npm test",
    labels: ["Blockers"],
    warning: "lacks the required label Blockers",
    absent: "Why",
  },
  {
    name: "a block without Conclusion and Blockers",
    response: "Why: tests pass\nChecks: npm test",
    labels: ["Conclusion", "Blockers"],
    warning: "lacks the required labels Conclusion, Blockers",
    absent: null,
  },
  {
    name: "issue #1520 comment shape B without Blockers",
    response: [
      "The worker pushed the fix, and the checks are still pending.",
      "",
      "**Why:** the report keeps every field and the path safety holds.",
      "",
      "Checks: pnpm test passed",
      "Notes: none",
      "Deferred: nothing",
    ].join("\n"),
    labels: ["Blockers"],
    warning: "lacks the required label Blockers",
    absent: null,
  },
])(
  "worker dispatch names every required label missing from $name",
  async ({ response, labels, warning, absent }) => {
    const repo = await newCleanRepo();
    // The one repair turn repeats the same unparseable response, so the original stays in `raw`.
    const worker = recordingAdapter([async () => response, async () => response]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
        agents: { fake1: worker, fake2: recordingAdapter([]) },
        stdin: stdinPrompt,
      });
      expect(result.exitCode).toBe(0);
      expect(result.payload.report).toBeNull();
      expect(result.payload.raw).toBe(response);
      expect(result.payload.reportMissingLabels).toEqual(labels);
      expect((await readRepoState(repo)).lastResult.reportMissingLabels).toEqual(labels);
      const logs = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logs).toContain(warning);
      if (absent !== null) expect(logs).not.toContain(absent);
      expect(logs).not.toContain("tests pass");
    } finally {
      errorSpy.mockRestore();
    }
  },
);

// Usefulness: verifies a parsed report carries no missing-label field, so the field marks only a
// null report that a required label caused (issue #1520).
test("worker dispatch omits reportMissingLabels for a parsed report", async () => {
  const repo = await newCleanRepo();
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload.report).not.toBeNull();
  expect(result.payload).not.toHaveProperty("reportMissingLabels");
});

// Usefulness: verifies issue #1520 comment shape A keeps every parsed field and carries no reportMissingLabels.
test("worker dispatch keeps every field for issue #1520 comment shape A", async () => {
  const repo = await newCleanRepo();
  const reply = [
    "The worker pushed the fix, and the checks are still pending.",
    "",
    "**Why:**",
    "- **Rule:** the report keeps every field",
    "- **Path safety:** nothing outside the work tree changed",
    "",
    "**Blockers:** none",
    "",
    "**Checks:** pnpm test passed",
    "**Notes:** none",
    "**Deferred:** nothing",
  ].join("\n");
  const worker = recordingAdapter([async () => reply]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload.report).toEqual({
    conclusion: "The worker pushed the fix, and the checks are still pending.",
    why: "**Rule:** the report keeps every field; **Path safety:** nothing outside the work tree changed",
    blockers: "none",
    checks: "pnpm test passed",
    notes: "none",
    deferred: "nothing",
  });
  expect(result.payload).not.toHaveProperty("reportMissingLabels");
});

// Usefulness: verifies issue #1520 comment shape B with a text Why keeps every parsed field and no reportMissingLabels.
test("worker dispatch keeps every field for issue #1520 comment shape B with a text Why", async () => {
  const repo = await newCleanRepo();
  const reply = [
    "The worker pushed the fix, and the checks are still pending.",
    "",
    "**Why:** the report keeps every field and the path safety holds.",
    "",
    "Blockers: none",
    "",
    "Checks: pnpm test passed",
    "Notes: none",
    "Deferred: nothing",
  ].join("\n");
  const worker = recordingAdapter([async () => reply]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload.report).toEqual({
    conclusion: "The worker pushed the fix, and the checks are still pending.",
    why: "the report keeps every field and the path safety holds.",
    blockers: "none",
    checks: "pnpm test passed",
    notes: "none",
    deferred: "nothing",
  });
  expect(result.payload).not.toHaveProperty("reportMissingLabels");
});

// Usefulness: verifies issue #1520 comment shape B with a bullet Why keeps every parsed field and no reportMissingLabels.
test("worker dispatch keeps every field for issue #1520 comment shape B with a bullet Why", async () => {
  const repo = await newCleanRepo();
  const reply = [
    "The worker pushed the fix, and the checks are still pending.",
    "",
    "**Why:**",
    "- **Rule:** the report keeps every field",
    "- **Path safety:** nothing outside the work tree changed",
    "",
    "Blockers: none",
    "",
    "Checks: pnpm test passed",
    "Notes: none",
    "Deferred: nothing",
  ].join("\n");
  const worker = recordingAdapter([async () => reply]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload.report).toEqual({
    conclusion: "The worker pushed the fix, and the checks are still pending.",
    why: "**Rule:** the report keeps every field; **Path safety:** nothing outside the work tree changed",
    blockers: "none",
    checks: "pnpm test passed",
    notes: "none",
    deferred: "nothing",
  });
  expect(result.payload).not.toHaveProperty("reportMissingLabels");
});

// Usefulness: verifies the issue #1585 envelope yields a report and no reportMissingLabels, a boundary no other test checks.
test("worker dispatch reads the issue #1585 bold heading labels", async () => {
  const repo = await newCleanRepo();
  const reply = [
    "The worker pushed the fix and opened PR #56.",
    "",
    "**Conclusion**",
    "- **PR:** open",
    "- **Script:** ran",
    "",
    "**Why**",
    "- **Red first:** the test failed before the fix",
    "- **Tests:** the targeted file passed",
    "",
    "Blockers: none",
    "",
    "Checks: pnpm test",
    "Notes: none",
    "Deferred: none",
  ].join("\n");
  const worker = recordingAdapter([async () => reply]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload.report).toEqual({
    conclusion: "**PR:** open; **Script:** ran",
    why: "**Red first:** the test failed before the fix; **Tests:** the targeted file passed",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
  expect(result.payload).not.toHaveProperty("reportMissingLabels");
});

// Usefulness: verifies a plain report from a multi-part unidentified turn keeps its fields, so
// the fail-closed rule needs a bold-only parse (issue #1483).
test("worker dispatch keeps a plain report across unidentified parts", async () => {
  const repo = await newCleanRepo();
  const worker = recordingAdapter([
    async (state) => {
      state.multiPartUnidentified = true;
      return REPORT;
    },
  ]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.payload.report).toMatchObject({ conclusion: "done", why: "tests pass" });
});

// Usefulness: verifies a bold-only report from a multi-part unidentified turn fails closed into
// raw, so the parser's bold support cannot accept that stream (issue #1483).
test("worker dispatch fails closed for a bold-only report across unidentified parts", async () => {
  const repo = await newCleanRepo();
  const response = "**Conclusion:** done\n**Why:** ok\n**Blockers:** none";
  // The one repair turn repeats the bold-only multi-part shape, so the fail-closed rule still
  // leaves the original response in `raw`.
  const boldOnlyMultiPart = async (state) => {
    state.multiPartUnidentified = true;
    return response;
  };
  const worker = recordingAdapter([boldOnlyMultiPart, boldOnlyMultiPart]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toBe(response);
});

// Usefulness: verifies the same bold-only report in one part keeps its parsed fields, so the
// fail-closed rule applies only to multi-part unidentified turns (issue #1483).
test("worker dispatch keeps a bold-only report from one unidentified part", async () => {
  const repo = await newCleanRepo();
  const response = "**Conclusion:** done\n**Why:** ok\n**Blockers:** none";
  const worker = recordingAdapter([async () => response]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.payload.report).toEqual({
    conclusion: "done",
    why: "ok",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies the dispatch seam when the closing block does not parse
// — the payload carries a null report and the raw response, so a caller can
// still inspect what the child returned instead of guessing.
test("reviewer dispatch exposes a null report and the raw response when the block does not parse", async () => {
  const repo = await newCleanRepo();

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
  const repo = await newCleanRepo();

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
  const repo = await newCleanRepo();

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
  const repo = await newCleanRepo();

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
  const repo = await newCleanRepo();

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
  const repo = await newCleanRepo();
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
