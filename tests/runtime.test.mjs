import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { ExecError } from "../src/lib/exec.mjs";
import { MutationError, reviewedState, snapshot } from "../src/lib/snapshot.mjs";
import { runChild } from "../src/child-turn.mjs";
import { runLoop } from "../src/runtime.mjs";
import { setVerbose } from "../src/lib/log.mjs";
import {
  cleanRepoGit,
  createTempRepo,
  gitAbortingPostTurn,
  removePath,
  scripted,
} from "./runtime-helpers.mjs";

// 1. Usefulness: verifies orchestrator dispatches worker first.
test("orchestrator dispatches worker first", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerReplies = ["worker did task"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted(workerReplies);
    const reviewerAdapter = scripted([]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(1);
    expect(workerAdapter.recorded[0].prompt).toContain("start work");
    expect(reviewerAdapter.recorded.length).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: #826. The headless worker, like a role worker, gets the run task once, on its first
// turn, so the two paths keep one prompt contract.
test("a headless worker sees the run task on its first turn only", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_worker", prompt: "keep going" }),
      finish,
    ]);
    const workerAdapter = scripted(["one", "two"]);

    await runLoop({
      task: "Task 826",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
    });

    const [first, second] = workerAdapter.recorded.map((call) => call.prompt);
    expect(first).toContain("Init task:\nTask 826");
    expect(second).not.toContain("Task 826");
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies requirement "a refused action charges no step and ends no run" (#1034). With
// a budget of one step, a run_worker that holds an unknown key is repaired and the repaired dispatch
// still runs, so the refusal charged nothing.
test("a refused run_worker charges no step and the repaired action runs", async () => {
  const repo = await createTempRepo();
  try {
    const events = [];
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "start work", promt: "typo" }),
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted(["worker did task"]);

    const result = await runLoop({
      task: "Task 1034",
      cwd: repo,
      maxSteps: 1,
      onEvent: (event) => events.push(event),
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(1);
    expect(events.filter((event) => event.type === "action")[0].stepsUsed).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 2. Usefulness: verifies orchestrator dispatches reviewer first.
test("orchestrator dispatches reviewer first", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "inspect repo" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerReplies = ["reviewer inspected"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted([]);
    const reviewerAdapter = scripted(reviewerReplies);

    const result = await runLoop({
      task: "Task 2",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
    expect(reviewerAdapter.recorded[0].prompt).toContain("inspect repo");
    expect(workerAdapter.recorded.length).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 2b. Usefulness: verifies the headless reviewer result prompt carries the
// runtime reviewed state, so the headless parent sees the same identity the
// interactive envelope records (issue #217).
test("headless reviewer result carries the runtime reviewed state", async () => {
  const repo = await createTempRepo();
  try {
    const expected = reviewedState(await snapshot(repo));
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "inspect repo" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted(["reviewer inspected"]);

    const result = await runLoop({
      task: "Task 2b",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    const resultPromptText = orchAdapter.recorded[1].prompt;
    expect(resultPromptText).toContain(`"head": "${expected.head}"`);
    expect(resultPromptText).toContain(`"digest": "${expected.digest}"`);
    expect(resultPromptText).toContain('"clean": true');
    expect(resultPromptText).toContain('"exact": true');
  } finally {
    await removePath(repo);
  }
});

// 3. Usefulness: verifies reviewer findings go back to the worker with verbatim follow-up prompt.
test("reviewer findings go back to worker", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "first review" }),
      JSON.stringify({ action: "run_worker", prompt: "fix issues" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerReplies = ["found issue 1"];
    const workerReplies = ["fixed issue 1"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted(workerReplies);
    const reviewerAdapter = scripted(reviewerReplies);

    const result = await runLoop({
      task: "Task 3",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).toContain("found issue 1");
    // Worker first turn wraps instructions
    expect(workerAdapter.recorded[0].prompt).toContain("fix issues");
  } finally {
    await removePath(repo);
  }
});

// 4. Usefulness: verifies reviewer reassesses without a worker turn (two run_reviewer).
test("reviewer reassesses without worker turn", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "rev 1" }),
      JSON.stringify({ action: "run_reviewer", prompt: "rev 2" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerReplies = ["ok 1", "ok 2"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted([]);
    const reviewerAdapter = scripted(reviewerReplies);

    const result = await runLoop({
      task: "Task 4",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(2);
    expect(workerAdapter.recorded.length).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 5. Usefulness: verifies two consecutive worker turns.
//
// `git` is answered from memory, not spawned: a real repo cost this test the 15 s
// limit on a loaded Windows runner (issue #492). The behavior under test is the
// two worker turns and the verbatim second prompt, not the snapshot code.
test("two consecutive worker turns", async () => {
  const cwd = tmpdir();
  gitDouble.answer = cleanRepoGit;
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work 1" }),
      JSON.stringify({ action: "run_worker", prompt: "work 2" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerReplies = ["part 1 done", "part 2 done"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted(workerReplies);
    const reviewerAdapter = scripted([]);

    const result = await runLoop({
      task: "Task 5",
      cwd,
      // The init copy of local files has no `git` answers in the double.
      copyLocalFiles: false,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(2);
    // On second turn, the prompt is the task text plus the PR body rule, with no preamble
    expect(workerAdapter.recorded[1].prompt).toBe(
      "work 2\n\nAfter each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment. The body describes only the committed or published repository state and names no untracked file, local-only change, local probe, or machine-specific path.",
    );
  } finally {
    gitDouble.answer = null;
  }
});

// 6. Usefulness: verifies finish returns exit 0 and summary object.
test("finish returns exit 0 and summary object", async () => {
  const repo = await createTempRepo();
  try {
    const summaryObj = {
      changed: "all",
      verified: "tests",
      deferred: "none",
      notDone: "none",
      open: "none",
    };
    const orchReplies = [JSON.stringify({ action: "finish", summary: summaryObj })];
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 6",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(summaryObj);
  } finally {
    await removePath(repo);
  }
});

// 7. Usefulness: verifies finish after rejecting findings with no worker turn.
test("finish after rejecting finding without worker turn", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({
        action: "finish",
        summary: {
          changed: "none",
          verified: "passed",
          deferred: "none",
          notDone: "none",
          open: "none",
        },
      }),
    ];
    const workerAdapter = scripted([]);
    const reviewerAdapter = scripted(["stale finding"]);

    const result = await runLoop({
      task: "Task 7",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 8. Usefulness: verifies abort returns exit 1 and reason.
test("abort returns exit 1 and reason", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "abort", reason: "spec contradiction" })];
    const result = await runLoop({
      task: "Task 8",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([]) },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("spec contradiction");
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a review-only headless run refuses a run_worker action,
// because that mode dispatches no worker, the same hard guard the interactive
// path applies to --role worker. The check is observable: the run ends on exit 1,
// the emitted events carry the refusal, no worker turn runs, and the
// orchestrator is not asked again (issue #337).
test("a review-only run refuses a run_worker action", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "edit the file" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted(["worker did task"]);
    const events = [];

    const result = await runLoop({
      task: "Review only.",
      cwd: repo,
      maxSteps: 5,
      mode: "review-only",
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    // The refused action is recorded, then the refusal, then the run ends.
    expect(events.map((event) => event.type)).toEqual(["invocation", "action", "refusal"]);
    const refusal = events.find((event) => event.type === "refusal");
    expect(refusal.reason).toContain("mode review-only rejects a run_worker action");
    // No worker turn ran, so no step was charged and the run did not recover by
    // asking the orchestrator again.
    expect(workerAdapter.recorded.length).toBe(0);
    expect(orchAdapter.recorded.length).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a run with no --mode still dispatches the worker, so the
// review-only refusal reaches only the runs that asked for it (issue #337).
test("a run with no mode still dispatches the worker", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "edit the file" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted(["worker did task"]);

    const result = await runLoop({
      task: "Implement.",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a review-only headless run refuses a finish until a
// reviewer turn has completed, the parity the interactive path gets for free
// because its init dispatch is itself the reviewer turn. The check is
// observable: the first finish is refused with the missing report named, the
// refusal prompt tells the orchestrator what to do, and the run then finishes
// once the reviewer has run (issue #337).
test("a review-only run refuses a finish with no reviewer report", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
      JSON.stringify({ action: "run_reviewer", prompt: "inspect the repo" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const reviewerAdapter = scripted([
      "Conclusion: done\nWhy: read the code\nBlockers: none\nVerdict: reject",
    ]);
    const events = [];

    const result = await runLoop({
      task: "Review only.",
      cwd: repo,
      maxSteps: 5,
      mode: "review-only",
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
      onEvent: (event) => events.push(event),
    });

    // The first finish was refused, the reviewer ran, and the second finished.
    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
    expect(events.filter((event) => event.type === "refusal").length).toBe(1);
    // The refusal reached the orchestrator and named the missing report.
    const refusalPrompt = orchAdapter.recorded[1].prompt;
    expect(refusalPrompt).toContain("Finish refused");
    expect(refusalPrompt).toContain("no reviewer turn has run");
    expect(refusalPrompt).toContain("run_reviewer");
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies every orchestrator turn prompt of a headless run carries the
// no-remote-write rule and keeps the wait-checks status read allowed: the repair
// turn, the finish refusal, and the result turn each stand alone, because a
// resumed session can open a new conversation without the initial prompt, which
// the agy fallback does (issue #422).
test("every orchestrator turn prompt carries the remote-write rule", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const orchAdapter = scripted([
      "not json",
      finish,
      JSON.stringify({ action: "run_reviewer", prompt: "inspect the repo" }),
      finish,
    ]);

    const result = await runLoop({
      task: "Review only.",
      cwd: repo,
      maxSteps: 5,
      mode: "review-only",
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: {
        orch: orchAdapter,
        work: scripted([]),
        rev: scripted(["Conclusion: done\nWhy: read\nBlockers: none\nVerdict: accept"]),
      },
    });

    expect(result.exitCode).toBe(0);
    // Initial, repair, refusal, and result prompts.
    const prompts = orchAdapter.recorded.map((call) => call.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain("validation error");
    expect(prompts[2]).toContain("Finish refused");
    expect(prompts[3]).toContain("Role execution result");
    for (const prompt of prompts) {
      expect(prompt).toContain("You must NOT write to GitHub or any remote");
      expect(prompt).toContain("agent-loop role wait-checks stays allowed");
    }
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the reviewer-report refusal ends a review-only run that
// keeps finishing without one, by the same repeated-refusal rule every other
// finish gate uses: a second refusal with no child turn in between ends the run
// on exit 1 (issue #337).
test("a review-only run ends on a repeated finish with no reviewer report", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const orchAdapter = scripted([finish, finish]);
    const events = [];

    const result = await runLoop({
      task: "Review only.",
      cwd: repo,
      maxSteps: 5,
      mode: "review-only",
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    // No reviewer turn ran, so the second refusal had no child turn to clear the
    // prior-refusal flag and the run ended on exit 1.
    expect(result.exitCode).toBe(1);
    expect(events.filter((event) => event.type === "refusal").length).toBe(2);
    expect(orchAdapter.recorded.length).toBe(2);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the reviewer-report refusal reaches only a review-only
// run, so a run with no --mode keeps finishing with no reviewer turn, and so
// does a work-first run (issue #337).
test("a run with no mode and a work-first run still finish with no reviewer turn", async () => {
  const repo = await createTempRepo();
  try {
    for (const mode of [undefined, "work-first"]) {
      const orchAdapter = scripted([
        JSON.stringify({
          action: "finish",
          summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
        }),
      ]);

      const result = await runLoop({
        task: "Implement.",
        cwd: repo,
        maxSteps: 5,
        ...(mode === undefined ? {} : { mode }),
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
      });

      expect(result.exitCode).toBe(0);
    }
  } finally {
    await removePath(repo);
  }
});

// 9. Usefulness: verifies step limit enforcement (exit 2).
test("step limit reached refuses further child dispatch and returns exit 2", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "step 1" }),
      JSON.stringify({ action: "run_worker", prompt: "step 2" }),
      JSON.stringify({ action: "run_worker", prompt: "step 3" }),
    ];
    const workerAdapter = scripted(["r1", "r2", "r3"]);

    const result = await runLoop({
      task: "Task 9",
      cwd: repo,
      maxSteps: 2,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(2);
    expect(workerAdapter.recorded.length).toBe(2);
  } finally {
    await removePath(repo);
  }
});

// 10. Usefulness: verifies last step allows finish for exit 0.
test("finish on stepsRemaining 0 returns exit 0", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "only step" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerAdapter = scripted(["done"]);

    const result = await runLoop({
      task: "Task 10",
      cwd: repo,
      maxSteps: 1,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 11. Usefulness: verifies separate session IDs across 3 roles on same kind.
test("separate session IDs preserved per role", async () => {
  const repo = await createTempRepo();
  try {
    let idGen = 0;
    const multiAgent = {
      async run(state) {
        if (!state.sessionId) {
          state.sessionId = `sess-${++idGen}`;
        }
        return JSON.stringify({
          action: "finish",
          summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
        });
      },
    };

    const roles = {
      orchestrator: { kind: "common", sessionId: null },
      worker: { kind: "common", sessionId: null },
      reviewer: { kind: "common", sessionId: null },
    };

    await runLoop({
      task: "Task 11",
      cwd: repo,
      maxSteps: 5,
      roles,
      agents: { common: multiAgent },
    });

    expect(roles.orchestrator.sessionId).toBe("sess-1");
  } finally {
    await removePath(repo);
  }
});

// 12. Usefulness: verifies child failure surfaces as error status and run continues.
test("child adapter failure surfaces to orchestrator", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "fail please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerAdapter = scripted([
      () => {
        throw new Error("worker crashed");
      },
    ]);
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 12",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).toContain('"status": "error"');
    expect(orchAdapter.recorded[1].prompt).toContain("worker crashed");
  } finally {
    await removePath(repo);
  }
});

// 13. Usefulness: verifies child timeout surfaces as timeout message in error result.
//
// `git` is answered from memory, not spawned: a repo and the snapshots around the
// turns cost about ten `git` processes, and a loaded Windows runner outlasted the
// test limit on them (issue #430). The behavior under test is the timeout message,
// and the snapshot code has its own tests on real repos.
test("child timeout surfaces with timeout message", async () => {
  const cwd = tmpdir();
  gitDouble.answer = cleanRepoGit;
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "hang please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerAdapter = scripted([
      () => {
        throw new ExecError("timeout", { timedOut: true });
      },
    ]);
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 13",
      cwd,
      // The init copy of local files has no `git` answers in the double.
      copyLocalFiles: false,
      maxSteps: 5,
      timeout: 10,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).toContain("reviewer timed out after 10 seconds");
  } finally {
    gitDouble.answer = null;
  }
});

// 14. Usefulness: verifies orchestrator failure is fatal.
test("orchestrator failure throws fatal error", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      () => {
        throw new Error("orchestrator fatal error");
      },
    ]);

    await expect(
      runLoop({
        task: "Task 14",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
      }),
    ).rejects.toThrow("orchestrator fatal error");
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies an orchestrator turn error whose `message` getter throws still
// reaches the caller as the original error. A getter that throws inside the catch
// block would replace it with the getter error (issue #475).
test("orchestrator error with a throwing message getter stays the run result", async () => {
  const repo = await createTempRepo();
  try {
    const hostile = new Error("hidden");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("message getter");
      },
    });

    await expect(
      runLoop({
        task: "Task 475",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: {
          orch: scripted([
            () => {
              throw hostile;
            },
          ]),
          work: scripted([]),
          rev: scripted([]),
        },
      }),
    ).rejects.toBe(hostile);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies an orchestrator turn error whose `message` is an object with its
// own `toString` key still reaches the caller as the original error. A plain string
// conversion of the serialized message throws inside the catch block (issue #475
// review).
test("orchestrator error with a non-string toString-key message stays the run result", async () => {
  const repo = await createTempRepo();
  try {
    const hostile = Object.assign(new Error("hidden"), { message: { toString: 1 } });

    await expect(
      runLoop({
        task: "Task 475",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: {
          orch: scripted([
            () => {
              throw hostile;
            },
          ]),
          work: scripted([]),
          rev: scripted([]),
        },
      }),
    ).rejects.toBe(hostile);
  } finally {
    await removePath(repo);
  }
});

// 15. Usefulness: verifies cancel signal aborts loop.
test("cancel signal stops loop", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  try {
    const orchReplies = [JSON.stringify({ action: "run_worker", prompt: "wait signal" })];
    const workerAdapter = scripted([
      async () => {
        controller.abort();
        throw new ExecError("canceled", { isCanceled: true });
      },
    ]);

    await expect(
      runLoop({
        task: "Task 15",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: workerAdapter, rev: scripted([]) },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a cancel that lands after the worker CLI exits ends the loop as canceled and
// records no ok result for that turn (#587); the cancel is not left for the next spawn to find.
test("a cancel after the worker returns ends the loop with no ok result", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  const events = [];
  try {
    const workerAdapter = scripted([
      async () => {
        controller.abort();
        return "Conclusion: done\nWhy: ok\nBlockers: none";
      },
    ]);

    await expect(
      runLoop({
        task: "Task late cancel",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        onEvent: (event) => events.push(event),
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: {
          orch: scripted([
            JSON.stringify({ action: "run_worker", prompt: "go" }),
            JSON.stringify({
              action: "finish",
              summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
            }),
          ]),
          work: workerAdapter,
          rev: scripted([]),
        },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(events.filter((event) => event.type === "result")).toEqual([]);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a cancel that lands during the post-turn snapshot of a reviewer turn ends the
// loop as canceled with no ok result for that turn (#587).
test("a cancel during the reviewer post-turn snapshot ends the loop with no ok result", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  const post = gitAbortingPostTurn(controller);
  gitDouble.answer = post.git;
  const events = [];
  try {
    await expect(
      runLoop({
        task: "Task snapshot cancel",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        onEvent: (event) => events.push(event),
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: {
          orch: scripted([
            JSON.stringify({ action: "run_reviewer", prompt: "inspect" }),
            JSON.stringify({
              action: "finish",
              summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
            }),
          ]),
          work: scripted([]),
          rev: scripted([
            () => {
              post.arm();
              return "reviewer inspected";
            },
          ]),
        },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(events.filter((event) => event.type === "result")).toEqual([]);
    expect(post.fired).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a cancel that lands during the post-turn snapshot of an orchestrator turn does
// not let the finish action it returned end the run with exit 0 (#587).
test("a cancel during the orchestrator post-turn snapshot does not finish the run", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  const post = gitAbortingPostTurn(controller);
  gitDouble.answer = post.git;
  try {
    await expect(
      runLoop({
        task: "Task orchestrator snapshot cancel",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: {
          orch: scripted([
            () => {
              post.arm();
              return JSON.stringify({
                action: "finish",
                summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
              });
            },
          ]),
          work: scripted([]),
          rev: scripted([]),
        },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(post.fired).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a cancel during the post-turn snapshot of a reviewer turn that ran in a replaced
// conversation keeps the id the CLI reported and the replaced mark, as ADR 0027 requires (#587).
test("a cancel during the reviewer snapshot keeps the reported id and the replaced mark", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  const post = gitAbortingPostTurn(controller);
  gitDouble.answer = post.git;
  const roles = {
    orchestrator: { kind: "orch", sessionId: null },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: "earlier-conversation" },
  };
  try {
    await expect(
      runLoop({
        task: "Task replaced reviewer cancel",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        roles,
        agents: {
          orch: scripted([JSON.stringify({ action: "run_reviewer", prompt: "inspect" })]),
          work: scripted([]),
          rev: scripted([
            (state) => {
              state.sessionId = "replacement-conversation";
              state.conversationReplaced = true;
              post.arm();
              return "reviewer inspected";
            },
          ]),
        },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(roles.reviewer.sessionId).toBe("replacement-conversation");
    expect(roles.reviewer.conversationReplaced).toBe(true);
    expect(post.fired).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the same for an orchestrator turn: a cancel during its post-turn snapshot keeps
// the reported id and the replaced mark of a replaced conversation (#587, ADR 0027).
test("a cancel during the orchestrator snapshot keeps the reported id and the replaced mark", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  const post = gitAbortingPostTurn(controller);
  gitDouble.answer = post.git;
  const roles = {
    orchestrator: { kind: "orch", sessionId: "earlier-conversation" },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: null },
  };
  try {
    await expect(
      runLoop({
        task: "Task replaced orchestrator cancel",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        roles,
        agents: {
          orch: scripted([
            (state) => {
              state.sessionId = "replacement-conversation";
              state.conversationReplaced = true;
              post.arm();
              return JSON.stringify({ action: "abort", reason: "stop" });
            },
          ]),
          work: scripted([]),
          rev: scripted([]),
        },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(roles.orchestrator.sessionId).toBe("replacement-conversation");
    expect(roles.orchestrator.conversationReplaced).toBe(true);
    expect(post.fired).toBe(true);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a cancel of the instruction rerun after an orchestrator conversation replacement
// keeps the reported id and the replaced mark, so the next orchestrator turn carries the instructions (#587).
test("a canceled instruction rerun keeps the replacement id and the replaced mark", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  const roles = {
    orchestrator: { kind: "orch", sessionId: "earlier-conversation" },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: null },
  };
  try {
    await expect(
      runLoop({
        task: "Task canceled instruction rerun",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        roles,
        agents: {
          orch: scripted([
            JSON.stringify({ action: "run_worker", prompt: "go" }),
            (state) => {
              state.sessionId = "replacement-conversation";
              state.conversationReplaced = true;
              return JSON.stringify({ action: "run_worker", prompt: "again" });
            },
            () => {
              controller.abort();
              throw new ExecError("canceled", { isCanceled: true });
            },
          ]),
          work: scripted(["Conclusion: done\nWhy: ok\nBlockers: none"]),
          rev: scripted([]),
        },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(roles.orchestrator.sessionId).toBe("replacement-conversation");
    expect(roles.orchestrator.conversationReplaced).toBe(true);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a cancel of the preamble-only turn of a replaced worker conversation keeps the
// replaced mark, and the next worker turn then sends the preamble with its task and clears the mark (#587).
test("a canceled preamble turn keeps the mark and the next worker turn sends the preamble", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  try {
    const role = { kind: "work", sessionId: "gone" };
    const calls = [];
    const worker = {
      async run(state, prompt) {
        calls.push({ sessionId: state.sessionId, prompt });
        if (calls.length === 1) {
          state.sessionId = "replacement";
          state.conversationReplaced = true;
          return "worker done";
        }
        if (calls.length === 2) {
          controller.abort();
          throw new ExecError("canceled", { isCanceled: true });
        }
        return "worker done again";
      },
    };
    const agents = { work: worker };

    await expect(
      runChild({
        agents,
        role,
        roleName: "worker",
        prompt: "do the work",
        cwd: repo,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ isCanceled: true });
    expect(role).toMatchObject({ sessionId: "replacement", conversationReplaced: true });

    const result = await runChild({
      agents,
      role,
      roleName: "worker",
      prompt: "next task",
      cwd: repo,
    });
    expect(result.status).toBe("ok");
    expect(calls[2].sessionId).toBe("replacement");
    expect(calls[2].prompt).toContain("You are the implementation agent (worker)");
    expect(calls[2].prompt).toContain("next task");
    expect(role.conversationReplaced).toBeUndefined();
  } finally {
    await removePath(repo);
  }
});

// 23. Usefulness: verifies issue #26 acceptance — a timed-out child produces a log line naming the role and "timed out".
test("timed-out child logs a line naming the role and timed out", async () => {
  const repo = await createTempRepo();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "hang please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerAdapter = scripted([
      () => {
        throw new ExecError("timeout", { timedOut: true });
      },
    ]);

    const result = await runLoop({
      task: "Task 23",
      cwd: repo,
      maxSteps: 5,
      timeout: 10,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    const lines = errorSpy.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines.some((line) => line.includes("reviewer") && line.includes("timed out"))).toBe(
      true,
    );
  } finally {
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// 24. Usefulness: verifies issue #26 acceptance — with the debug gate on, snapshot debug lines appear
// around each reviewer and orchestrator turn (reviewer/orchestrator turns are mutation-checked).
test("verbose mode logs snapshot debug lines around reviewer and orchestrator turns", async () => {
  const repo = await createTempRepo();
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  setVerbose(true);
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];

    const result = await runLoop({
      task: "Task 24",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted(["reviewed"]) },
    });

    expect(result.exitCode).toBe(0);
    const lines = logSpy.mock.calls.map((call) => call.join(" "));
    expect(lines.some((line) => line.includes("snapshot") && line.includes("reviewer"))).toBe(true);
    expect(lines.some((line) => line.includes("snapshot") && line.includes("orchestrator"))).toBe(
      true,
    );
  } finally {
    setVerbose(false);
    logSpy.mockRestore();
    await removePath(repo);
  }
});

// 25. Usefulness: verifies issue #26 review fix — a mutation event is logged exactly once (at the
// detection site), not duplicated by the orchestrator failure log.
const expectMutationLoggedOnce = async (action) => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const repo = await createTempRepo();
    try {
      const mutate = async () => {
        await writeFile(join(repo, "mutated.txt"), "mutated\n");
        return "done";
      };
      const orchReply =
        action === "run_reviewer"
          ? [JSON.stringify({ action: "run_reviewer", prompt: "review" })]
          : [null];
      const reviewerReply = action === "run_reviewer" ? [mutate] : [];

      await expect(
        runLoop({
          task: "Task 25",
          cwd: repo,
          maxSteps: 5,
          roles: {
            orchestrator: { kind: "orch", sessionId: null },
            worker: { kind: "work", sessionId: null },
            reviewer: { kind: "rev", sessionId: null },
          },
          agents: {
            // Orchestrator mutation case: orchestrator itself writes a file then dispatches.
            orch:
              action === "run_reviewer"
                ? scripted(orchReply)
                : scripted([
                    async () => {
                      await writeFile(join(repo, "mutated.txt"), "mutated\n");
                      return JSON.stringify({ action: "run_worker", prompt: "go" });
                    },
                  ]),
            work: scripted([]),
            rev: scripted(reviewerReply),
          },
        }),
      ).rejects.toThrow(MutationError);
    } finally {
      await removePath(repo);
    }
    const lines = errorSpy.mock.calls.map((call) => call.join(" "));
    expect(lines.filter((line) => line.includes("Mutation detected during"))).toHaveLength(1);
  } finally {
    errorSpy.mockRestore();
  }
};

test("mutation by the reviewer is logged exactly once", () =>
  expectMutationLoggedOnce("run_reviewer"));

test("mutation by the orchestrator is logged exactly once", () =>
  expectMutationLoggedOnce("run_worker"));
