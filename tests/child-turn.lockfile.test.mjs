import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { failedLockfileChanged } from "../src/lib/lockfile-change.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  await removePath(repo);
});

const editLockfile = () => writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

const turn = (act, signal) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
    signal,
  });

// Usefulness: verifies requirement "a canceled worker turn keeps the lockfile report" (issue #1180):
// a cancel ends the turn by a throw, and the dispatcher builds the interrupted envelope and
// `lastResult` from the error, so a lost field leaves the next unchanged turn with no reinstall signal.
test("a canceled worker turn carries the lockfile change", async () => {
  const error = await turn(async () => {
    await editLockfile();
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedLockfileChanged(error)).toEqual(["pnpm-lock.yaml"]);
});

// Usefulness: verifies the same for a failed turn that ends as a cancel because the signal aborted
// while the adapter failed. The lockfile compare must not depend on the turn signal, which a cancel
// has already aborted.
test("a worker turn that fails after a cancel still carries the lockfile change", async () => {
  const controller = new AbortController();
  const error = await turn(async () => {
    await editLockfile();
    controller.abort();
    throw new Error("adapter failed");
  }, controller.signal).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedLockfileChanged(error)).toEqual(["pnpm-lock.yaml"]);
});

// Usefulness: verifies a fatal error that cannot take a property still carries the field.
test("a frozen fatal error still carries the lockfile change", async () => {
  const fatal = Object.freeze(Object.assign(new Error("fatal"), { name: "SnapshotError" }));
  const error = await turn(async () => {
    await editLockfile();
    throw fatal;
  }).catch((err) => err);
  expect(error).toBe(fatal);
  expect(failedLockfileChanged(error)).toEqual(["pnpm-lock.yaml"]);
});

// Usefulness: verifies a canceled turn that changed no lockfile carries no field.
test("a canceled worker turn that changed no lockfile carries no field", async () => {
  const error = await turn(async () => {
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedLockfileChanged(error)).toBeUndefined();
});
