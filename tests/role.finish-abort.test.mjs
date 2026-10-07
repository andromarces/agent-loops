import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see `useCleanRepo`
// and `cleanRepoGit` in runtime-helpers.mjs), so no test here starts a `git`
// process. Snapshot behavior against a real repo is tested in
// tests/lib/snapshot.test.mjs.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { executeRoleCommand } from "../src/role.mjs";
import { readState, statePaths } from "../src/lib/runstate.mjs";
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
import {
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  isApiRead,
  removePath,
  startsWithArgs,
} from "./runtime-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  gitDouble.answer = null;
});

// A directory with a `.git` directory stands in for a repo, and `git` is answered
// from memory until the test ends, so the test starts no `git` process. `answer`
// replaces `cleanRepoGit` where the test needs another repo state.
async function useCleanRepo(answer = cleanRepoGit) {
  const repo = await mkdtemp(join(tmpdir(), "role-test-clean-repo-"));
  await mkdir(join(repo, ".git"));
  repos.push(repo);
  gitDouble.answer = answer;
  return repo;
}

// A clean repo whose work tree status is `status`, in the `--porcelain=v1 -z` format.
function gitWithStatus(status) {
  return (command, args, options) =>
    args[0] === "status"
      ? { exitCode: 0, stdout: status, stderr: "" }
      : cleanRepoGit(command, args, options);
}

// A clean repo that git refuses once its `.git` directory is gone, as `git` does
// outside a work tree.
function gitUnlessGitDirGone(command, args, options) {
  return existsSync(join(options.cwd, ".git"))
    ? cleanRepoGit(command, args, options)
    : { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
}

// Usefulness: verifies abort ends a run whose `--cwd` no longer exists or is no
// longer a Git work tree. A refused dispatch leaves that run active, and the
// parent rule for it is to abort rather than repair, so abort has to be the one
// command that works without a usable work tree (issue #327).
test("abort ends a run whose --cwd is missing or not a Git work tree", async () => {
  await setup();
  const goneRepo = await useCleanRepo(gitUnlessGitDirGone);
  const plainRepo = await useCleanRepo(gitUnlessGitDirGone);
  const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };

  for (const repo of [goneRepo, plainRepo]) {
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
      agents,
      stdin: stdinPrompt,
    });
  }
  await removePath(goneRepo);
  await removePath(join(plainRepo, ".git"));

  for (const repo of [goneRepo, plainRepo]) {
    const result = await executeRoleCommand(
      withRepo(["abort", "--cwd", "<repo>", "--reason", "work tree unusable"], repo),
      { agents },
    );
    expect(result.exitCode, repo).toBe(0);
    expect(result.payload, repo).toMatchObject({ status: "ok", lifecycle: "aborted" });
    const state = await readRepoState(repo);
    expect(state.lifecycle, repo).toBe("aborted");
    expect(state.reason, repo).toBe("work tree unusable");
  }
});

// Usefulness: verifies abort refuses a path that holds no run state, so a parent
// that never started a run there cannot end one. The refused-`--cwd` rule tells
// that case apart from a live run, and this pins the command side of it (issue
// #327).
test("abort refuses a path with no run state", async () => {
  await setup();
  const repo = await useCleanRepo();

  const result = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "work tree unusable"], repo),
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toContain("No run state for");
  expect(await readState(statePaths({ cwd: repo }).stateFile)).toBeNull();
});

// Usefulness: verifies abort refuses a run that is already terminal and leaves its
// recorded reason alone, so a run the runtime already ended needs no abort and no
// second one can rewrite why it ended (issue #327).
test("abort refuses a run that is already terminal", async () => {
  await setup();
  const repo = await useCleanRepo();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  expect((await readRepoState(repo)).lifecycle).toBe("aborted");

  const again = await executeRoleCommand(
    withRepo(["abort", "--cwd", "<repo>", "--reason", "work tree unusable"], repo),
  );
  expect(again.exitCode).toBe(1);
  expect(again.payload.status).toBe("error");
  expect(again.payload.error).toContain("already aborted");
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("aborted");
  expect(state.reason).toBe("stop");
});

