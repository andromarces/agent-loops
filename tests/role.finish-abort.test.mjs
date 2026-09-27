import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, test } from "vitest";
import { executeRoleCommand } from "../src/role.mjs";
import { statePaths } from "../src/lib/runstate.mjs";
import { snapshot } from "../src/lib/snapshot.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

// Usefulness: verifies acceptance — finish from active in review-only mode
// succeeds with verdict: reject recorded in the summary.
test("finish from active in review-only mode succeeds with the verdict recorded", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const init = withRepo(
    dispatchArgv(
      [
        "--task",
        "Review only.",
        "--parent-session",
        "parent-sess-1",
        "--mode",
        "review-only",
        "--worker",
        "fake1",
        "--reviewer",
        "fake2",
      ],
      "reviewer",
    ),
    repo,
  );
  await executeRoleCommand(init, {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  const summary = {
    changed: "none",
    verified: "review ran",
    deferred: "none",
    notDone: "verdict: reject, two blockers open",
    open: "blockers 1 and 2",
  };
  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(summary),
  });
  expect(result.exitCode).toBe(0);

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("finished");
  expect(state.summary.notDone).toContain("verdict: reject");
});

// Usefulness: verifies acceptance — finish with an invalid summary exits
// non-zero and leaves lifecycle active.
test("finish with an invalid summary exits non-zero and keeps lifecycle active", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });

  const finishArgs = withRepo(["finish", "--cwd", "<repo>"], repo);
  const badJson = await executeRoleCommand(finishArgs, { stdin: async () => "not json" });
  expect(badJson.exitCode).toBe(1);
  expect(badJson.payload.error).toContain("finish summary must be a JSON object");

  const missingKey = await executeRoleCommand(finishArgs, {
    stdin: async () => JSON.stringify({ changed: "a", verified: "b" }),
  });
  expect(missingKey.exitCode).toBe(1);
  expect(missingKey.payload.error).toContain("non-empty string for deferred");

  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies finish and abort read configuration from the state file
// too — a changed init flag exits non-zero and leaves the state unchanged.
test("finish and abort reject changed init flags", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());

  const badFinish = await executeRoleCommand(
    withRepo(["finish", "--cwd", "<repo>", "--max-steps", "99"], repo),
    {
      stdin: async () =>
        JSON.stringify({ changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" }),
    },
  );
  expect(badFinish.exitCode).toBe(1);
  expect(badFinish.payload.error).toContain("--max-steps cannot be changed after init");

  const badAbort = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "r", "--mode", "review-only"], repo),
  );
  expect(badAbort.exitCode).toBe(1);
  expect(badAbort.payload.error).toContain("--mode cannot be changed after init");

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("active");
  expect(state.maxSteps).toBe(20);
  expect(state.mode).toBe("work-first");
});

const GATE_SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };
const ACCEPT =
  "Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: npm test\nVerdict: accept";
const ACCEPT_NO_CHECKS = "Conclusion: done\nWhy: tests pass\nBlockers: none\nVerdict: accept";
const REJECT =
  "Conclusion: no\nWhy: broken\nBlockers: missing test\nChecks: npm test\nVerdict: reject";
const REVIEW_ONLY_OVERRIDES = [
  "--task",
  "Review only.",
  "--mode",
  "review-only",
  "--parent-session",
  "parent-sess-1",
  "--worker",
  "fake1",
  "--reviewer",
  "fake2",
];

function finishCall(repo, extra = [], deps = {}) {
  return executeRoleCommand(withRepo(["finish", "--cwd", "<repo>", ...extra], repo), {
    stdin: async () => JSON.stringify(GATE_SUMMARY),
    ...deps,
  });
}

async function dispatchReviewer(repo, reply) {
  return executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([reply]) },
    stdin: stdinPrompt,
  });
}

async function initWorkerRun(repo) {
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
}

