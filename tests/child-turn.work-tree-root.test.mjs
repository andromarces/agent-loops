import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

// The order in which the `git` reads start and end. `slowShared` delays the end of the shared Git
// read, as a slow remote read does.
const reads = vi.hoisted(() => ({ events: [], slowShared: false }));
vi.mock("../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execBounded: async (command, args, ...rest) => {
      if (command !== "git") return real.execBounded(command, args, ...rest);
      const shared = args.includes("--git-common-dir");
      if (args.includes("--show-toplevel")) reads.events.push("root read");
      if (shared) reads.events.push("shared read started");
      const result = await real.execBounded(command, args, ...rest);
      if (shared && reads.slowShared) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        reads.events.push("shared read ended");
      }
      return result;
    },
  };
});

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
  reads.events.length = 0;
});
afterEach(async () => {
  reads.slowShared = false;
  await removePath(repo);
});

const runTurn = (roleName, act = async () => {}) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName,
    prompt: "go",
    cwd: repo,
  });

const rootReads = () => reads.events.filter((event) => event === "root read").length;

// Usefulness: verifies requirement "a worker turn resolves the work tree root once" (issue #1268):
// the pre-turn lockfile read, the post-turn work tree read, and the post-turn lockfile read share it.
test("a worker turn resolves the work tree root once", async () => {
  const result = await runTurn("worker");
  expect(result.workTree).toMatchObject({ clean: true });
  expect(rootReads()).toBe(1);
});

// Usefulness: verifies requirement "a reviewer turn resolves the work tree root once" (issue #1268):
// the scratch folder and both mutation-check snapshots share it.
test("a reviewer turn resolves the work tree root once", async () => {
  const result = await runTurn("reviewer");
  expect(result.status).toBe("ok");
  expect(rootReads()).toBe(1);
});

// Usefulness: verifies requirement "the pre-turn shared Git and lockfile reads run together"
// (issue #1268), since neither depends on the other; the result of the turn is unchanged.
test("a worker turn starts the lockfile read before the shared Git read ends", async () => {
  reads.slowShared = true;
  const result = await runTurn("worker");
  expect(result.status).toBe("ok");
  const preTurn = reads.events.slice(0, reads.events.indexOf("shared read ended"));
  expect(preTurn).toContain("root read");
});

// Usefulness: verifies requirement "a work tree that vanishes during a turn still fails the turn"
// (issue #1268): with the root resolved once, the failure moves to the later `git` read and must
// still end the reviewer turn with a snapshot error.
test("a reviewer turn whose work tree vanishes during the turn fails with a snapshot error", async () => {
  const error = await runTurn("reviewer", async () => {
    await rm(repo, { recursive: true, force: true });
    return "done";
  }).catch((err) => err);
  expect(error).toMatchObject({ name: "SnapshotError" });
});
