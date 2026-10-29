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
import { failedSharedGitChanged } from "../src/lib/shared-git.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

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
    cwd: repo,
    signal,
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
  expect(failedSharedGitChanged(error)).toEqual(["remote.origin"]);
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
  expect(failedSharedGitChanged(error)).toEqual(["remote.origin"]);
});

// Usefulness: verifies a fatal error that cannot take a property still carries the field.
test("a frozen fatal error still carries the shared Git change", async () => {
  const fatal = Object.freeze(Object.assign(new Error("fatal"), { name: "SnapshotError" }));
  const error = await turn(async () => {
    await addRemote();
    throw fatal;
  }).catch((err) => err);
  expect(error).toBe(fatal);
  expect(failedSharedGitChanged(error)).toEqual(["remote.origin"]);
});

// Usefulness: verifies a canceled turn that changed no shared Git state carries no field.
test("a canceled worker turn that changed no shared Git state carries no field", async () => {
  const error = await turn(async () => {
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedSharedGitChanged(error)).toBeUndefined();
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
  expect(failedSharedGitChanged(error)).toBeUndefined();
});
