import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";

// A partial mock keeps the real filesystem and fails `rename` on demand. It lives
// in its own file because the mock applies to the whole module (see
// runstate.link-fallback.test.mjs).
const control = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    rename: vi.fn(async (...args) => {
      if (control.failRename) {
        const err = new Error("rename failed");
        err.code = "EIO";
        throw err;
      }
      return real.rename(...args);
    }),
  };
});

const ARGS = [
  "--orchestrator",
  "codex",
  "--worker",
  "claude",
  "--reviewer",
  "agy",
  "--task",
  "long task",
];
const WORK = JSON.stringify({ action: "run_worker", prompt: "w" });
const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

function agents(replies) {
  let call = 0;
  const child = (text) => ({
    async run(state) {
      state.sessionId ??= "s";
      return text;
    },
  });
  return {
    codex: {
      async run(state) {
        state.sessionId ??= "s";
        return replies[call++];
      },
    },
    claude: child("worker ok"),
    agy: child("reviewer ok"),
  };
}

let repo;
const exitCode = process.exitCode;
afterEach(async () => {
  control.failRename = false;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  if (repo) await removePath(repo);
});

// Usefulness: verifies a transcript write that fails mid-way leaves the earlier
// record byte for byte, and no temp file behind, when --transcript names the
// --continue-from source (#362 review).
test("a failed same-path transcript write keeps the earlier transcript whole", async () => {
  repo = await createTempRepo();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const path = join(repo, "run.json");
  await main(
    [...ARGS, "--cwd", repo, "--max-steps", "1", "--transcript", path],
    agents([WORK, WORK]),
  );
  const before = await readFile(path, "utf8");
  expect(JSON.parse(before).exitCode).toBe(2);

  control.failRename = true;
  await main(
    [...ARGS, "--cwd", repo, "--continue-from", path, "--transcript", path],
    agents([FINISH]),
  );

  expect(await readFile(path, "utf8")).toBe(before);
  expect((await readdir(repo)).filter((name) => name.includes(".tmp"))).toEqual([]);
});
