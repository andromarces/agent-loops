import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import { pageStdout } from "../runtime-helpers.mjs";
import { fakeClock, HEAD_A, scriptedGh } from "./check-wait-helpers.mjs";

// The `--all` wait holds a pass while a `pull_request` workflow of the base branch can run for the PR
// and the head has no check run from GitHub Actions (issue #1228). The scripted `gh` answers the
// workflow reads of the base branch and the check runs of the head by poll, so a check run can appear
// only after another app's check passed.
const BASE_HEAD = "c".repeat(40);
const readOk = (body) => ({ status: 0, stdout: pageStdout(body), stderr: "", timedOut: false });
const PR_WORKFLOW = "name: checks\non:\n  pull_request:\n";
const INERT_WORKFLOW = "name: nightly\non:\n  workflow_dispatch:\n";
const WORKERS = {
  id: 1,
  name: "Workers Builds: site",
  status: "completed",
  conclusion: "success",
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:01:00Z",
  app: { id: 2, slug: "cloudflare-workers-and-pages" },
};
const ACTIONS = {
  ...WORKERS,
  id: 2,
  name: "checks",
  app: { id: 15368, slug: "github-actions" },
};

function fileReply(text) {
  const bytes = Buffer.from(text);
  return {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
  };
}

/** A scripted `gh` whose head check runs are `runsByPoll[n]` on poll `n`, the last entry repeating. */
function holdGh({ workflow = PR_WORKFLOW, prFiles = [{ filename: "src/a.js" }], runsByPoll }) {
  const inner = scriptedGh([{ status: 0, checks: [{ name: WORKERS.name, bucket: "pass" }] }], {
    all: true,
  });
  const repo = "repos/owner/repo";
  let polls = 0;
  return async (args, cwd) => {
    if (args[0] === "pr" && args[1] === "view") {
      polls += 1;
    }
    const endpoint = args[0] === "api" ? args[1] : "";
    if (endpoint === `${repo}/commits/main`) {
      return readOk({ sha: BASE_HEAD });
    }
    if (endpoint.startsWith(`${repo}/pulls/42/files`)) {
      return readOk(prFiles);
    }
    if (endpoint === `${repo}/contents/.github/workflows?ref=${BASE_HEAD}`) {
      return readOk([{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" }]);
    }
    if (endpoint === `${repo}/contents/.github/workflows/ci.yml?ref=${BASE_HEAD}`) {
      return readOk(fileReply(workflow));
    }
    if (endpoint.startsWith(`${repo}/commits/${HEAD_A}/check-runs`)) {
      const runs = runsByPoll[Math.min(polls, runsByPoll.length) - 1];
      return readOk({ total_count: runs.length, check_runs: runs });
    }
    return inner(args, cwd);
  };
}

function holdWait(options, extra = {}) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    all: true,
    gh: holdGh(options),
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  }).then((result) => ({ result, elapsed: clock.elapsed() }));
}

// Usefulness: verifies the wait does not pass on a fast check of another app while the `pull_request`
// workflow of the base branch has no check run on the head, and passes once that run appears
// (acceptance 1 and 2 of issue #1228); no other test covers a run that appears after a pass.
test("the --all wait holds a pass until a GitHub Actions check run appears on the head", async () => {
  const { result, elapsed } = await holdWait({ runsByPoll: [[WORKERS], [WORKERS, ACTIONS]] });
  expect(result.timedOut).toBe(false);
  expect(result.checks.map(({ name }) => name).sort()).toEqual(["Workers Builds: site", "checks"]);
  expect(elapsed).toBeGreaterThan(0);
});

// Usefulness: verifies the hold ends at the bound with `timedOut: true` and never a pass when no
// Actions run registers (acceptance 1 of issue #1228).
test("the --all wait ends at the bound without a pass when no Actions run registers", async () => {
  const { result } = await holdWait({ runsByPoll: [[WORKERS]] });
  expect(result.timedOut).toBe(true);
  expect(result.checks.map(({ name }) => name)).toEqual(["Workers Builds: site"]);
});

// Usefulness: verifies a failing check still settles the wait during the hold, so the hold delays only
// a pass.
test("the --all wait still settles on a failing check while it holds for an Actions run", async () => {
  const failing = { ...WORKERS, conclusion: "failure" };
  const { result } = await holdWait({ runsByPoll: [[failing]] });
  expect(result.timedOut).toBe(false);
  expect(result.checks[0].bucket).toBe("fail");
});

// Usefulness: verifies a base workflow that cannot run for the PR (no pull_request trigger) never
// holds the pass, so a repository with only a third-party check keeps the immediate pass.
test("the --all wait passes at once when no base workflow runs for the PR", async () => {
  const { result, elapsed } = await holdWait({
    workflow: INERT_WORKFLOW,
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBe(0);
});

// Usefulness: verifies the `paths` filter of the `pull_request` trigger is honored, so a workflow that
// no PR file can start never holds the pass.
test("the --all wait passes at once when the paths filter excludes every PR file", async () => {
  const { result, elapsed } = await holdWait({
    workflow: "name: docs\non:\n  pull_request:\n    paths:\n      - 'docs/**'\n",
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBe(0);
});

// Usefulness: verifies the hold applies when a `paths` filter matches a PR file.
test("the --all wait holds when the paths filter matches a PR file", async () => {
  const { result } = await holdWait({
    workflow: "name: src\non:\n  pull_request:\n    paths:\n      - 'src/**'\n",
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a trigger filter that the rules cannot settle (`branches`) never holds the pass,
// so a workflow that may never run for the PR cannot turn a pass into a timeout.
test("the --all wait passes at once when the pull_request trigger has a branches filter", async () => {
  const { result, elapsed } = await holdWait({
    workflow: "name: ci\non:\n  pull_request:\n    branches:\n      - release\n",
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBe(0);
});
