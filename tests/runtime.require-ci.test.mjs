import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `cleanRepoGit` in git-helpers.mjs); every other test reaches the real `execa`.
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

import { runLoop } from "../src/runtime.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { CLEAN_REPO_HEAD, cleanRepoGit, createCleanRepoDir } from "./git-helpers.mjs";
import {
  equalsArgs,
  gateReads,
  isPagedRead,
  pageStdout,
  prGateGh,
  prViewArgs,
} from "./gh-doubles.mjs";
import { gateRoles, REVIEW_ACCEPT, REVIEW_REJECT, SUMMARY } from "./run-fixtures.mjs";

const OTHER_HEAD = "2".repeat(40);

// 43. Usefulness: verifies the headless --require-ci gate resolves the PR head in
// the runtime: a finish whose PR head is not the reviewed commit is refused with
// the gate reason, recorded as a refusal event, and ends the run on exit 1
// (issue #293).
test("--require-ci refuses a finish whose PR head is not the reviewed commit", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(OTHER_HEAD),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR head differs from the reviewed commit");
    expect(events.filter((e) => e.type === "refusal").map((e) => e.reason)).toEqual([
      "the PR head differs from the reviewed commit",
      "the PR head differs from the reviewed commit",
    ]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 44. Usefulness: verifies the same gate accepts the finish once the PR head is
// the reviewed commit, so the refusal above comes from the gate result and not
// from a gate that always refuses (issue #293).
test("--require-ci passes a finish whose PR head is the reviewed commit", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const calls = [];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 44 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(head, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
    expect(events.some((e) => e.type === "refusal")).toBe(false);
    expect(calls.some((key) => key.includes("pr view 42"))).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 45. Usefulness: verifies a worker turn after the reviewer accept names the turn order (#1509).
// The commit after the review still cannot pass against the older reviewed head (#293).
test("--require-ci names a worker turn after an accepted review", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 45 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(head),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker committed after the review"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain(
      "a worker turn ran after the last review, and a reviewer turn on the current state must come before finish",
    );
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 45a. Usefulness: verifies a worker turn after a reviewer reject names the same turn order (#1509).
// A rejected review followed by a worker edit then reads as turn order, not a missing review.
test("--require-ci names a worker turn after a rejected review", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "PR work: address issue 1509 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(head),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker edited after the review"]),
        rev: scripted([REVIEW_REJECT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain(
      "a worker turn ran after the last review, and a reviewer turn on the current state must come before finish",
    );
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 45b. Usefulness: verifies a failed reviewer turn keeps the origin/main refusal with no later worker turn (#1509).
// The turn-order wording then does not cover a missing review.
test("--require-ci keeps the no-reviewed-state refusal after a failed reviewer turn", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "PR work: address issue 1509 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(head),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted([]),
        rev: scripted([
          () => {
            throw new Error("reviewer CLI failed");
          },
        ]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
    expect(result.reason).not.toContain("a worker turn ran after the last review");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 46. Usefulness: verifies the gate refuses a finish that also records the
// unresolved compare, and does so without asking GitHub, because the gate
// resolves that compare and the marker would contradict it (issue #293, #281).
test("--require-ci refuses a finish that carries unresolvedCompare", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const head = CLEAN_REPO_HEAD;
    const calls = [];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 46 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(head, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("unresolvedCompare cannot be combined with --require-ci");
    expect(calls).toEqual([]);
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a `gh` rejection whose `message` getter throws still refuses the
// finish. A getter that throws inside the gate catch block would throw out of the
// loop and discard a run that a later gate read could pass (issue #475).
test("--require-ci refuses when the gh error message getter throws", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const hostile = new Error("hidden");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("message getter");
      },
    });
    const throwingGh = async (args) => {
      if (equalsArgs(args, prViewArgs(42))) {
        throw hostile;
      }
      return prGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 47 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: throwingGh,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR gate could not be evaluated");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a `gh` rejection whose `message` is an object with its own
// `toString` key still refuses the finish. A plain string conversion of the
// serialized message throws inside the gate catch block (issue #475 review).
test("--require-ci refuses when the gh error message is a non-string with a toString key", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const throwingGh = async (args) => {
      if (equalsArgs(args, prViewArgs(42))) {
        throw Object.assign(new Error("hidden"), { message: { toString: 1 } });
      }
      return prGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 47 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: throwingGh,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR gate could not be evaluated");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 47. Usefulness: verifies a `gh` failure inside the gate refuses the finish
// instead of throwing out of the loop. The interactive path leaves the run active
// for a retry, and the headless run has none outside the refusal, so a throw
// would discard a run a second attempt could pass (#293).
test("--require-ci turns a gh failure into a refusal, not a throw", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];
    const failingGh = async (args) => {
      if (equalsArgs(args, prViewArgs(42))) {
        return { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
      }
      return prGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 47 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: failingGh,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR gate could not be evaluated");
    expect(result.reason).toContain("Bad credentials");
    // Refusals, not a throw: the first gives the orchestrator its corrective
    // turn, and the second ends the run on the ordinary refusal path.
    expect(events.filter((e) => e.type === "refusal").map((e) => e.reason)).toEqual([
      expect.stringContaining("Bad credentials"),
      expect.stringContaining("Bad credentials"),
    ]);
    expect(events.filter((e) => e.type === "action")).toHaveLength(4);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 48. Usefulness: verifies a finish that breaks more than one rule is refused
// for every rule it breaks, in the order the interactive `role finish` checks
// them. One corrective turn is all the run grants, so a prompt that names only
// the first condition spends it on a condition the next refusal names instead
// (#293).
test("a finish that breaks several rules is refused for all of them", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const calls = [];

    const result = await runLoop({
      task: "PR work: address issue 48 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh: prGateGh(OTHER_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    // The marker, the missing reviewer report, and the PR head that is not the
    // reviewed commit, since no reviewer turn ran at all.
    expect(result.reason).toContain("unresolvedCompare cannot be combined with --require-ci");
    expect(result.reason).toContain("no reviewer report on the state");
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
    expect(result.reason.indexOf("unresolvedCompare cannot")).toBeLessThan(
      result.reason.indexOf("no reviewer report"),
    );
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 48a. Usefulness: verifies the headless loop runs the `--require-ci` gate after
// an earlier refusal, so one refused finish names every broken condition. Only
// the declared-PR gate condition skips the gate. Each case other than the
// review-only case holds a reviewed state and a PR head that differs from it, so
// the gate refusal and a gate read both show that the gate ran. The review-only
// case holds no reviewed state, and its gate refuses with the no-reviewed-state
// reason (#366).
test("--require-ci still runs the gate after the unresolvedCompare refusal", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const finish = JSON.stringify({
      action: "finish",
      summary: SUMMARY,
      unresolvedCompare: true,
    });

    const result = await runLoop({
      task: "PR work: address issue 366 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: prGateGh(OTHER_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          finish,
          finish,
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("unresolvedCompare cannot be combined with --require-ci");
    expect(result.reason).toContain("the PR head differs from the reviewed commit");
    expect(gateReads(calls).length).toBeGreaterThan(0);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

test("--require-ci still runs the gate after the review-only reviewer-turn refusal", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const finish = JSON.stringify({ action: "finish", summary: SUMMARY });

    const result = await runLoop({
      task: "Review PR 42 only.",
      cwd: repo,
      maxSteps: 5,
      mode: "review-only",
      requireCi: 42,
      gh: prGateGh(OTHER_HEAD),
      roles: gateRoles(),
      agents: { orch: scripted([finish, finish]), work: scripted([]), rev: scripted([]) },
    });

    // No reviewer turn ran, so the gate itself refuses with its no-reviewed-state reason.
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("no reviewer turn has run");
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

test("--require-ci still runs the gate after the --require-accept refusal", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const finish = JSON.stringify({ action: "finish", summary: SUMMARY });

    const result = await runLoop({
      task: "PR work: address issue 366 through PR 42.",
      cwd: repo,
      maxSteps: 6,
      requireAccept: true,
      requireCi: 42,
      gh: prGateGh(OTHER_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          finish,
          finish,
        ]),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_REJECT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("no reviewer accept with a Checks line");
    expect(result.reason).toContain("the PR head differs from the reviewed commit");
    expect(gateReads(calls).length).toBeGreaterThan(0);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 49. Usefulness: verifies an orchestrator that follows the refusal prompt
// reaches exit 0, for the marker refusal and for the gate refusal. The prompt is
// the run's only recovery, and a second refused finish with no child turn in
// between ends the run, so wording that omits the child turn is a dead end even
// when the wording is accurate (#293).
test("following a --require-ci refusal prompt reaches exit 0", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const markerSummary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    // The orchestrator does exactly what the prompt says for each refusal: read
    // the conditions, dispatch the child turn the prompt names, then finish. A
    // prompt that said only "finish again" would end this run on exit 1, since a
    // second refused finish with no child turn in between ends the run (#293).
    const markerOrch = scripted([
      JSON.stringify({ action: "finish", summary: markerSummary, unresolvedCompare: true }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const markerResult = await runLoop({
      task: "PR work: address issue 49 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh: prGateGh(CLEAN_REPO_HEAD),
      roles: gateRoles(),
      agents: { orch: markerOrch, work: scripted([]), rev: scripted([REVIEW_ACCEPT]) },
    });

    const markerPrompt = markerOrch.recorded[1].prompt;
    expect(markerPrompt).toContain("remove unresolvedCompare from the finish");
    expect(markerPrompt).toContain("Dispatch the reviewer");
    expect(markerPrompt).toContain("costs a step");
    expect(markerResult.exitCode).toBe(0);
    expect(markerResult.summary).toEqual(SUMMARY);

    // The gate refusal: the prompt names a worker turn, and the reviewer turn
    // after it re-establishes the reviewed state the gate reads.
    const head = CLEAN_REPO_HEAD;
    const gateWork = scripted(["worker changed", "worker pushed the change"]);
    const gateOrch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_worker", prompt: "push the change" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gateResult = await runLoop({
      task: "PR work: address issue 49 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      // The PR head matches the reviewed commit only after the second worker
      // turn, which is the recovery the prompt named. The reviewer's status read
      // calls gh too, so the answer follows the worker turns, not the call count.
      gh: (args, cwd, options) =>
        prGateGh(gateWork.recorded.length < 2 ? OTHER_HEAD : head)(args, cwd, options),
      roles: gateRoles(),
      agents: {
        orch: gateOrch,
        work: gateWork,
        rev: scripted([REVIEW_ACCEPT, REVIEW_ACCEPT]),
      },
    });

    const gatePrompt = gateOrch.recorded[3].prompt;
    expect(gatePrompt).toContain("the PR head differs from the reviewed commit");
    expect(gatePrompt).toContain("Dispatch the reviewer");
    expect(gatePrompt).toContain("a worker turn resets the reviewed state to none");
    expect(gateResult.exitCode).toBe(0);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 50. Usefulness: verifies a finish refused for the marker alone recovers with a
// re-finish and no child turn. Every other condition already passed, so a prompt
// that insists on a child turn would spend a step and start a review cycle the
// run did not need (#293).
test("a marker-only refusal is cleared by a re-finish with no child turn", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const markerSummary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const orch = scripted([
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: markerSummary, unresolvedCompare: true }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const work = scripted([]);
    const rev = scripted([REVIEW_ACCEPT]);

    const result = await runLoop({
      task: "PR work: address issue 50 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh: prGateGh(head),
      roles: gateRoles(),
      agents: { orch, work, rev },
    });

    expect(result.exitCode).toBe(0);
    // The prompt says so, and the run spends no step on it: one reviewer turn in
    // total, which is the one the first finish needed for the completion rule.
    expect(orch.recorded[2].prompt).toContain("needs no child turn");
    expect(orch.recorded[2].prompt).not.toContain("costs a step");
    // The edge case the ending names: nothing cleared the prior-refusal flag, so
    // a re-finish that is refused again ends the run.
    expect(orch.recorded[2].prompt).toContain("If the re-finish is refused again anyway");
    expect(work.recorded).toHaveLength(0);
    expect(rev.recorded).toHaveLength(1);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 51. Usefulness: verifies the prompt for a pending required check names the
// reviewer turn that clears it. A worker turn alone clears neither the reviewed
// state nor the completion rule, so a prompt naming only the worker turn spends
// an extra refusal and extra steps (#293).
test("a pending-check refusal is cleared by the reviewer turn its prompt names", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const check = { status: "in_progress" };
    const gateOrch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      // What the prompt names: a reviewer turn, not a worker turn.
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gh = async (args) => {
      if (isPagedRead(args, "/check-runs")) {
        const answer = await prGateGh(head)(args);
        if (check.status === "completed") {
          return answer;
        }
        return {
          status: 0,
          stdout: pageStdout({
            check_runs: [
              {
                name: "ci (ubuntu-latest)",
                status: check.status,
                conclusion: null,
                started_at: "2026-01-01T00:00:00Z",
              },
            ],
          }),
          stderr: "",
        };
      }
      return prGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 51 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh,
      roles: gateRoles(),
      agents: {
        orch: gateOrch,
        work: scripted(["worker changed"]),
        // The check reports while the corrective reviewer turn runs, so the
        // finish after it passes on the same code with no further worker turn.
        rev: scripted([
          REVIEW_ACCEPT,
          () => {
            check.status = "completed";
            return REVIEW_ACCEPT;
          },
        ]),
      },
    });

    const prompt = gateOrch.recorded[3].prompt;
    expect(prompt).toContain('required check "ci (ubuntu-latest)" is pending');
    expect(prompt).toContain("Dispatch the reviewer to re-read the state");
    expect(result.exitCode).toBe(0);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 59. Usefulness: verifies the `gh`-failure prompt does not tell the
// orchestrator it is out of attempts, and names a reviewer turn as the retry.
// Any child turn clears the prior-refusal flag, so the run keeps its corrective
// turn while step budget remains (#293).
test("a gh-failure refusal does not claim the run is out of attempts", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const failing = { on: true };
    const orch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gh = async (args) => {
      if (failing.on && equalsArgs(args, prViewArgs(42))) {
        return { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
      }
      return prGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 52 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh,
      roles: gateRoles(),
      agents: {
        orch,
        work: scripted(["worker changed"]),
        // The credential recovers while the corrective reviewer turn runs. The
        // second `gh` failure is not the run's last, because the corrective turn
        // cleared the prior-refusal flag.
        rev: scripted([
          REVIEW_ACCEPT,
          () => {
            failing.on = false;
            return REVIEW_ACCEPT;
          },
        ]),
      },
    });

    const prompt = orch.recorded[3].prompt;
    expect(prompt).toContain("the PR gate could not be evaluated");
    expect(prompt).toContain("The only retry you can make is a reviewer turn");
    expect(prompt).toContain("a worker turn resets that state to none");
    expect(prompt).not.toContain("one attempt left");
    expect(result.exitCode).toBe(0);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
