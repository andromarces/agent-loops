import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../src/cli.mjs";
import { createTempRepo, removePath, symlinkOrSkip } from "./runtime-helpers.mjs";

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

let paths = [];
const exitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  await Promise.all(paths.map(removePath));
  paths = [];
});

async function expectEarlierEventsSurvive(ctx, linkRole) {
  const repo = await createTempRepo();
  const out = await mkdtemp(join(tmpdir(), "continue-link-"));
  paths.push(repo, out);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const real = join(out, "run.json");
  const link = join(out, "alias.json");
  await main(
    [...ARGS, "--cwd", repo, "--max-steps", "1", "--transcript", real],
    agents([WORK, WORK]),
  );
  const earlier = JSON.parse(await readFile(real, "utf8")).events;
  expect(earlier.length).toBeGreaterThan(0);
  await symlinkOrSkip(ctx, "run.json", link);

  const [from, to] = linkRole === "link" ? [real, link] : [link, real];
  await main(
    [...ARGS, "--cwd", repo, "--continue-from", from, "--transcript", to],
    agents([FINISH]),
  );

  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  const later = JSON.parse(await readFile(real, "utf8")).events;
  expect(later.length).toBeGreaterThan(earlier.length);
  expect(later.slice(0, earlier.length)).toEqual(earlier);
}

// Usefulness: verifies a --transcript link to the --continue-from file keeps the link, writes the target, and carries the earlier events (#658); the rewrite replaced the link before.
test("--transcript names a link to the --continue-from file: link kept, earlier events survive", (ctx) =>
  expectEarlierEventsSurvive(ctx, "link"));

// Usefulness: verifies a --continue-from link to the --transcript file counts as the same file, so the rewrite carries the earlier events instead of dropping them (#658).
test("--continue-from names a link to the --transcript file: earlier events survive", (ctx) =>
  expectEarlierEventsSurvive(ctx, "source"));