// Usefulness: verifies acceptance — finish from active in review-only mode
// succeeds with verdict: reject recorded in the summary.
test("finish from active in review-only mode succeeds with the verdict recorded", async () => {
  await setup();
  const repo = await useCleanRepo();

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
  const repo = await useCleanRepo();

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
  const repo = await useCleanRepo();

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
const WORKER_WITH_CHECKS = "Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: npm test";
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

async function dispatchWorker(repo, reply) {
  return executeRoleCommand(withRepo(dispatchArgv([]), repo), {
    agents: { fake1: recordingAdapter([reply]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
}

// Usefulness: verifies --require-accept refuses a finish after a worker turn
// with no later reviewer turn, and keeps the run active (issue #218).
test("--require-accept refuses a finish after a worker turn with no later review", async () => {
  await setup();
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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

// Usefulness: verifies a worker Checks line is reported evidence and never a
// gate input: a finish that follows a worker turn carrying a Checks line is
// refused until a reviewer accept covers the state (issue #310, issue #318).
test("--require-accept refuses a finish that relies on a worker Checks line", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);

  await dispatchWorker(repo, WORKER_WITH_CHECKS);
  const refused = await finishCall(repo, ["--require-accept"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("no reviewer turn");
  expect((await readRepoState(repo)).lifecycle).toBe("active");

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
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);

  await writeFile(join(repo, "after-review.txt"), "changed after the review\n");
  gitDouble.answer = gitWithStatus("?? after-review.txt\0");
  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("work tree changed");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies --require-accept refuses an accept with no Checks line,
// matching the parent prompt rule (issue #218).
test("--require-accept refuses an accept with no Checks line", async () => {
  await setup();
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);
  expect((await readRepoState(repo)).lastResult.reviewed.exact).toBe(true);

  // A directory in the work tree path has no content hash, so the current snapshot
  // is not exact.
  await mkdir(join(repo, "sub"), { recursive: true });
  gitDouble.answer = gitWithStatus("A  sub\0");

  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("the current snapshot is not exact");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies review-only keeps a flagless finish and rejects both
// gate flags with a clear error (issue #218).
test("review-only rejects the finish gates and keeps a flagless finish", async () => {
  await setup();
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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

const ciGh = (head, mergeStateStatus) => async (args) => {
  const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  if (startsWithArgs(args, ["pr", "view", "42"])) {
    return json({
      headRefOid: head,
      baseRefName: "main",
      mergeStateStatus,
      potentialMergeCommit: null,
      state: "OPEN",
    });
  }
  if (startsWithArgs(args, ["repo", "view"])) {
    return { status: 0, stdout: "owner/repo", stderr: "" };
  }
  if (startsWithArgs(args, ["api", "repos/owner/repo/rules/branches/main"])) {
    // The ruleset read is paginated, so its body is an array of pages.
    return json([
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
        },
      ],
    ]);
  }
  if (startsWithArgs(args, ["api", "repos/owner/repo/branches/main/protection"])) {
    return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
  }
  if (isApiRead(args, "/check-runs")) {
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
  if (isApiRead(args, "/status")) {
    return json({ statuses: [] });
  }
  return { status: 1, stdout: "", stderr: `unmatched: ${JSON.stringify(args)}` };
};

// Usefulness: verifies --require-ci refuses a finish when GitHub reports an
// unknown merge state, and passes when the reviewed head is the PR head and no
// required check is failing (issue #218).
test("--require-ci refuses an unknown merge state and passes a clean PR", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);
  const head = CLEAN_REPO_HEAD;

  const refused = await finishCall(repo, ["--require-ci", "42"], { gh: ciGh(head, "UNKNOWN") });
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("merge state as unknown");

  const passed = await finishCall(repo, ["--require-ci", "42"], { gh: ciGh(head, "CLEAN") });
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
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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
  const repo = await useCleanRepo();
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

// Usefulness: pins the exact error text an undeclared run gets. The collect-then-
// report rule added a `Finish refused:` prefix to every collected reason, which
// changed the error an undeclared run returns for the one refusal it had before.
// Collect-then-report was for the declared-PR rule, so an undeclared run keeps the
// text origin/main returned (#302).
test("an undeclared run keeps the marker refusal text it had before", async () => {
  await setup();
  const repo = await useCleanRepo();
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
  expect(result.payload.error).toBe(
    "unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved.",
  );
});

async function initPrRun(repo, pr) {
  await executeRoleCommand(withRepo(dispatchArgv([...INIT_OVERRIDES, "--pr", String(pr)]), repo), {
    ...basicDeps(),
  });
}

function cleanPrGh(head) {
  return async (args) => {
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (startsWithArgs(args, ["pr", "view"])) {
      return json({
        headRefOid: head,
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
        potentialMergeCommit: null,
        state: "OPEN",
      });
    }
    if (startsWithArgs(args, ["repo", "view"])) {
      return { status: 0, stdout: "owner/repo", stderr: "" };
    }
    if (startsWithArgs(args, ["api", "repos/owner/repo/rules/branches/main"])) {
      // The ruleset read is paginated, so its body is an array of pages.
      return json([
        [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
          },
        ],
      ]);
    }
    if (startsWithArgs(args, ["api", "repos/owner/repo/branches/main/protection"])) {
      return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
    }
    if (isApiRead(args, "/check-runs")) {
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
    if (isApiRead(args, "/status")) {
      return json({ statuses: [] });
    }
    return { status: 1, stdout: "", stderr: `unmatched: ${JSON.stringify(args)}` };
  };
}

// Usefulness: verifies the `--require-ci` doubles route on the argument
// elements, so a call that merges the arguments into one element gets no reply
// and its error prints the array, which differs from the text of the expected
// call (issue #530).
test.each([
  ["the merge-state double", ciGh(CLEAN_REPO_HEAD, "CLEAN")],
  ["the clean-PR double", cleanPrGh(CLEAN_REPO_HEAD)],
])("%s gives no reply to a merged-argument call", async (_name, gh) => {
  const merged = ["pr view 42 --json headRefOid"];
  const reply = await gh(merged);
  expect(reply.status).toBe(1);
  expect(reply.stdout).toBe("");
  expect(reply.stderr).toContain(JSON.stringify(merged));
});

// Usefulness: verifies an interactive run that declares a PR refuses a finish
// with no `--require-ci` gate, so a declared PR run cannot end through a field
// the parent set. The run stays active, so the parent can finish with the gate
// (#302).
test("a run that declares a PR refuses a finish with no --require-ci gate", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);

  const refused = await finishCall(repo, [], {
    gh: async () => {
      throw new Error("gh must not run: no gate was requested.");
    },
  });
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("declares PR 42");
  expect(refused.payload.error).toContain("--require-ci 42");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies the same refusal covers a finish that records the
// unresolved compare, because the declaration requires the gate that resolves
// that compare. A recorded marker here would be an accepted gap the run must not
// produce (#302).
test("a run that declares a PR refuses a finish that records unresolvedCompare", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);

  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(UNRESOLVED_SUMMARY),
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("declares PR 42");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies the interactive path reports every applicable condition in
// one refusal, in the order the headless list uses, so a parent that fixes one
// condition per `finish` call spends a call on the condition the next refusal
// names instead (#302).
test("a declared PR with no gate reports the marker and the gate in one refusal", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);

  const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
    stdin: async () => JSON.stringify(UNRESOLVED_SUMMARY),
    gh: async () => {
      throw new Error("gh must not run: no gate was requested.");
    },
  });

  const marker =
    "unresolvedCompare cannot be combined with a run that declares PR 42 (--pr): the run must end through the --require-ci 42 gate, which resolves that PR head, so that compare is not unresolved";
  const gate =
    "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toBe(`Finish refused: ${marker}; ${gate}.`);
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// A `gh` runner for a ruleset-only base branch with no required check: the ruleset
// read returns a non-empty array of well-formed rules with no
// required-status-check rule, and classic protection answers the exact 404 that
// only a caller able to read it receives on an unprotected branch. Each source
// stated that it holds no required check, so the gate establishes the absence
// rather than inferring it (#336). `gh pr checks --required` prints nothing there,
// which is not a statement about the branch and is not read as one.
function noRequiredCheckGh(head) {
  const read = cleanPrGh(head);
  return async (args) => {
    if (startsWithArgs(args, ["api", "repos/owner/repo/rules/branches/main"])) {
      return {
        status: 0,
        stdout: JSON.stringify([
          [
            { type: "deletion" },
            { type: "non_fast_forward" },
            { type: "pull_request", parameters: { required_approving_review_count: 0 } },
          ],
        ]),
        stderr: "",
      };
    }
    if (startsWithArgs(args, ["pr", "checks"])) {
      return { status: 1, stdout: "", stderr: "no required checks reported" };
    }
    return read(args);
  };
}

// The finishes below run on a repo whose `git` is answered from memory. A
// declared run with one accepted reviewer turn takes about twenty `git`
// processes to reach the finish (a repo, then a snapshot around each turn), and a
// loaded Windows runner outlasted a test limit on that before the finish under
// test started (issue #385). The `role` code is real: the double replaces only
// the `git` child, so the dispatches, the snapshots, and the finish gate all run
// over the answers. Snapshot behavior against a real repo keeps its own tests.
// A directory stands in for the repo: the double answers for it, so it needs no
// `git` setup.
async function useDeclaredPrRun() {
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);
  return { repo, head: CLEAN_REPO_HEAD };
}

async function useAcceptedPrRun() {
  const run = await useDeclaredPrRun();
  await dispatchReviewer(run.repo, ACCEPT);
  return run;
}

// Usefulness: verifies the no-required-check double replies to separate argument
// elements only, so a merged-argument call reaches the clean-PR double and gets no
// ruleset or `pr checks` reply (issue #538).
test("the no-required-check double gives no reply to a merged-argument call", async () => {
  const gh = noRequiredCheckGh(CLEAN_REPO_HEAD);
  for (const merged of [["api repos/owner/repo/rules/branches/main"], ["pr checks 42"]]) {
    const reply = await gh(merged);
    expect(reply.status).toBe(1);
    expect(reply.stderr).toContain(JSON.stringify(merged));
  }
});

describe("finish on a run that declares a PR", () => {
  // Usefulness: verifies a declared run finishes on a base branch with no required
  // check, and records the absence in the envelope and the state file, so a finish
  // that verified no check stays distinguishable from one that verified a check
  // (issue #336).
  test("a declared PR finishes on a base branch with no required check", async () => {
    await setup();
    const { repo, head } = await useAcceptedPrRun();

    const result = await finishCall(repo, ["--require-ci", "42"], {
      gh: noRequiredCheckGh(head),
    });
    expect(result.exitCode).toBe(0);
    expect(result.payload).toMatchObject({ noRequiredChecks: true });
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("finished");
    expect(state.noRequiredChecks).toBe(true);
  });

  // Usefulness: verifies a gated finish on a base branch that does require a check
  // records no absence, so the field means the branch had none rather than that the
  // gate ran (issue #336).
  test("a gated finish records no absence when the base branch requires a check", async () => {
    await setup();
    const { repo, head } = await useAcceptedPrRun();

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: cleanPrGh(head) });
    expect(result.exitCode).toBe(0);
    expect(result.payload.noRequiredChecks).toBeUndefined();
    expect((await readRepoState(repo)).noRequiredChecks).toBeUndefined();
  });

  // Usefulness: verifies the same collect-then-report rule covers the completion
  // rule, so a declared PR run learns about the unmet reviewer turn and the missing
  // gate from one `finish` call (#302).
  test("a declared PR with no gate reports the completion rule and the gate in one refusal", async () => {
    await setup();
    const { repo } = await useDeclaredPrRun();

    const result = await finishCall(repo, ["--require-accept"], {
      gh: async () => {
        throw new Error("gh must not run: no gate was requested.");
      },
    });

    const gate =
      "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toBe(
      `Finish refused: no reviewer turn after the latest worker turn; ${gate}.`,
    );
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies a run that declares a PR and gates the same PR behaves as
  // a gated run does today, so the declaration adds no second enforcement path
  // (#302).
  test("a declared PR with a matching gate finishes as the gate allows", async () => {
    await setup();
    const { repo, head } = await useAcceptedPrRun();

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: cleanPrGh(head) });
    expect(result.exitCode).toBe(0);
    expect((await readRepoState(repo)).lifecycle).toBe("finished");
  });
});

// Usefulness: verifies a run that declares a PR refuses a gate for a different
// PR without reading GitHub, so a wrong PR never reaches the gate (#302).
test("a run that declares a PR refuses a gate for a different PR", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);
  await dispatchReviewer(repo, ACCEPT);

  const result = await finishCall(repo, ["--require-ci", "7"], {
    gh: async () => {
      throw new Error("gh must not run: the gate names a different PR.");
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("declares PR 42");
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies a refused finish makes no GitHub call of its own, measured
// from the moment the finish call starts. The earlier assertion proved the gate
// never ran by throwing on any call, which also fails for a call the finish did
// not make, so it had no boundary at which the refusal is expected to be quiet.
// The boundary is the finish call itself, and the assertion is zero calls inside
// it (issue #320 review, third round).
test("a refused finish makes no GitHub call from the moment the finish starts", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);
  await dispatchReviewer(repo, ACCEPT);

  // The boundary: every call made from here is made by the finish.
  const callsDuringFinish = [];
  const result = await finishCall(repo, ["--require-ci", "7"], {
    gh: async (args) => {
      callsDuringFinish.push(args.join(" "));
      return { status: 0, stdout: "[]", stderr: "" };
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("declares PR 42");
  // Zero, not "no call the list recognises": the refusal is quiet, so a call the
  // assertion does not know about still fails it.
  expect(callsDuringFinish).toEqual([]);
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});