// Usefulness: verifies --require-accept refuses a finish after a worker turn
// with no later reviewer turn, and keeps the run active (issue #218).
test("--require-accept refuses a finish after a worker turn with no later review", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("no reviewer turn");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies --require-accept refuses a finish after a reviewer
// reject, and allows it after a reviewer accept with a Checks line (issue #218).
test("--require-accept follows the latest reviewer verdict", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  await dispatchReviewer(repo, REJECT);
  const rejected = await finishCall(repo, ["--require-accept"]);
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("Verdict: accept");

  await dispatchReviewer(repo, ACCEPT);
  const accepted = await finishCall(repo, ["--require-accept"]);
  expect(accepted.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("finished");
});

// Usefulness: verifies --require-accept refuses a finish when the work tree
// changed after the accepted review, including an uncommitted state at the same
// head (issue #218).
test("--require-accept refuses a change after the accepted review", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);

  await writeFile(join(repo, "after-review.txt"), "changed after the review\n");
  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("work tree changed");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies --require-accept refuses an accept with no Checks line,
// matching the parent prompt rule (issue #218).
test("--require-accept refuses an accept with no Checks line", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT_NO_CHECKS);

  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("Checks");
});

// Usefulness: verifies --require-accept refuses when the reviewed snapshot is
// not exact, because a null-hash entry has no content identity (issue #218).
test("--require-accept refuses a reviewed snapshot that is not exact", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);

  const paths = statePaths({ cwd: repo });
  const state = await readRepoState(repo);
  state.lastResult.reviewed.exact = false;
  await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("the reviewed snapshot is not exact");
});

// Usefulness: verifies --require-accept refuses when the reviewed snapshot is
// exact but the current snapshot is not, so the refusal names the current
// snapshot rather than the reviewed one (issue #272).
test("--require-accept refuses a current snapshot that is not exact", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);
  expect((await readRepoState(repo)).lastResult.reviewed.exact).toBe(true);

  // Stage a gitlink after the review: the work-tree path is a directory, so the
  // current snapshot has an entry with no content hash and is not exact.
  const head = (await snapshot(repo)).head;
  await mkdir(join(repo, "sub"), { recursive: true });
  await execa("git", ["update-index", "--add", "--cacheinfo", "160000", head, "sub"], {
    cwd: repo,
  });

  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("the current snapshot is not exact");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies review-only keeps a flagless finish and rejects both
// gate flags with a clear error (issue #218).
test("review-only rejects the finish gates and keeps a flagless finish", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(
    withRepo(dispatchArgv(REVIEW_ONLY_OVERRIDES, "reviewer"), repo),
    basicDeps(),
  );

  const accepted = await finishCall(repo, ["--require-accept"]);
  expect(accepted.exitCode).toBe(1);
  expect(accepted.payload.error).toContain("review-only");

  const ci = await finishCall(repo, ["--require-ci", "42"]);
  expect(ci.exitCode).toBe(1);
  expect(ci.payload.error).toContain("review-only");

  const plain = await finishCall(repo);
  expect(plain.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("finished");
});

// Usefulness: verifies the gate flags are finish-only; dispatch and abort reject
// them (issue #218).
test("the finish gates are rejected outside finish", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const dispatchResult = await executeRoleCommand(
    withRepo(["dispatch", "--role", "worker", "--cwd", "<repo>", "--require-accept"], repo),
    basicDeps(),
  );
  expect(dispatchResult.exitCode).toBe(1);
  expect(dispatchResult.payload.error).toContain("only valid for finish");

  const abortResult = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "r", "--require-ci", "42"], repo),
  );
  expect(abortResult.exitCode).toBe(1);
  expect(abortResult.payload.error).toContain("only valid for finish");
});

