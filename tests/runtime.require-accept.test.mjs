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

import { runLoop } from "../src/runtime.mjs";
import { cleanRepoGit, createCleanRepoDir, removePath, scripted } from "./runtime-helpers.mjs";
import { gateRoles, REVIEW_ACCEPT, REVIEW_REJECT, SUMMARY } from "./gh-doubles.mjs";

// 29. Usefulness: verifies --require-accept refuses a finish with no later
// reviewer accept, then allows the finish once a reviewer accepts that state
// (issue #234).
test("--require-accept refuses a finish until a reviewer accepts", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_ACCEPT]);

    const result = await runLoop({
      task: "Task 29",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: reviewerAdapter,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 30. Usefulness: verifies the gate treats a reviewer reject as not accepted, and
// a later reviewer accept on the same state allows the finish (issue #234).
test("--require-accept treats a reviewer reject as not accepted", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "re-review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_REJECT, REVIEW_ACCEPT]);

    const result = await runLoop({
      task: "Task 30",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: reviewerAdapter,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(2);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 31. Usefulness: verifies the gate maps a run with no worker turn to review-only:
// the finish follows the report whatever the verdict (issue #234).
test("--require-accept allows a review-only finish with no worker turn", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 31",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([REVIEW_REJECT]) },
    });

    expect(result.exitCode).toBe(0);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 32. Usefulness: verifies a repeated finish that still lacks a reviewer accept
// ends the run instead of spinning (issue #234).
test("--require-accept aborts a repeated refused finish", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 32",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("reviewer accept");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 33. Usefulness: verifies --require-accept refuses a finish with no child turn
// and allows a review-only finish once a reviewer report exists (issue #234).
test("--require-accept requires a reviewer report when no worker turn ran", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_REJECT]);

    const result = await runLoop({
      task: "Task 33",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 34. Usefulness: verifies a reviewer reply with no Verdict line does not satisfy
// the gate: process success never implies acceptance (issue #234).
test("--require-accept does not accept a reviewer reply without a verdict", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 34",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted(["reviewed, but the verdict line is missing"]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("reviewer accept");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 35. Usefulness: verifies a later reviewer failure does not clear an earlier
// reviewer report when no worker turn ran, so "at least one reviewer report"
// holds (issue #234).
test("--require-accept keeps an earlier reviewer report after a later failure", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "first review" }),
      JSON.stringify({ action: "run_reviewer", prompt: "second review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([
      REVIEW_REJECT,
      () => {
        throw new Error("reviewer crashed");
      },
    ]);

    const result = await runLoop({
      task: "Task 35",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(2);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 36. Usefulness: verifies a finish refused when the step budget is already used
// ends on the refusal path with exit 1, records the refusal event, and never
// attempts the corrective child dispatch that the used budget cannot run
// (issues #248, #247).
test("--require-accept returns the refusal exit 1 when no step budget remains", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
    ];
    const reviewerAdapter = scripted([]);
    const events = [];

    const result = await runLoop({
      task: "Task 36",
      cwd: repo,
      maxSteps: 1,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: reviewerAdapter,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("reviewer accept");
    expect(reviewerAdapter.recorded.length).toBe(0);
    const refusals = events.filter((e) => e.type === "refusal");
    expect(refusals).toEqual([
      {
        type: "refusal",
        reason:
          "no reviewer accept with a Checks line on the latest changed state after a worker turn",
        stepsUsed: 1,
      },
    ]);
    const finishActionIndex = events.findIndex(
      (e) => e.type === "action" && e.action.action === "finish",
    );
    expect(events[finishActionIndex + 1].type).toBe("refusal");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 37. Usefulness: verifies each refused finish under --require-accept is recorded
// as a refusal event that follows the refused action, carries the reason and the
// step count, and appears once per refusal (issue #247).
test("--require-accept records a refused finish as a refusal event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];

    const result = await runLoop({
      task: "Task 37",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    const refusals = events.filter((e) => e.type === "refusal");
    expect(refusals).toEqual([
      {
        type: "refusal",
        reason:
          "no reviewer accept with a Checks line on the latest changed state after a worker turn",
        stepsUsed: 1,
      },
      {
        type: "refusal",
        reason:
          "no reviewer accept with a Checks line on the latest changed state after a worker turn",
        stepsUsed: 1,
      },
    ]);
    const finishActionIndexes = events
      .map((event, index) =>
        event.type === "action" && event.action.action === "finish" ? index : -1,
      )
      .filter((index) => index !== -1);
    expect(finishActionIndexes).toHaveLength(2);
    for (const index of finishActionIndexes) {
      expect(events[index + 1].type).toBe("refusal");
    }
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 38. Usefulness: verifies the gate treats a reviewer accept with no Checks line
// as not accepted, matching the parent prompt rule (issue #217, issue #218).
test("--require-accept treats an accept without a Checks line as not accepted", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const acceptNoChecks = [
      "Conclusion: the state passes.",
      "Why: changes match the task.",
      "Blockers: none.",
      "Verdict: accept",
    ].join("\n");
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 38",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([acceptNoChecks]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("Checks");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 39. Usefulness: verifies a finish that reports an unresolved PR-head compare
// records a distinct `unresolved-compare` event and still exits 0 with the
// summary, so the recorded finish no longer reads as a verified finish (#266).
test("finish with unresolvedCompare records an unresolved-compare event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    };
    const orchReplies = [JSON.stringify({ action: "finish", summary, unresolvedCompare: true })];
    const events = [];

    const result = await runLoop({
      task: "Task 39",
      cwd: repo,
      maxSteps: 5,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(summary);
    // The headless CLI maps this flag to its own exit code, so the loop must
    // report it on the result and not only as an event (#279).
    expect(result.unresolvedCompare).toBe(true);
    const unresolved = events.filter((e) => e.type === "unresolved-compare");
    expect(unresolved).toEqual([{ type: "unresolved-compare", stepsUsed: 0 }]);
    const finishActionIndex = events.findIndex(
      (e) => e.type === "action" && e.action.action === "finish",
    );
    expect(events[finishActionIndex + 1].type).toBe("unresolved-compare");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 40. Usefulness: pins the accepted gap for #286. A PR-work finish that records
// the unresolved compare under `notDone` and `open` and omits the marker leaves
// no machine signal: exit 0, the summary, and no unresolved-compare event, which
// a consumer cannot tell from a verified finish. The free text is the only trace,
// so this pins the limit as deliberate instead of letting it drift unnoticed.
test("a PR finish that omits unresolvedCompare reads as verified", async () => {
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
    const orchReplies = [JSON.stringify({ action: "finish", summary })];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 40 through PR 40.",
      cwd: repo,
      maxSteps: 5,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(summary);
    expect(result.unresolvedCompare).toBe(false);
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 41. Usefulness: verifies a finish that carries the marker emits no
// unresolved-compare event while the --require-accept gate refuses it, and
// emits exactly one once a reviewer accept allows the finish, so the event
// tracks the accepted finish rather than the marker alone (#234, #266).
test("--require-accept emits the marker event only on the accepted finish", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    };
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
    ];
    const events = [];

    const result = await runLoop({
      task: "Task 41",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events.filter((e) => e.type === "refusal")).toHaveLength(1);
    expect(events.filter((e) => e.type === "unresolved-compare")).toEqual([
      { type: "unresolved-compare", stepsUsed: 2 },
    ]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 42. Usefulness: verifies a real review-only finish (a reviewer turn, no
// worker turn) records the event when it carries the marker, so the marker
// path is covered outside the worker-plus-reviewer gate path (#234, #266).
test("review-only finish with the marker records the event", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    };
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
    ];
    const events = [];

    const result = await runLoop({
      task: "Task 42",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([REVIEW_REJECT]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events.filter((e) => e.type === "unresolved-compare")).toEqual([
      { type: "unresolved-compare", stepsUsed: 1 },
    ]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
