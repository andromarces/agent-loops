import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see `useCleanRepo`
// and `cleanRepoGit` in git-helpers.mjs), so no test here starts a `git`
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

import { executeRoleCommand } from "../src/role/index.mjs";
import { readState, statePaths } from "../src/lib/runstate.mjs";
import {
  ACCEPT,
  basicDeps,
  cleanup,
  dispatchArgv,
  dispatchReviewer,
  finishCall,
  GATE_SUMMARY,
  initPrRun,
  initWorkerRun,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  repos,
  REVIEW_ONLY_OVERRIDES,
  setup,
  stdinPrompt,
  UNRESOLVED_SUMMARY,
  withRepo,
} from "./role-helpers.mjs";
import { removePath } from "./fs-helpers.mjs";
import { CLEAN_REPO_HEAD, cleanRepoGit } from "./git-helpers.mjs";
import {
  apiArgs,
  equalsArgs,
  expectNoReplyToMalformedCalls,
  gateReadCalls,
  isPagedRead,
  pagedApiArgs,
  pageStdout,
  prViewArgs,
  REPO_VIEW_ARGS,
} from "./gh-doubles.mjs";

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

// Usefulness: verifies #839 — a malformed summary refusal carries a non-empty diagnosis
// and never echoes any part of the summary text.
describe("finish refusal for a summary that is not valid JSON", () => {
  const PREFIX = "finish summary must be a JSON object on stdin: ";

  async function refuse(text) {
    await setup();
    const repo = await useCleanRepo();
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
      ...basicDeps(),
    });
    const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
      stdin: async () => text,
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error.startsWith(PREFIX)).toBe(true);
    return result.payload.error.slice(PREFIX.length);
  }

  test("a malformed escape names the parser diagnosis and position without echoing the input", async () => {
    const diagnosis = await refuse(String.raw`{"changed":"C:\x"}`);
    expect(diagnosis).toMatch(/^Bad escaped character at position \d+/);
    expect(diagnosis).not.toContain("changed");
  });

  test.each([
    ['{"a":"b', "Unterminated string"],
    ['{"a":1 "b":2}', "Expected ',' or '}' after property value"],
    ["[1 2]", "Expected ',' or ']' after array element"],
    ['{"a":1} x', "Unexpected non-whitespace character after JSON"],
  ])("%s names the parser diagnosis %s", async (text, phrase) => {
    expect(await refuse(text)).toMatch(new RegExp(`^${phrase} at position \\d+`));
  });

  test("an empty summary names the end-of-input diagnosis", async () => {
    expect(await refuse("")).toBe("Unexpected end of JSON input");
  });

  test("a bare token is not echoed", async () => {
    const diagnosis = await refuse("Q");
    expect(diagnosis.length).toBeGreaterThan(0);
    expect(diagnosis).not.toContain("Q");
  });

  test.each(["undefined", "NaN"])("%s still gets a non-empty diagnosis", async (text) => {
    const diagnosis = await refuse(text);
    expect(diagnosis.trim().length).toBeGreaterThan(0);
    expect(diagnosis).not.toContain(text);
  });

  test("a secret-looking string with a syntax error is not echoed", async () => {
    const diagnosis = await refuse('{"token":"sk-live-abc123SECRET" oops}');
    expect(diagnosis.length).toBeGreaterThan(0);
    expect(diagnosis).not.toContain("sk-live-abc123SECRET");
    expect(diagnosis).not.toContain("oops");
  });
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

const ACCEPT_NO_CHECKS = "Conclusion: done\nWhy: tests pass\nBlockers: none\nVerdict: accept";
const WORKER_WITH_CHECKS = "Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: npm test";
const REJECT =
  "Conclusion: no\nWhy: broken\nBlockers: missing test\nChecks: npm test\nVerdict: reject";
const BOLD_ONLY_SPLIT =
  "Conclusion: done\nWhy: ok\nBlockers: none\nVerdict: accept\n**Checks:** tests passed";
const ALL_BOLD_SPLIT =
  "**Conclusion:** done\n**Why:** ok\n**Blockers:** none\n**Checks:** tests passed\nVerdict: accept";

