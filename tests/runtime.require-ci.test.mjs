import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `cleanRepoGit` in runtime-helpers.mjs); every other test reaches the real `execa`.
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

import { snapshot } from "../src/lib/snapshot.mjs";
import { runLoop } from "../src/runtime.mjs";
import {
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createCleanRepoDir,
  createTempRepo,
  equalsArgs,
  gateRoles,
  isPagedRead,
  noRequiredCheckGh,
  pagedApiArgs,
  pageStdout,
  PASSING_RUN,
  prChecksArgs,
  prGateGh,
  prViewArgs,
  removePath,
  REVIEW_ACCEPT,
  REVIEW_REJECT,
  scripted,
  SUMMARY,
} from "./runtime-helpers.mjs";

const OTHER_HEAD = "2".repeat(40);

// The GitHub state reads the shared `checkCi` gate makes, named by the argument
// that identifies each one. A refused finish must read none of them, so the
// assertion names the gate's own reads rather than subtracting whatever else the
// run happens to call. The runtime status read makes the same reads for the
// reviewed commit (issue #349).
// Matched as a prefix of the call, because the gate passes extra arguments to
// several of them (`api repos/{slug}/...` and the field list on its PR view).
const GATE_READ_PREFIXES = [
  "repo view",
  "rules/branches",
  "branches/main/protection",
  "check-runs",
  "/status",
  "mergeStateStatus",
];

// Matched whole, so a longer `pr checks` call is not read as the required-names read.
const GATE_READ_EXACT = ["pr checks 42 --required --json name"];

// The gate's own GitHub state reads, selected by endpoint so the assertion does
// not depend on which other calls the run made.
const gateReads = (calls) =>
  calls.filter(
    (key) =>
      GATE_READ_PREFIXES.some((endpoint) => key.includes(endpoint)) ||
      GATE_READ_EXACT.includes(key),
  );

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

