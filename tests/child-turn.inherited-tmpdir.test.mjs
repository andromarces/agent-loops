import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { failedInheritedTmpdirEntries } from "../src/lib/tmpdir-entries.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";

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

const turn = (roleName, act, options = {}) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName,
    prompt: "go",
    cwd: repo,
    // A test names the literal roots, so the churn of the host's `/tmp` stays out of the report.
    tmpdirLiteralRoots: [],
    ...options,
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

// Usefulness: verifies a worker turn's inherited-directory write stays out of the report, because a
// worker legitimately writes there (a PR body file), while a literal root entry is reported.
test("a worker turn carries no inherited-directory entry", async () => {
  const result = await turn("worker", async () => {
    await mkdir(join(temp, "pr-body"));
    return "done";
  });
  expect(result).not.toHaveProperty("inheritedTmpdirEntries");
});

// Usefulness: verifies the confirmed gap of issue #1713 — a worker write to a literal system
// temporary directory that differs from the inherited one is reported (#1596 observed it on macOS
// with no field), and a worker still carries no inherited-directory entry of its own.
test("a worker turn reports a literal system temporary directory entry", async () => {
  const literal = await mkdtemp(join(temp, "literal-"));
  const result = await turn(
    "worker",
    async () => {
      await writeFile(join(literal, "x"), "probe");
      return "done";
    },
    { tmpdirLiteralRoots: [literal] },
  );
  expect(result.status).toBe("ok");
  expect(result.inheritedTmpdirEntries).toEqual(["literal-tmp/x"]);
});

// Usefulness: verifies a worker turn keeps its inherited-directory entries out while a literal root
// is read, because a worker may legitimately write there (issue #1024).
test("a worker turn leaves out an inherited entry while it reads a literal root", async () => {
  const literal = await mkdtemp(join(temp, "literal-"));
  const result = await turn(
    "worker",
    async () => {
      await mkdir(join(temp, "pr-body"));
      return "done";
    },
    { tmpdirLiteralRoots: [literal] },
  );
  expect(result).not.toHaveProperty("inheritedTmpdirEntries");
});

// Usefulness: verifies a reviewer turn reports a literal system temporary directory entry too,
// because the gap of issue #1713 covers every child turn and the same one post-turn read lists it.
test("a reviewer turn reports a literal system temporary directory entry", async () => {
  const literal = await mkdtemp(join(temp, "literal-"));
  const result = await turn(
    "reviewer",
    async () => {
      await writeFile(join(literal, "x"), "probe");
      return "done";
    },
    { tmpdirLiteralRoots: [literal] },
  );
  expect(result.inheritedTmpdirEntries).toEqual(["literal-tmp/x"]);
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

// Usefulness: verifies requirement "a fatal reviewer error carries the entries" (issue #1024): a
// mutation ends the turn by a throw, and the entries must still reach the dispatcher, because a
// halted turn is the one most likely to have skipped its own cleanup.
test("a reviewer mutation error carries the entries that appeared", async () => {
  const error = await turn("reviewer", async () => {
    await mkdir(join(temp, "m54-3db54ca8"));
    await writeFile(join(repo, "leak.txt"), "leak\n");
    return "done";
  }).catch((err) => err);
  expect(error).toBeInstanceOf(MutationError);
  expect(failedInheritedTmpdirEntries(error)).toEqual(["m54-3db54ca8"]);
});

// Usefulness: verifies the same for a cancel, which ends the turn by a different throw.
test("a canceled reviewer turn carries the entries that appeared", async () => {
  const error = await turn("reviewer", async () => {
    await mkdir(join(temp, "m54-3db54ca8"));
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedInheritedTmpdirEntries(error)).toEqual(["m54-3db54ca8"]);
});

// Usefulness: verifies a fatal error that cannot take a property still carries the entries, as a
// frozen error does for the test result.
test("a frozen fatal error still carries the entries", async () => {
  const fatal = Object.freeze(Object.assign(new Error("fatal"), { name: "MutationError" }));
  const error = await turn("reviewer", async () => {
    await mkdir(join(temp, "m54-3db54ca8"));
    throw fatal;
  }).catch((err) => err);
  expect(error).toBe(fatal);
  expect(failedInheritedTmpdirEntries(error)).toEqual(["m54-3db54ca8"]);
});
