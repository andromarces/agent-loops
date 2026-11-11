import { afterEach, expect, test, vi } from "vite-plus/test";
import { executeRoleCommand } from "../src/role/index.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newCleanRunRepo,
  recordingAdapter,
  REPORT,
  reviewerTurn,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";

// `cleanRepoGit` answers the Git guards and reads from memory: `assertGitWorkTree` and `snapshot`
// (`src/lib/snapshot.mjs`), `locateLocalFiles` (`src/lib/local-files.mjs`), `readSharedGit`
// (`src/lib/evidence/shared-git.mjs`), `readMainWorkTree` (`src/lib/evidence/main-work-tree-change.mjs`),
// `readLockfiles` (`src/lib/evidence/lockfile-change.mjs`), and `resolveWorkerPr` (`src/lib/worker-pr.mjs`).
// These cases assert no Git result.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

const newRunRepo = () => newCleanRunRepo(gitDouble);

afterEach(async () => {
  gitDouble.answer = null;
  await cleanup();
});

const SECRET_RULE =
  "Never read, print, or quote `.env`, `.dev.vars`, or another ignored secret file. Check a configuration value by name and presence only. Keep a content search to tracked files, for example `git grep`, or `rg` without `--no-ignore` and `-u`.";

const ADAPTERS = ["claude", "codex", "agy", "opencode", "copilot"];

const squash = (text) => text.replace(/\s+/g, " ");

// Runs one worker turn and one reviewer turn, with the adapter kind named `workerKind` on the
// worker and `reviewerKind` on the reviewer, and returns the prompt that each adapter received.
async function dispatchedPrompts(workerKind, reviewerKind) {
  const repo = await newRunRepo();
  const worker = recordingAdapter([]);
  const reviewer = recordingAdapter([`${REPORT}\nVerdict: accept`]);
  const agents = { [workerKind]: worker, [reviewerKind]: reviewer };
  const overrides = INIT_OVERRIDES.map((value) =>
    value === "fake1" ? workerKind : value === "fake2" ? reviewerKind : value,
  );
  await executeRoleCommand(withRepo(dispatchArgv(overrides), repo), {
    agents,
    stdin: stdinPrompt,
  });
  await reviewerTurn(repo, agents);
  return {
    worker: squash(worker.recorded[0].prompt),
    reviewer: squash(reviewer.recorded[0].prompt),
  };
}

for (const adapter of ADAPTERS) {
  // Usefulness: acceptance of #1248. A child that prints a copied ignored secret file sends the
  // value to the model provider, so the first worker turn carries the rule whichever adapter runs
  // the worker. No other test covers the dispatched worker prompt of each adapter kind.
  test(`the worker preamble carries the secret file rule on ${adapter}`, async () => {
    const { worker } = await dispatchedPrompts(adapter, "other");
    expect(worker).toContain(SECRET_RULE);
  });
}

for (const adapter of ADAPTERS) {
  // Usefulness: acceptance of #1248 for the reviewer. The reviewer prompt is rebuilt for each
  // adapter kind of the reviewer role, and the worker tests above never vary that kind.
  test(`the reviewer prompt carries the secret file rule on ${adapter}`, async () => {
    const { reviewer } = await dispatchedPrompts("other", adapter);
    expect(reviewer).toContain(SECRET_RULE);
  });
}