async function dispatchUnidentifiedReviewer(repo, reply) {
  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-multi";
    state.multiPartUnidentified = true;
    return reply;
  };
  return executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
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
  expect(result.payload.error).toBe(
    "Finish refused: no reviewer turn after the latest worker turn.",
  );
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies the interactive finish names a worker turn after an
// accepted review, so the refusal states the turn order rather than a missing
// review (#1516). A later reviewer accept still passes, so only the wording
// changes.
test("--require-accept names a worker turn after an accepted review", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);
  await dispatchWorker(repo, "edited a checklist item on the issue");

  const refused = await finishCall(repo, ["--require-accept"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain(
    "a worker turn ran after the last review, and a reviewer accept with a Checks line on the current state must come before finish",
  );
  expect(refused.payload.error).not.toContain("no reviewer turn after the latest worker turn");
  expect((await readRepoState(repo)).lifecycle).toBe("active");

  await dispatchReviewer(repo, ACCEPT);
  const accepted = await finishCall(repo, ["--require-accept"]);
  expect(accepted.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("finished");
});

// Usefulness: verifies the interactive finish names a worker turn after a
// rejected review too, so the wording does not depend on the verdict (#1516).
test("--require-accept names a worker turn after a rejected review", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  await dispatchReviewer(repo, REJECT);
  await dispatchWorker(repo, "edited a checklist item on the issue");

  const result = await finishCall(repo, ["--require-accept"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain(
    "a worker turn ran after the last review, and a reviewer accept with a Checks line on the current state must come before finish",
  );
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

// A `git` answer that reports a cancel for a call that carries an aborted signal, as execa does,
// and answers as `cleanRepoGit` otherwise.
const cancelAwareGit = (command, args, options) =>
  options?.cancelSignal?.aborted
    ? { exitCode: undefined, isCanceled: true, stdout: "", stderr: "" }
    : cleanRepoGit(command, args, options);

// Usefulness: verifies the snapshot behind the `--require-accept` gate honors the cancel of the
// command, so a canceled finish ends with exit 130 and keeps the run active (#729).
test("--require-accept ends a canceled finish with exit 130 and keeps the run active", async () => {
  await setup();
  const repo = await useCleanRepo(cancelAwareGit);
  await initWorkerRun(repo);
  await dispatchReviewer(repo, ACCEPT);
  const controller = new AbortController();
  controller.abort();

  const result = await finishCall(repo, ["--require-accept"], { signal: controller.signal });
  expect(result.exitCode).toBe(130);
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies the work-tree probe of `role dispatch` honors the cancel of the command, so
// a canceled dispatch ends with exit 130 and never starts the turn (#729).
test("dispatch ends a canceled work-tree probe with exit 130 and runs no turn", async () => {
  await setup();
  const repo = await useCleanRepo(cancelAwareGit);
  const worker = recordingAdapter([]);
  const controller = new AbortController();
  controller.abort();

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    signal: controller.signal,
  });
  expect(result.exitCode).toBe(130);
  expect(worker.recorded).toHaveLength(0);
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

// Usefulness: verifies the interactive gate refuses a reviewer accept whose report is null for the
// missing Why label (issue #1520). It names Why in the dispatch envelope, and accepts a later report
// that carries Why and Checks.
test("--require-accept refuses an accept with no Why label and names Why", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  const noWhy = "Conclusion: done\nBlockers: none\nChecks: npm test\nVerdict: accept";

  // The one repair turn repeats the unparseable block, so this turn keeps its null report.
  const refusedReview = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([noWhy, noWhy]) },
    stdin: stdinPrompt,
  });
  expect(refusedReview.payload.report).toBeNull();
  expect(refusedReview.payload.reportMissingLabels).toEqual(["Why"]);
  const refused = await finishCall(repo, ["--require-accept"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("Checks");
  expect((await readRepoState(repo)).lifecycle).toBe("active");

  await dispatchReviewer(repo, ACCEPT);
  const accepted = await finishCall(repo, ["--require-accept"]);
  expect(accepted.exitCode).toBe(0);
  expect((await readRepoState(repo)).lifecycle).toBe("finished");
});

// Usefulness: verifies the interactive gate stays closed for a parsed report without Conclusion.
test("--require-accept refuses an accept with prose and no Conclusion label", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  const noConclusion = [
    "The state passes.",
    "**Count.** one turn.",
    "Why: changes match the task.",
    "Blockers: none.",
    "Checks: npm test",
    "Verdict: accept",
  ].join("\n");

  const refusedReview = await dispatchReviewer(repo, noConclusion);
  expect(refusedReview.payload.report).not.toBeNull();
  expect(refusedReview.payload.verdict).toBe("unknown");
  const refused = await finishCall(repo, ["--require-accept"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("Verdict: accept");
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

// Usefulness: verifies interactive --require-accept refuses a bold-only report from a multi-part
// unidentified turn, so the shared fail-closed report reaches the finish gate (issue #1483).
test.each([
  ["plain labels with a bold Checks line", BOLD_ONLY_SPLIT],
  ["all bold labels", ALL_BOLD_SPLIT],
])(
  "--require-accept refuses a bold-only report across unidentified parts: %s",
  async (_name, reply) => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);
    await dispatchUnidentifiedReviewer(repo, reply);

    const result = await finishCall(repo, ["--require-accept"]);
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("Checks");
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  },
);

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

// Usefulness: pins that abort reports the missing --reason before a misplaced
// finish gate, so the refusal text stays the one callers saw before the shared guard (issue #728).
test("abort without --reason reports the missing reason before a finish gate", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);

  for (const gate of [["--require-accept"], ["--require-ci", "42"]]) {
    const result = await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", ...gate], repo));
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toBe("abort requires --reason.");
  }
});

// Usefulness: verifies finish rejects --reason like the other operations and
// leaves the run untouched; the flag was silently dropped before (issue #728).
test("finish rejects --reason and leaves the run state unchanged", async () => {
  await setup();
  const repo = await useCleanRepo();
  await initWorkerRun(repo);
  const before = await readRepoState(repo);

  const result = await finishCall(repo, ["--reason", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toBe("--reason is only valid for abort.");
  expect(await readRepoState(repo)).toEqual(before);
});

const ciGh = (head, mergeStateStatus) => async (args) => {
  const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  if (equalsArgs(args, prViewArgs(42))) {
    return json({
      headRefOid: head,
      baseRefName: "main",
      mergeStateStatus,
      potentialMergeCommit: null,
      state: "OPEN",
    });
  }
  if (equalsArgs(args, REPO_VIEW_ARGS)) {
    return { status: 0, stdout: "owner/repo", stderr: "" };
  }
  if (equalsArgs(args, pagedApiArgs("repos/owner/repo/rules/branches/main"))) {
    // The ruleset read pages by number, so each reply is one page: a list of rules.
    return {
      status: 0,
      stdout: pageStdout([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
        },
      ]),
      stderr: "",
    };
  }
  if (equalsArgs(args, apiArgs("repos/owner/repo/branches/main/protection"))) {
    return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
  }
  if (isPagedRead(args, "/check-runs")) {
    return {
      status: 0,
      stdout: pageStdout({
        check_runs: [
          {
            name: "ci (ubuntu-latest)",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      stderr: "",
    };
  }
  if (isPagedRead(args, "/status")) {
    return { status: 0, stdout: pageStdout({ statuses: [] }), stderr: "" };
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

// Usefulness: verifies requirement "role finish refuses an unknown summary key" (#1021): the key was
// dropped and the finish read as verified, including a misspelled unresolvedCompare marker.
test.each(["notNotDone", "unresolvedcompare", "unresolved_compare"])(
  "finish refuses the unknown summary key %s, names it, and keeps the run active",
  async (key) => {
    await setup();
    const repo = await useCleanRepo();
    await initWorkerRun(repo);

    const result = await executeRoleCommand(withRepo(["finish", "--cwd", "<repo>"], repo), {
      stdin: async () => JSON.stringify({ ...GATE_SUMMARY, [key]: true }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain(`"${key}"`);
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  },
);

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
// text it returned before #302.
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

// Usefulness: verifies the `--require-ci` merge-state double routes on the exact argument
// elements, so a call that merges two elements into one, drops one, or adds one
// gets no reply and its error prints the array (issues #530 and #538).
test("the merge-state double gives no reply to a malformed call", async () => {
  await expectNoReplyToMalformedCalls(
    ciGh(CLEAN_REPO_HEAD, "CLEAN"),
    gateReadCalls(CLEAN_REPO_HEAD),
  );
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
