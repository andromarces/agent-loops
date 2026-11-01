import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import { fakeClock, fileReply, HEAD_A, HEAD_B, readOk, scriptedGh } from "./check-wait-helpers.mjs";

// The `--all` wait holds a pass while a `pull_request` workflow of the base branch can run for the PR
// and the head has no check run from GitHub Actions (issue #1228). The scripted `gh` answers the
// workflow reads of the base branch and the check runs of the head by poll, so a check run can appear
// only after another app's check passed.
const BASE_HEAD = "c".repeat(40);
const PR_WORKFLOW = "name: checks\non:\n  pull_request:\n";
const INERT_WORKFLOW = "name: nightly\non:\n  workflow_dispatch:\n";
// The text the `gh` network stack writes for a transport failure: no HTTP status, no reply body.
const DIAL_TIMEOUT =
  'Get "https://api.github.com/repos/owner/repo": dial tcp 20.205.243.168:443: connect: operation timed out';
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

/** A scripted `gh` whose head check runs are `runsByPoll[n]` on poll `n`, the last entry repeating. */
function holdGh({
  workflow = PR_WORKFLOW,
  prFiles = [{ filename: "src/a.js" }],
  runsByPoll,
  listingFailures = 0,
  listingFailureText = "gh: Bad Gateway (HTTP 502)",
  baseFailureText = null,
  filesFailureText = null,
  heads = [HEAD_A],
  failBaseRead = 0,
}) {
  const inner = scriptedGh([{ status: 0, checks: [{ name: WORKERS.name, bucket: "pass" }] }], {
    all: true,
    heads,
  });
  const repo = "repos/owner/repo";
  let polls = 0;
  let failuresLeft = listingFailures;
  let baseReads = 0;
  return async (args, cwd) => {
    if (args[0] === "pr" && args[1] === "view") {
      polls += 1;
    }
    const endpoint = args[0] === "api" ? args[1] : "";
    if (endpoint === `${repo}/commits/main`) {
      baseReads += 1;
      if (baseFailureText !== null) {
        return { status: 1, stdout: "", stderr: baseFailureText, timedOut: false };
      }
      if (baseReads === failBaseRead) {
        return { status: 1, stdout: "", stderr: "gh: Bad Gateway (HTTP 502)", timedOut: false };
      }
      return readOk({ sha: BASE_HEAD });
    }
    if (endpoint.startsWith(`${repo}/pulls/42/files`)) {
      if (filesFailureText !== null) {
        return { status: 1, stdout: "", stderr: filesFailureText, timedOut: false };
      }
      return readOk(prFiles);
    }
    if (endpoint === `${repo}/contents/.github/workflows?ref=${BASE_HEAD}`) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { status: 1, stdout: "", stderr: listingFailureText, timedOut: false };
      }
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

// Usefulness: verifies a base workflow whose `pull_request` trigger is unfiltered in any form (a bare
// key, an empty map, a string, a list) holds the pass, so a passing third-party check never settles
// the wait before the workflow registers (issue #1228, reviewer blocker 1).
test.each([
  ["a bare key", "name: ci\non:\n  pull_request:\n"],
  ["an empty map", "name: ci\non:\n  pull_request: {}\n"],
  ["a flow map", "name: ci\non: { pull_request: {} }\n"],
  ["a string", "name: ci\non: pull_request\n"],
  ["a list", "name: ci\non: [push, pull_request]\n"],
])("the --all wait holds for an unfiltered pull_request trigger as %s", async (_form, workflow) => {
  const { result } = await holdWait({ workflow, runsByPoll: [[WORKERS]] });
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a filter that the PR meets, or that never proves exclusion, holds the pass:
// `branches` naming the base, the default `types`, `paths-ignore` with a source change, a
// `branches-ignore` that omits the base, and a pattern that cannot be settled (reviewer blocker 2).
test.each([
  ["branches naming the base", "branches:\n      - main"],
  ["a branches pattern for the base", "branches:\n      - 'ma*'"],
  ["the default types", "types: [opened, synchronize, reopened]"],
  ["types that omit synchronize", "types: [labeled]"],
  ["paths-ignore with a source change", "paths-ignore:\n      - 'docs/**'"],
  ["branches-ignore that omits the base", "branches-ignore:\n      - release"],
  ["an unsettled paths pattern", "paths:\n      - '!docs/**'"],
  ["an unsettled branches pattern", "branches:\n      - 'rel[ea]se'"],
])("the --all wait holds for a pull_request trigger with %s", async (_filter, filter) => {
  const { result } = await holdWait({
    workflow: `name: ci\non:\n  pull_request:\n    ${filter}\n`,
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a filter that proves no run starts for this PR skips the hold, so the exclusion
// rules are not a blanket hold: `paths-ignore` that covers every PR file, `branches` that omits the
// base, and `branches-ignore` that names it.
test.each([
  ["paths-ignore covering every file", "paths-ignore:\n      - 'src/**'"],
  ["branches omitting the base", "branches:\n      - release"],
  ["branches-ignore naming the base", "branches-ignore:\n      - main"],
])("the --all wait passes at once when %s", async (_filter, filter) => {
  const { result, elapsed } = await holdWait({
    workflow: `name: ci\non:\n  pull_request:\n    ${filter}\n`,
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBe(0);
});

// Usefulness: verifies a workflow text that cannot be settled, and a PR that changes a workflow file,
// hold the pass instead of skipping it (issue #1228 fail-closed rule).
test.each([
  ["a syntax error", { workflow: "name: ci\non:\n  pull_request:\njobs: [\n" }],
  ["an anchor", { workflow: "name: ci\non: &t\n  pull_request:\n" }],
  [
    "a changed workflow file",
    { workflow: INERT_WORKFLOW, prFiles: [{ filename: ".github/workflows/ci.yml" }] },
  ],
])("the --all wait holds for %s", async (_case, options) => {
  const { result } = await holdWait({ ...options, runsByPoll: [[WORKERS]] });
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a failed workflow read (a 502) holds the pass to the bound, and the next poll
// reads again, so a transient failure delays the pass until the run registers (reviewer blocker 3).
test("the --all wait holds when the workflow read fails and retries on the next poll", async () => {
  const bound = await holdWait({ listingFailures: 99, runsByPoll: [[WORKERS]] });
  expect(bound.result.timedOut).toBe(true);
  const retried = await holdWait({
    listingFailures: 1,
    runsByPoll: [[WORKERS], [WORKERS, ACTIONS]],
  });
  expect(retried.result.timedOut).toBe(false);
  expect(retried.result.checks.map(({ name }) => name)).toContain("checks");
});

// Usefulness: verifies a transport failure of the base workflow read holds the pass.
// The next poll reads again, so a connection timeout is no pass (issue #1312).
test("the --all wait reads the base workflow again after a transport failure", async () => {
  const { result } = await holdWait({
    listingFailures: 1,
    listingFailureText:
      'Get "https://api.github.com/repos/owner/repo/contents": dial tcp 20.205.243.168:443: connect: operation timed out',
    runsByPoll: [[WORKERS], [WORKERS, ACTIONS]],
  });
  expect(result.timedOut).toBe(false);
  expect(result.checks.map(({ name }) => name)).toContain("checks");
});

// Usefulness: verifies a lasting transport failure of each `--all` source read ends the wait with an
// error that names it. The result is never a timeout envelope (issue #1312).
test.each([
  ["the base head read", { baseFailureText: DIAL_TIMEOUT }],
  ["the workflow-directory read", { listingFailures: 99, listingFailureText: DIAL_TIMEOUT }],
  ["the PR files read", { filesFailureText: DIAL_TIMEOUT }],
])(
  "the --all wait reports an error when %s fails with a transport failure until the bound",
  async (_name, options) => {
    await expect(holdWait({ runsByPoll: [[WORKERS]], ...options })).rejects.toThrow(/dial tcp/);
  },
);

// Usefulness: verifies a workflow with no `pull_request` trigger skips the hold, so a repository whose
// workflows cannot run for a PR keeps the immediate pass.
test("the --all wait passes at once when no workflow names pull_request", async () => {
  const { result, elapsed } = await holdWait({
    workflow: "name: push-only\non:\n  push:\n    branches: [main]\n",
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBe(0);
});

// Usefulness: verifies the exclusion proof is bound to the judged head: when the PR head moves from A
// to B while the probe reads the PR files, the file list of B must not skip a workflow for A, so the
// pass for A is held (a follow-up push during the wait, issue #1228). The scripted head read answers A
// at the start of the poll and B after the file read.
test("the --all wait does not skip a workflow for a head that moved during the file read", async () => {
  const { result } = await holdWait(
    {
      workflow: "name: src\non:\n  pull_request:\n    paths:\n      - 'src/**'\n",
      prFiles: [{ filename: "docs/b.md" }],
      heads: [HEAD_A, HEAD_B],
      runsByPoll: [[WORKERS]],
    },
    { head: HEAD_A },
  );
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a failed final base read (a 502) of the head guard is unresolved, not a move:
// it holds the pass for that poll, is not kept, and the next poll reads again, so the excluded
// workflow still skips once the read succeeds (issue #1228). A kept hold would run to the bound.
test("the --all wait reads again after the base read of the head guard fails", async () => {
  const { result, elapsed } = await holdWait({
    workflow: "name: src\non:\n  pull_request:\n    paths:\n      - 'src/**'\n",
    prFiles: [{ filename: "docs/b.md" }],
    failBaseRead: 2,
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBeGreaterThan(0);
});

// Usefulness: verifies the stated limit for a workflow that runs only on `push`: even an unfiltered
// `push` trigger, which runs for every head branch, never holds the pass, so the docs claim that
// `--expect` stays needed for its check is true (issue #1234); the `push: branches: [main]` case above
// does not cover an unfiltered trigger.
test("the --all wait passes at once for a push-only workflow that runs for every branch", async () => {
  const { result, elapsed } = await holdWait({
    workflow: "name: push-all\non:\n  push:\n",
    runsByPoll: [[WORKERS]],
  });
  expect(result.timedOut).toBe(false);
  expect(elapsed).toBe(0);
});