// 45. Usefulness: verifies a worker turn after the reviewer turn clears the
// reviewed state the gate reads, so a commit made after the review cannot pass
// against the older reviewed head, matching the interactive gate (#293).
test("--require-ci refuses a finish after a worker turn follows the review", async () => {
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
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
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

// 52. Usefulness: verifies a run that declares a PR refuses a finish with no
// `--require-ci` gate, so a declared PR run cannot finish through a field the
// parent set. A run without the declaration keeps the marker-only gap (#302).
test("a run that declares a PR refuses a finish with no --require-ci gate", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 52 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("declares PR 42");
    expect(result.reason).toContain("--require-ci 42");
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 53. Usefulness: verifies the same declaration refuses a finish that records the
// unresolved compare, because the gate is what the declaration requires. A
// recorded marker on a declared PR run would read as an accepted gap, so the
// finish is refused instead (#302).
test("a run that declares a PR refuses a finish that carries unresolvedCompare", async () => {
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
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 53 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
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
    expect(result.reason).toContain("declares PR 42");
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 54. Usefulness: verifies the marker refusal fires on a declared PR run with no
// gate, and that one refusal names both conditions in the existing order. The
// finish breaks two rules and the run grants one corrective turn, so a refusal
// that names one of them spends it on the condition the next refusal names
// instead (#302).
test("a declared PR with no gate reports the marker and the gate in one refusal", async () => {
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

    const result = await runLoop({
      task: "PR work: address issue 54 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
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

    const marker =
      "unresolvedCompare cannot be combined with a run that declares PR 42 (--pr): the run must end through the --require-ci 42 gate, which resolves that PR head, so that compare is not unresolved";
    const gate =
      "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(`Finish refused: ${marker}; ${gate}.`);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 55. Usefulness: verifies the declared-PR refusal is reported with the completion
// rule in the existing order, so one refusal names every condition the finish
// breaks (#302).
test("the missing-gate refusal is reported with the other refusals in order", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const result = await runLoop({
      task: "PR work: address issue 55 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    const gate =
      "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(`Finish refused: no reviewer report on the state; ${gate}.`);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 55. Usefulness: verifies a run that declares a PR and also carries the gate
// behaves exactly as a gated run does today, so the declaration adds no second
// enforcement path and no new refusal (#302).
test("a declared PR with a matching gate runs the gate and nothing else", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const result = await runLoop({
      task: "PR work: address issue 55 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(head),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a headless declared run finishes on a base branch with no
// required check and emits a `no-required-checks` event, so the recorded run says
// it verified no check instead of reading as a pass on a checked branch (issue
// #336).
//
// `git` is answered from memory, not spawned. Run alone, the test started 34 `git`
// processes: a repo and the snapshots around its turns. The same cost made the
// finish tests in role.finish-abort.test.mjs time out under load (issue #385). This
// test was not observed to fail (issue #399). The behavior under test is the finish
// gate over the `gh` answers, and the snapshot code has its own tests on real repos.
test("a declared PR finishes on a base branch with no required check", async () => {
  const cwd = tmpdir();
  gitDouble.answer = cleanRepoGit;
  try {
    const events = [];
    const calls = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The init copy of local files is out of scope here, and its `git` calls
      // have no answer in the double.
      copyLocalFiles: false,
      gh: noRequiredCheckGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
    // The absence rests on the two fixtures this double names, so a route that
    // stops matching fails here instead of passing on a fallback.
    expect(calls).toContain(pagedApiArgs("repos/owner/repo/rules/branches/main").join(" "));
    expect(calls).toContain(prChecksArgs(42).join(" "));
    expect(events.filter((e) => e.type === "no-required-checks")).toHaveLength(1);
    // A finish on a checked branch records no such event, so the event means the
    // base branch had no required check rather than that the gate ran.
    expect(events.filter((e) => e.type === "refusal")).toEqual([]);
  } finally {
    gitDouble.answer = null;
  }
});

// Usefulness: verifies a refused finish emits no absence event, so the event
// cannot report that a run verified no check when the run did not finish at all
// (issue #336 review).
test("a refused finish emits no absence event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const events = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The gate passes on the absence, and the completion rule still refuses the
      // same finish, so the finish is not accepted.
      gh: noRequiredCheckGh("1111111111111111111111111111111111111111"),
      roles: gateRoles(),
      requireAccept: true,
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(events.filter((e) => e.type === "no-required-checks")).toEqual([]);
    expect(events.filter((e) => e.type === "refusal")).not.toEqual([]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a headless gated run on a base branch that does require a
// check emits no absence event, so the field on the event cannot read as a
// statement about every gated run (issue #336).
test("a gated run on a checked base branch emits no absence event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const events = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(CLEAN_REPO_HEAD),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events.filter((e) => e.type === "no-required-checks")).toEqual([]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 56. Usefulness: verifies a run that declares PR 42 and gates a different PR is
// refused, so the gate cannot read one pull request while the run declares
// another (#302).
test("a run that declares a PR refuses a gate for a different PR", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];

    const result = await runLoop({
      task: "PR work: address issue 56 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 7,
      gh: prGateGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("declares PR 42");
    // The gate for PR 7 is never read. The reviewer status read names the declared
    // PR 42 and makes the gate's reads for it (#320, #349), so the assertion is that
    // no call names PR 7.
    expect(calls.filter((key) => /\b7\b/.test(key))).toEqual([]);
    expect(calls.some((key) => key.includes("pr view 42"))).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 57. Usefulness: pins the exact refusal a declared run gives when the gate names
// another PR, and that the gate for that other PR is never read. A prompt or a
// consumer that reads the reason as a gate verdict would otherwise expect a gate
// result the runtime never produced (#302).
test("a mismatched-gate refusal names the declaration and reads no gate", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const result = await runLoop({
      task: "PR work: address issue 57 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      // No reviewer turn here, so the status read never runs and no call is made.
      pr: 42,
      requireCi: 7,
      gh: prGateGh(CLEAN_REPO_HEAD, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe(
      "Finish refused: this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run gates PR 7 instead.",
    );
    // Asserted on the gate's own endpoints, so the claim "a refused finish reads
    // no GitHub state" is the assertion and not a side effect of which other
    // calls the run happens to make (#320 review). The five reads are the source
    // check of the declared PR 42 at start (#1092); the refused finish adds none.
    expect(gateReads(calls)).toHaveLength(5);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 58. Usefulness: pins the exact refusal for a declared run whose gate matches and
// whose finish breaks the marker condition and a gate condition together. The gate
// has its own conditions, so the marker is not the only broken one, and a prompt
// that claimed otherwise would send the run after the wrong fix (#302).
test("a matching-gate refusal names the marker and the gate condition together", async () => {
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

    const result = await runLoop({
      task: "PR work: address issue 58 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // No reviewer turn ran, so the gate has no reviewed state to read.
      gh: prGateGh(CLEAN_REPO_HEAD),
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
    expect(result.reason).toBe(
      "Finish refused: unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved; the latest reviewer turn has no reviewed state.",
    );
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 57. Usefulness: verifies the missing-gate prompt tells the orchestrator what
// the run needs, because no turn in the run can add a flag. A prompt that only
// said "finish again" would end the run on exit 1 with no recovery named (#302).
test("the missing-gate refusal prompt names the gate the run needs", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orch = scripted([
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "abort", reason: "no gate" }),
    ]);

    await runLoop({
      task: "PR work: address issue 57 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: { orch, work: scripted([]), rev: scripted([]) },
    });

    const prompt = orch.recorded[1].prompt;
    expect(prompt).toContain("--require-ci 42");
    expect(prompt).toContain("abort");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 58. Usefulness: verifies the marked-finish prompt names a missing gate only when
// the gate is missing. A declared run whose gate matches loses the gate condition
// once the marker is removed, so a prompt that names a missing gate there tells
// the orchestrator to abort a run it can finish. A declared run with no gate keeps
// both conditions and the gate is named (#302).
test("the marked-finish prompt names a missing gate only when the gate is missing", async () => {
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
    const markedFinish = JSON.stringify({
      action: "finish",
      summary: markerSummary,
      unresolvedCompare: true,
    });

    // The gate matches the declaration, so removing the marker is the whole
    // recovery and the run reaches exit 0. The reviewer turn comes first, so the
    // gate has the reviewed state it reads and the marker is the only refusal.
    const withGate = scripted([
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      markedFinish,
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const withGateResult = await runLoop({
      task: "PR work: address issue 58 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(CLEAN_REPO_HEAD),
      roles: gateRoles(),
      agents: { orch: withGate, work: scripted([]), rev: scripted([REVIEW_ACCEPT]) },
    });
    const withGatePrompt = withGate.recorded[2].prompt;
    expect(withGatePrompt).toContain("remove unresolvedCompare from the finish");
    expect(withGatePrompt).toContain("needs no child turn");
    expect(withGatePrompt).not.toContain("missing --require-ci 42 gate");
    expect(withGateResult.exitCode).toBe(0);

    // The gate is absent, so removing the marker leaves the missing gate, and the
    // prompt must name it rather than send the orchestrator back to finish.
    const noGate = scripted([markedFinish, JSON.stringify({ action: "abort", reason: "no gate" })]);
    await runLoop({
      task: "PR work: address issue 58 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      roles: gateRoles(),
      agents: { orch: noGate, work: scripted([]), rev: scripted([]) },
    });
    const noGatePrompt = noGate.recorded[1].prompt;
    expect(noGatePrompt).toContain("remove unresolvedCompare from the finish");
    expect(noGatePrompt).toContain("missing --require-ci 42 gate");
    expect(noGatePrompt).toContain("abort");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 58. Usefulness: verifies a run that declares no PR keeps the marker-only
// behavior it has today, so the new declaration changes nothing for an ungated
// run that is not PR work (#302).
test("a run that declares no PR still records a marked finish", async () => {
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
    const events = [];

    const result = await runLoop({
      task: "Task 58",
      cwd: repo,
      maxSteps: 5,
      roles: gateRoles(),
      agents: {
        orch: scripted([JSON.stringify({ action: "finish", summary, unresolvedCompare: true })]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.unresolvedCompare).toBe(true);
    expect(events.some((e) => e.type === "refusal")).toBe(false);
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

// Answers the runtime read of the required checks for PR 42 and the finish gate
// from the shared gate fixture, with `runs` as the check runs of every commit.
const reviewerReadGh = (headRefOid, runs) => prGateGh(headRefOid, [], runs);

// Usefulness: verifies a run that declares a PR supplies the required-check
// status the runtime read to the reviewer turn and records that read in the
// result, so a reviewer whose turn cannot reach the network still sees the
// failing check and the parent can compare it with the reviewer Checks line
// (issue #320).
test("a declared PR supplies the runtime-read required-check status to the reviewer", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The check fails for the status read before the turn and passes for the finish
      // gate after it, so the run can finish while the reviewer holds the failure.
      gh: (args, cwd, options) =>
        reviewerReadGh(head, [
          rev.recorded.length === 0 ? { ...PASSING_RUN, conclusion: "failure" } : PASSING_RUN,
        ])(args, cwd, options),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worker pushed the change"]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(rev.recorded[0].prompt).toContain("ci (ubuntu-latest)");
    expect(rev.recorded[0].prompt).toContain("42");
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.prChecks).toMatchObject({ pr: 42, status: "failing" });
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a headless run that takes only `--require-ci <pr>` supplies
// the status for that PR to the reviewer, because a sandboxed reviewer cannot make
// the read itself and the PR number is already a run input (issue #350).
test("a gate-only run supplies the required-check status for the gated PR", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "Review the change on PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: (args, cwd, options) =>
        reviewerReadGh(head, [
          rev.recorded.length === 0 ? { ...PASSING_RUN, conclusion: "failure" } : PASSING_RUN,
        ])(args, cwd, options),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(rev.recorded[0].prompt).toContain("ci (ubuntu-latest)");
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.prChecks).toMatchObject({ pr: 42, status: "failing" });
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the supplied status is not a pass for a reviewed work tree
// that is not clean, because `--require-ci` refuses that tree, so the runtime must
// hand the status read the clean flag of the reviewed snapshot (issue #349).
test("a declared PR supplies no pass for a reviewed work tree that is not clean", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    await writeFile(join(repo, "uncommitted.txt"), "x");
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    await runLoop({
      task: "PR work: address issue 349 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: reviewerReadGh(head, [PASSING_RUN]),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.reviewed.clean).toBe(false);
    expect(reviewed.result.prChecks.status).not.toBe("pass");
    expect(events.filter((e) => e.type === "refusal").map((e) => e.reason)).toContain(
      "the reviewed work tree is not clean",
    );
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a run that declares no PR reads no status and records
// none, so the reviewer prompt never carries a read the runtime did not make
// (issue #320).
test("a run with no PR input reads no required-check status", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "Task without a pull request.",
      cwd: repo,
      maxSteps: 5,
      gh: async (args) => {
        calls.push(args.join(" "));
        return { status: 0, stdout: "[]", stderr: "" };
      },
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(rev.recorded[0].prompt).not.toMatch(/runtime read/);
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result.prChecks).toBeUndefined();
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a hung required-check read does not fail or halt the
// dispatch, because the status is supplied evidence and the reviewer keeps its
// own read, so a stalled `gh` must yield an unresolved status and a completed
// reviewer turn (issue #320 review).
test("a hung required-check read yields an unresolved status and a completed turn", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    const rev = scripted([REVIEW_ACCEPT]);
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      timeout: 30,
      readTimeoutMs: 25,
      gh: (args, cwd, options) => {
        // Only the ruleset read stalls: the head resolves, so the read reaches the
        // call a hung `gh` would hold open.
        if (
          rev.recorded.length === 0 &&
          equalsArgs(args, pagedApiArgs("repos/owner/repo/rules/branches/main"))
        ) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("read timed out")));
          });
        }
        return prGateGh(head)(args, cwd, options);
      },
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev,
      },
      onEvent: (event) => events.push(event),
    });

    // The reviewer turn completed and the run finished: a stalled read neither
    // failed the turn nor ended the run.
    expect(result.exitCode).toBe(0);
    expect(rev.recorded).toHaveLength(1);
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
    expect(reviewed.result).toMatchObject({ status: "ok" });
    expect(reviewed.result.prChecks).toMatchObject({ status: "unresolved" });
    // The unresolved status reaches the reviewer prompt, so the reviewer reads
    // the checks itself rather than reporting a pass it did not see.
    expect(rev.recorded[0].prompt).toMatch(/unresolved/i);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the gate-endpoint list the refusal assertions use covers
// every endpoint the finish gate actually reads, because a list that omits one
// lets a refused finish pass a GitHub read it should never make while the test
// still reports no reads (issue #320 review, second round).
test("the refusal assertion covers every endpoint the finish gate reads", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const head = CLEAN_REPO_HEAD;
    // A run whose gate matches, so the gate runs and every endpoint it reads is
    // recorded. That recorded list is what a refused finish must not contain.
    const calls = [];
    await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: prGateGh(head, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_ACCEPT]),
      },
    });

    // Every call the run made is covered by the list the refusal tests assert on,
    // so a refused finish cannot slip a gate read past them.
    const uncovered = calls.filter((key) => gateReads([key]).length === 0);
    expect(uncovered).toEqual([]);
    // The gate really does read several endpoints, so the list is not vacuous.
    expect(gateReads(calls).length).toBeGreaterThan(1);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the headless wait bound follows the turn --timeout the run
// was started with, so a wait the orchestrator runs ends before the turn does and
// the run cannot end on exit 1 with no action (issue #348).
test("the orchestrator prompt states a wait bound below the run's turn timeout", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orch = scripted([JSON.stringify({ action: "abort", reason: "stop" })]);
    await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      timeout: 60,
      requireCi: 42,
      gh: prGateGh("0".repeat(40)),
      roles: {
        orchestrator: { kind: "claude", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { claude: orch, work: scripted([]), rev: scripted([]) },
    });

    const prompt = orch.recorded[0].prompt;
    expect(prompt).toContain(`--cwd "${resolve(repo).replaceAll("\\", "/")}" --pr 42 --timeout 25`);
    expect(prompt).not.toContain("--watch");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a run whose turn --timeout is too short for any bounded
// wait tells the orchestrator not to wait, instead of a wait the turn cannot
// hold (issue #348).
test("the orchestrator prompt names no wait when the turn timeout is too short", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orch = scripted([JSON.stringify({ action: "abort", reason: "stop" })]);
    await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      timeout: 8,
      requireCi: 42,
      gh: prGateGh("0".repeat(40)),
      roles: {
        orchestrator: { kind: "claude", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { claude: orch, work: scripted([]), rev: scripted([]) },
    });

    const prompt = orch.recorded[0].prompt;
    expect(prompt).not.toContain("--pr 42 --timeout");
    expect(prompt).toMatch(/cannot wait for the required checks/i);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
