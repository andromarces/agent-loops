import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

let repo;
let temp;
beforeEach(async () => {
  repo = await createTempRepo();
  temp = await mkdtemp(join(tmpdir(), "inherited-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temp);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removePath(repo);
  await removePath(temp);
});

const turn = (roleName, act) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName,
    prompt: "go",
    cwd: repo,
  });

// Usefulness: verifies acceptance #1024 — a directory that a reviewer turn leaves directly in the
// inherited temporary directory is reported in the result, because the runtime cannot remove it.
test("an ok reviewer turn reports a directory left in the inherited temporary directory", async () => {
  const result = await turn("reviewer", async () => {
    await mkdir(join(temp, "m54-3db54ca8"));
    return "done";
  });
  expect(result.status).toBe("ok");
  expect(result.inheritedTmpdirEntries).toEqual(["m54-3db54ca8"]);
});

// Usefulness: verifies the failed turn reports it too, because a failed turn is the one most likely
// to skip its own cleanup.
test("an error reviewer turn reports a directory left in the inherited temporary directory", async () => {
  const result = await turn("reviewer", async () => {
    await mkdir(join(temp, "m54-3db54ca8"));
    throw new Error("adapter failed");
  });
  expect(result.status).toBe("error");
  expect(result.inheritedTmpdirEntries).toEqual(["m54-3db54ca8"]);
});

// Usefulness: verifies a reviewer turn that left nothing carries no field, and nothing is deleted.
test("a reviewer turn that left nothing carries no field", async () => {
  const result = await turn("reviewer", async () => "done");
  expect(result).not.toHaveProperty("inheritedTmpdirEntries");
});

// Usefulness: verifies the report is reviewer-only, because the issue covers reviewer probes and a
// worker legitimately writes to the temporary directory (a PR body file).
test("a worker turn carries no field", async () => {
  const result = await turn("worker", async () => {
    await mkdir(join(temp, "pr-body"));
    return "done";
  });
  expect(result).not.toHaveProperty("inheritedTmpdirEntries");
});

// Usefulness: verifies the runtime never deletes what it cannot attribute (issue #1024).
test("the runtime leaves the reported directory in place", async () => {
  await turn("reviewer", async () => {
    await mkdir(join(temp, "m54-3db54ca8"));
    return "done";
  });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(temp)).toContain("m54-3db54ca8");
});
