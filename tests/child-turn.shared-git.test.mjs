import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";

// Makes every directory read hang while `fs.stallReaddir` is set, as a stalled file system does.
const fs = vi.hoisted(() => ({ stallReaddir: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    readdir: (...args) => (fs.stallReaddir ? new Promise(() => {}) : real.readdir(...args)),
  };
});

import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { failedTurnEvidence } from "../src/lib/turn-evidence.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createLinkedWorkTree, createTempRepo } from "./git-helpers.mjs";

// Real Git: each turn reads the work tree of a real repository, so the snapshot matches Git.
let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  fs.stallReaddir = false;
  await removePath(repo);
});

const addRemote = () =>
  execa("git", ["remote", "add", "origin", "https://user:token-9@example.test/a.git"], {
    cwd: repo,
  });

const turn = (act, signal, extra = {}) =>
  runChild({
    ...extra,
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: extra.cwd ?? repo,
    signal,
    // This file stalls every directory read, so a literal root would hang the post-turn read.
    tmpdirLiteralRoots: [],
  });

// Usefulness: verifies requirement "a worker turn that sets core.bare in the shared config reports
// core.bare" (issue #1387). No other watched item names a change that makes the main work tree read
// as bare.
test("a worker turn that sets core.bare carries the key name", async () => {
  const result = await turn(async () => {
    await execa("git", ["config", "core.bare", "true"], { cwd: repo });
  });
  expect(result.sharedGitChanged).toEqual(["core.bare"]);
});

// Usefulness: verifies requirement "a worker turn that removes user.name carries user.name" (issue
// #1442). The unit test covers the read, and only a turn covers the envelope field.
test("a worker turn that removes user.name carries the key name", async () => {
  await execa("git", ["config", "--local", "user.name", "Original Name"], { cwd: repo });
  const result = await turn(async () => {
    await execa("git", ["config", "--local", "--unset", "user.name"], { cwd: repo });
  });
  expect(result.sharedGitChanged).toEqual(["user.name"]);
});

// Usefulness: verifies requirement "a turn that changes no shared key carries no field" (issue
// #1387). A key set and restored in one turn leaves the envelope without the field.
test("a worker turn that sets and restores core.bare carries no field", async () => {
  const result = await turn(async () => {
    await execa("git", ["config", "core.bare", "true"], { cwd: repo });
    await execa("git", ["config", "core.bare", "false"], { cwd: repo });
  });
  expect(result).not.toHaveProperty("sharedGitChanged");
});

// Usefulness: verifies requirement "a worker turn that sets core.bare in the main work tree's
// worktree config reports core.bare" (issue #1392). The turn runs in a linked work tree, as a real
// turn does, so the linked read alone cannot see the change.
test("a worker turn that sets the main work tree's worktree core.bare carries the key name", async () => {
  const tree = await createLinkedWorkTree();
  try {
    await execa("git", ["config", "extensions.worktreeConfig", "true"], { cwd: tree.main });
    const result = await turn(
      async () => {
        await execa("git", ["config", "--worktree", "core.bare", "true"], { cwd: tree.main });
      },
      undefined,
      { cwd: tree.linked },
    );
    expect(result.sharedGitChanged).toEqual(["core.bare"]);
  } finally {
    await removePath(tree.base);
  }
});

// Usefulness: verifies requirement "a worker turn that sets the global core.hooksPath reports it by
// name" (issue #1392). `GIT_CONFIG_GLOBAL` points at a temporary file, so no user config changes.
test("a worker turn that sets the global core.hooksPath carries the key name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loops-global-turn-"));
  const previous = {
    global: process.env.GIT_CONFIG_GLOBAL,
    nosystem: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = join(dir, "config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const result = await turn(async () => {
      await execa("git", ["config", "--global", "core.hooksPath", ".global-hooks"], { cwd: repo });
    });
    expect(result.sharedGitChanged).toEqual(["core.hooksPath"]);
  } finally {
    if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous.global;
    if (previous.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previous.nosystem;
    await removePath(dir);
  }
});

// Usefulness: verifies requirement "a canceled worker turn keeps the shared Git report" (issue #1224):
// a cancel ends the turn by a throw, and the dispatcher builds the interrupted envelope and
// `lastResult` from the error, so a lost field leaves a hook or remote change with no trace.
test("a canceled worker turn carries the shared Git change", async () => {
  const error = await turn(async () => {
    await addRemote();
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedTurnEvidence(error).sharedGitChanged).toEqual(["remote.origin"]);
});

// Usefulness: verifies the same when the turn signal is already aborted. The shared Git compare must
// not depend on the turn signal, which a cancel has already aborted.
test("a worker turn that fails after a cancel still carries the shared Git change", async () => {
  const controller = new AbortController();
  const error = await turn(async () => {
    await addRemote();
    controller.abort();
    throw new Error("adapter failed");
  }, controller.signal).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedTurnEvidence(error).sharedGitChanged).toEqual(["remote.origin"]);
});

// Usefulness: verifies a fatal error that cannot take a property still carries the field.
test("a frozen fatal error still carries the shared Git change", async () => {
  const fatal = Object.freeze(Object.assign(new Error("fatal"), { name: "SnapshotError" }));
  const error = await turn(async () => {
    await addRemote();
    throw fatal;
  }).catch((err) => err);
  expect(error).toBe(fatal);
  expect(failedTurnEvidence(error).sharedGitChanged).toEqual(["remote.origin"]);
});

// Usefulness: verifies a canceled turn that changed no shared Git state carries no field.
test("a canceled worker turn that changed no shared Git state carries no field", async () => {
  const error = await turn(async () => {
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedTurnEvidence(error).sharedGitChanged).toBeUndefined();
});

// Usefulness: verifies requirement "a canceled worker turn ends within the bound when the shared Git
// read stalls" (issue #1224): the hooks directory read has no time bound of its own, so the turn
// would hold the cancel for as long as the file system stalls.
test("a canceled worker turn ends at the bound when the shared Git read stalls", async () => {
  const started = Date.now();
  const error = await turn(
    async () => {
      await addRemote();
      fs.stallReaddir = true;
      throw new ExecError("canceled", { isCanceled: true });
    },
    undefined,
    { sharedGitReadBoundMs: 500 },
  ).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(failedTurnEvidence(error).sharedGitChanged).toBeUndefined();
});
