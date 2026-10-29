import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { execa } from "execa";
import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { failedSharedGitChanged } from "../src/lib/shared-git.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  await removePath(repo);
});

const addRemote = () =>
  execa("git", ["remote", "add", "origin", "https://user:token-9@example.test/a.git"], {
    cwd: repo,
  });

const turn = (act, signal) =>
  runChild({
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