// Usefulness: verifies --require-ci refuses a finish when GitHub reports an
// unknown merge state, and passes when the reviewed head is the PR head and no
// required check is failing (issue #218).
test("--require-ci refuses an unknown merge state and passes a clean PR", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);
  const head = (await snapshot(repo)).head;

  const ciGh = (mergeStateStatus) => async (args) => {
    const key = args.join(" ");
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (key.includes("pr view 42")) {
      return json({
        headRefOid: head,
        baseRefName: "main",
        mergeStateStatus,
        potentialMergeCommit: null,
        state: "OPEN",
      });
    }
    if (key.includes("repo view")) {
      return { status: 0, stdout: "owner/repo", stderr: "" };
    }
    if (key.includes("rules/branches/main")) {
      return json([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
        },
      ]);
    }
    if (key.includes("branches/main/protection")) {
      return { status: 1, stdout: "", stderr: "HTTP 404" };
    }
    if (key.includes("/check-runs")) {
      return json([
        {
          check_runs: [
            {
              name: "ci (ubuntu-latest)",
              status: "completed",
              conclusion: "success",
              started_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ]);
    }
    if (key.includes("/status")) {
      return json({ statuses: [] });
    }
    return { status: 1, stdout: "", stderr: `unmatched: ${key}` };
  };

  const refused = await finishCall(repo, ["--require-ci", "42"], { gh: ciGh("UNKNOWN") });
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("merge state as unknown");

  const passed = await finishCall(repo, ["--require-ci", "42"], { gh: ciGh("CLEAN") });
  expect(passed.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("finished");
});

const UNRESOLVED_SUMMARY = {
  ...GATE_SUMMARY,
  notDone: "PR head unresolved",
  open: "PR head unresolved",
  unresolvedCompare: true,
};

// Usefulness: verifies an interactive finish that reports an unresolved PR-head
// compare is machine-distinct from a verified finish, in the envelope and the
// state file, where nothing else separates the two (issue #281).
test("finish records unresolvedCompare in the envelope and the state", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(UNRESOLVED_SUMMARY),
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    lifecycle: "finished",
    unresolvedCompare: true,
  });

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("finished");
  expect(state.unresolvedCompare).toBe(true);
  // The marker is a sibling of the summary, never one of its keys.
  expect(state.summary).toEqual({
    ...GATE_SUMMARY,
    notDone: "PR head unresolved",
    open: "PR head unresolved",
  });
});

// Usefulness: verifies a verified finish keeps its current envelope and state,
// so the new marker does not make every recorded finish look unresolved (#281).
test("a verified finish keeps its envelope and state unchanged", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const result = await finishCall(repo);
  expect(result.payload).toEqual({ status: "ok", lifecycle: "finished" });

  const state = await readRepoState(repo);
  expect(state.summary).toEqual(GATE_SUMMARY);
  expect(state).not.toHaveProperty("unresolvedCompare");
});

// Usefulness: pins the accepted gap for #286. A PR-work finish that records the
// unresolved compare under `notDone` and `open` and omits the marker finishes as
// verified: exit 0, no marker in the envelope or the state file, and the free
// text the only trace. A consumer cannot tell it from a verified finish, so the
// limit stays pinned here.
test("a PR finish that omits unresolvedCompare reads as verified", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const summary = {
    ...GATE_SUMMARY,
    notDone: "PR head unresolved",
    open: "PR head unresolved",
  };
  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(summary),
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({ status: "ok", lifecycle: "finished" });

  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("finished");
  expect(state).not.toHaveProperty("unresolvedCompare");
  expect(state.summary).toEqual(summary);
});

// Usefulness: verifies the marker reaches the action contract instead of being
// dropped as an unknown key, so a non-boolean value refuses the finish (#281).
test("finish refuses a non-boolean unresolvedCompare", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify({ ...GATE_SUMMARY, unresolvedCompare: "yes" }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("unresolvedCompare must be a boolean");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies a finish cannot claim an unresolved compare and pass the
// CI gate, which resolves the PR head and so proves the compare (#281).
test("finish refuses unresolvedCompare together with --require-ci", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await initWorkerRun(repo);

  const result = await executeRoleCommand(
    withRepo(["finish", "--cwd", "<repo>", "--require-ci", "42"], repo),
    {
      stdin: async () => JSON.stringify(UNRESOLVED_SUMMARY),
      gh: async () => {
        throw new Error("gh must not run: the marker and the gate are contradictory.");
      },
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("unresolvedCompare cannot be combined with --require-ci");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});
