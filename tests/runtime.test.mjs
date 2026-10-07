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

import { ExecError } from "../src/lib/exec.mjs";
import { MutationError, reviewedState, snapshot } from "../src/lib/snapshot.mjs";
import { gateFromTranscript } from "../src/lib/continuation.mjs";
import { runLoop } from "../src/runtime.mjs";
import { setVerbose } from "../src/lib/log.mjs";
import {
  CLEAN_REPO_HEAD,
  cleanRepoGit,
  createTempRepo,
  isApiRead,
  removePath,
  scripted,
  startsWithArgs,
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
    // On second turn, prompt is verbatim
    expect(workerAdapter.recorded[1].prompt).toBe("work 2");
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
test("mutation is logged exactly once", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const runCase = async (action) => {
    errorSpy.mockClear();
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
  };

  await runCase("run_reviewer");
  await runCase("run_worker");
});

// 26. Usefulness: verifies one invocation event per CLI call, including the orchestrator repair
// turn, carrying the usage the adapter exposed (issue #47).
test("runtime emits an invocation event per CLI call with adapter usage", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const withUsage = (reply, cost) => (state) => {
      state.usage = { totalCostUsd: cost };
      return reply;
    };
    const orchAdapter = scripted([
      withUsage(JSON.stringify({ action: "run_worker", prompt: "go" }), 0.1),
      withUsage("not json at all", 0.2),
      withUsage(finish, 0.3),
    ]);
    const workerAdapter = scripted(["worker done"]);
    const events = [];

    const result = await runLoop({
      task: "Task 26",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    const invocations = events.filter((e) => e.type === "invocation");
    expect(invocations).toEqual([
      {
        type: "invocation",
        role: "orchestrator",
        status: "ok",
        stepsUsed: 0,
        usage: { totalCostUsd: 0.1 },
      },
      { type: "invocation", role: "worker", status: "ok", stepsUsed: 1 },
      {
        type: "invocation",
        role: "orchestrator",
        status: "ok",
        stepsUsed: 1,
        usage: { totalCostUsd: 0.2 },
      },
      {
        type: "invocation",
        role: "orchestrator",
        status: "ok",
        stepsUsed: 1,
        usage: { totalCostUsd: 0.3 },
      },
    ]);
    // Usage is consumed per invocation and never lingers on the role state.
    expect(orchAdapter.recorded.length).toBe(3);
  } finally {
    await removePath(repo);
  }
});

// 27. Usefulness: verifies a failed CLI call still produces an invocation event with error status.
test("runtime emits an error invocation event when the CLI call throws", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "fail" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted([
      () => {
        throw new Error("worker crashed");
      },
    ]);
    const events = [];

    await runLoop({
      task: "Task 27",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    const workerInvocations = events.filter((e) => e.type === "invocation" && e.role === "worker");
    expect(workerInvocations).toEqual([
      { type: "invocation", role: "worker", status: "error", stepsUsed: 1 },
    ]);
  } finally {
    await removePath(repo);
  }
});

// 28. Usefulness: verifies usage an adapter exposed before throwing reaches the error invocation
// event and is cleared from the role state (issue #47).
test("runtime keeps adapter usage on an error invocation event and clears it from state", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "fail" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted([
      (state) => {
        state.usage = { totalCostUsd: 0.05 };
        throw new Error("worker crashed after spending");
      },
    ]);
    const roles = {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "work", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    };
    const events = [];

    await runLoop({
      task: "Task 28",
      cwd: repo,
      maxSteps: 5,
      roles,
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    const workerInvocations = events.filter((e) => e.type === "invocation" && e.role === "worker");
    expect(workerInvocations).toEqual([
      {
        type: "invocation",
        role: "worker",
        status: "error",
        stepsUsed: 1,
        usage: { totalCostUsd: 0.05 },
      },
    ]);
    expect(roles.worker.usage).toBeUndefined();
  } finally {
    await removePath(repo);
  }
});

const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };
const REVIEW_ACCEPT = [
  "Conclusion: the state passes.",
  "Why: changes match the task.",
  "Blockers: none.",
  "Checks: npm test",
  "Verdict: accept",
].join("\n");
const REVIEW_REJECT = [
  "Conclusion: the state fails.",
  "Why: the change is incomplete.",
  "Blockers: none.",
  "Verdict: reject",
].join("\n");

function gateRoles() {
  return {
    orchestrator: { kind: "orch", sessionId: null },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: null },
  };
}

// 29. Usefulness: verifies --require-accept refuses a finish with no later
// reviewer accept, then allows the finish once a reviewer accepts that state
// (issue #234).
test("--require-accept refuses a finish until a reviewer accepts", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 30. Usefulness: verifies the gate treats a reviewer reject as not accepted, and
// a later reviewer accept on the same state allows the finish (issue #234).
test("--require-accept treats a reviewer reject as not accepted", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 31. Usefulness: verifies the gate maps a run with no worker turn to review-only:
// the finish follows the report whatever the verdict (issue #234).
test("--require-accept allows a review-only finish with no worker turn", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 32. Usefulness: verifies a repeated finish that still lacks a reviewer accept
// ends the run instead of spinning (issue #234).
test("--require-accept aborts a repeated refused finish", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 33. Usefulness: verifies --require-accept refuses a finish with no child turn
// and allows a review-only finish once a reviewer report exists (issue #234).
test("--require-accept requires a reviewer report when no worker turn ran", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 34. Usefulness: verifies a reviewer reply with no Verdict line does not satisfy
// the gate: process success never implies acceptance (issue #234).
test("--require-accept does not accept a reviewer reply without a verdict", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 35. Usefulness: verifies a later reviewer failure does not clear an earlier
// reviewer report when no worker turn ran, so "at least one reviewer report"
// holds (issue #234).
test("--require-accept keeps an earlier reviewer report after a later failure", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 36. Usefulness: verifies a finish refused when the step budget is already used
// ends on the refusal path with exit 1, records the refusal event, and never
// attempts the corrective child dispatch that the used budget cannot run
// (issues #248, #247).
test("--require-accept returns the refusal exit 1 when no step budget remains", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 37. Usefulness: verifies each refused finish under --require-accept is recorded
// as a refusal event that follows the refused action, carries the reason and the
// step count, and appears once per refusal (issue #247).
test("--require-accept records a refused finish as a refusal event", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 38. Usefulness: verifies the gate treats a reviewer accept with no Checks line
// as not accepted, matching the parent prompt rule (issue #217, issue #218).
test("--require-accept treats an accept without a Checks line as not accepted", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 39. Usefulness: verifies a finish that reports an unresolved PR-head compare
// records a distinct `unresolved-compare` event and still exits 0 with the
// summary, so the recorded finish no longer reads as a verified finish (#266).
test("finish with unresolvedCompare records an unresolved-compare event", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 40. Usefulness: pins the accepted gap for #286. A PR-work finish that records
// the unresolved compare under `notDone` and `open` and omits the marker leaves
// no machine signal: exit 0, the summary, and no unresolved-compare event, which
// a consumer cannot tell from a verified finish. The free text is the only trace,
// so this pins the limit as deliberate instead of letting it drift unnoticed.
test("a PR finish that omits unresolvedCompare reads as verified", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 41. Usefulness: verifies a finish that carries the marker emits no
// unresolved-compare event while the --require-accept gate refuses it, and
// emits exactly one once a reviewer accept allows the finish, so the event
// tracks the accepted finish rather than the marker alone (#234, #266).
test("--require-accept emits the marker event only on the accepted finish", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 42. Usefulness: verifies a real review-only finish (a reviewer turn, no
// worker turn) records the event when it carries the marker, so the marker
// path is covered outside the worker-plus-reviewer gate path (#234, #266).
test("review-only finish with the marker records the event", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

const PASSING_RUN = {
  id: 1,
  name: "ci (ubuntu-latest)",
  status: "completed",
  conclusion: "success",
  started_at: "2026-01-01T00:00:00Z",
};

// Answers the `--require-ci` gate the way the shared `checkCi` gate reads `gh`:
// the PR view, the repository slug, the two required-check sources, and the
// check runs and commit statuses GitHub evaluates. `headRefOid` is the PR head
// the gate compares with the reviewed commit. `runs` are the check runs every
// commit carries.
function ciGateGh(headRefOid, calls = [], runs = [PASSING_RUN]) {
  return async (args) => {
    calls.push(args.join(" "));
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (startsWithArgs(args, ["pr", "view", "42"])) {
      return json({
        headRefOid,
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
        potentialMergeCommit: null,
        state: "OPEN",
      });
    }
    if (startsWithArgs(args, ["repo", "view"])) {
      return { status: 0, stdout: "owner/repo", stderr: "" };
    }
    if (startsWithArgs(args, ["pr", "checks", "42"])) {
      return json([]);
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
      return json([{ check_runs: runs }]);
    }
    if (isApiRead(args, "/status")) {
      // The status read paginates, so its reply is an array of pages.
      return json(args.includes("--paginate") ? [{ statuses: [] }] : { statuses: [] });
    }
    return { status: 1, stdout: "", stderr: `unmatched: ${JSON.stringify(args)}` };
  };
}

// Usefulness: verifies the `--require-ci` double routes on the argument elements,
// so a call that merges the arguments into one element gets no reply and its
// error prints the array, which differs from the text of the expected call
// (issue #530).
test("the --require-ci gh double gives no reply to a merged-argument call", async () => {
  const merged = ["pr view 42 --json headRefOid"];
  const reply = await ciGateGh(OTHER_HEAD)(merged);
  expect(reply.status).toBe(1);
  expect(reply.stdout).toBe("");
  expect(reply.stderr).toContain(JSON.stringify(merged));
});

const OTHER_HEAD = "1".repeat(40);

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
  const repo = await createTempRepo();
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
      gh: ciGateGh(OTHER_HEAD),
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
    await removePath(repo);
  }
});

// 44. Usefulness: verifies the same gate accepts the finish once the PR head is
// the reviewed commit, so the refusal above comes from the gate result and not
// from a gate that always refuses (issue #293).
test("--require-ci passes a finish whose PR head is the reviewed commit", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
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
      gh: ciGateGh(head, calls),
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
    await removePath(repo);
  }
});

// 45. Usefulness: verifies a worker turn after the reviewer turn clears the
// reviewed state the gate reads, so a commit made after the review cannot pass
// against the older reviewed head, matching the interactive gate (#293).
test("--require-ci refuses a finish after a worker turn follows the review", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
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
      gh: ciGateGh(head),
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
    await removePath(repo);
  }
});

// 46. Usefulness: verifies the gate refuses a finish that also records the
// unresolved compare, and does so without asking GitHub, because the gate
// resolves that compare and the marker would contradict it (issue #293, #281).
test("--require-ci refuses a finish that carries unresolvedCompare", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const head = (await snapshot(repo)).head;
    const calls = [];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 46 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: ciGateGh(head, calls),
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
    await removePath(repo);
  }
});

// Usefulness: verifies a `gh` rejection whose `message` getter throws still refuses the
// finish. A getter that throws inside the gate catch block would throw out of the
// loop and discard a run that a later gate read could pass (issue #475).
test("--require-ci refuses when the gh error message getter throws", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const hostile = new Error("hidden");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("message getter");
      },
    });
    const throwingGh = async (args) => {
      if (args.join(" ").includes("pr view 42")) {
        throw hostile;
      }
      return ciGateGh(head)(args);
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
    await removePath(repo);
  }
});

// Usefulness: verifies a `gh` rejection whose `message` is an object with its own
// `toString` key still refuses the finish. A plain string conversion of the
// serialized message throws inside the gate catch block (issue #475 review).
test("--require-ci refuses when the gh error message is a non-string with a toString key", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const throwingGh = async (args) => {
      if (args.join(" ").includes("pr view 42")) {
        throw Object.assign(new Error("hidden"), { message: { toString: 1 } });
      }
      return ciGateGh(head)(args);
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
    await removePath(repo);
  }
});

// 47. Usefulness: verifies a `gh` failure inside the gate refuses the finish
// instead of throwing out of the loop. The interactive path leaves the run active
// for a retry, and the headless run has none outside the refusal, so a throw
// would discard a run a second attempt could pass (#293).
test("--require-ci turns a gh failure into a refusal, not a throw", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];
    const failingGh = async (args) => {
      const key = args.join(" ");
      if (key.includes("pr view 42")) {
        return { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
      }
      return ciGateGh(head)(args);
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
    await removePath(repo);
  }
});

// 48. Usefulness: verifies a finish that breaks more than one rule is refused
// for every rule it breaks, in the order the interactive `role finish` checks
// them. One corrective turn is all the run grants, so a prompt that names only
// the first condition spends it on a condition the next refusal names instead
// (#293).
test("a finish that breaks several rules is refused for all of them", async () => {
  const repo = await createTempRepo();
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
      gh: ciGateGh("1".repeat(40), calls),
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
  const repo = await createTempRepo();
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
      gh: ciGateGh(OTHER_HEAD, calls),
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
    await removePath(repo);
  }
});

test("--require-ci still runs the gate after the review-only reviewer-turn refusal", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({ action: "finish", summary: SUMMARY });

    const result = await runLoop({
      task: "Review PR 42 only.",
      cwd: repo,
      maxSteps: 5,
      mode: "review-only",
      requireCi: 42,
      gh: ciGateGh(OTHER_HEAD),
      roles: gateRoles(),
      agents: { orch: scripted([finish, finish]), work: scripted([]), rev: scripted([]) },
    });

    // No reviewer turn ran, so the gate itself refuses with its no-reviewed-state reason.
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("no reviewer turn has run");
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
  } finally {
    await removePath(repo);
  }
});

test("--require-ci still runs the gate after the --require-accept refusal", async () => {
  const repo = await createTempRepo();
  try {
    const calls = [];
    const finish = JSON.stringify({ action: "finish", summary: SUMMARY });

    const result = await runLoop({
      task: "PR work: address issue 366 through PR 42.",
      cwd: repo,
      maxSteps: 6,
      requireAccept: true,
      requireCi: 42,
      gh: ciGateGh(OTHER_HEAD, calls),
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
    await removePath(repo);
  }
});

// 49. Usefulness: verifies an orchestrator that follows the refusal prompt
// reaches exit 0, for the marker refusal and for the gate refusal. The prompt is
// the run's only recovery, and a second refused finish with no child turn in
// between ends the run, so wording that omits the child turn is a dead end even
// when the wording is accurate (#293).
test("following a --require-ci refusal prompt reaches exit 0", async () => {
  const repo = await createTempRepo();
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
      gh: ciGateGh((await snapshot(repo)).head),
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
    const head = (await snapshot(repo)).head;
    const gateHead = { current: OTHER_HEAD };
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
      // turn, which is the recovery the prompt named.
      gh: async (args) => {
        const key = args.join(" ");
        const answer = ciGateGh(key.includes("pr view 42") ? gateHead.current : head);
        const result = await answer(args);
        if (key.includes("pr view 42")) {
          gateHead.current = head;
        }
        return result;
      },
      roles: gateRoles(),
      agents: {
        orch: gateOrch,
        work: scripted(["worker changed", "worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT, REVIEW_ACCEPT]),
      },
    });

    const gatePrompt = gateOrch.recorded[3].prompt;
    expect(gatePrompt).toContain("the PR head differs from the reviewed commit");
    expect(gatePrompt).toContain("Dispatch the reviewer");
    expect(gatePrompt).toContain("a worker turn resets the reviewed state to none");
    expect(gateResult.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 50. Usefulness: verifies a finish refused for the marker alone recovers with a
// re-finish and no child turn. Every other condition already passed, so a prompt
// that insists on a child turn would spend a step and start a review cycle the
// run did not need (#293).
test("a marker-only refusal is cleared by a re-finish with no child turn", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
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
      gh: ciGateGh(head),
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
    await removePath(repo);
  }
});

// 51. Usefulness: verifies the prompt for a pending required check names the
// reviewer turn that clears it. A worker turn alone clears neither the reviewed
// state nor the completion rule, so a prompt naming only the worker turn spends
// an extra refusal and extra steps (#293).
test("a pending-check refusal is cleared by the reviewer turn its prompt names", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
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
      const key = args.join(" ");
      if (key.includes("/check-runs")) {
        const answer = await ciGateGh(head)(args);
        if (check.status === "completed") {
          return answer;
        }
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              check_runs: [
                {
                  name: "ci (ubuntu-latest)",
                  status: check.status,
                  conclusion: null,
                  started_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
          ]),
          stderr: "",
        };
      }
      return ciGateGh(head)(args);
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
    await removePath(repo);
  }
});

// 52. Usefulness: verifies a run that declares a PR refuses a finish with no
// `--require-ci` gate, so a declared PR run cannot finish through a field the
// parent set. A run without the declaration keeps the marker-only gap (#302).
test("a run that declares a PR refuses a finish with no --require-ci gate", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 53. Usefulness: verifies the same declaration refuses a finish that records the
// unresolved compare, because the gate is what the declaration requires. A
// recorded marker on a declared PR run would read as an accepted gap, so the
// finish is refused instead (#302).
test("a run that declares a PR refuses a finish that carries unresolvedCompare", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 54. Usefulness: verifies the marker refusal fires on a declared PR run with no
// gate, and that one refusal names both conditions in the existing order. The
// finish breaks two rules and the run grants one corrective turn, so a refusal
// that names one of them spends it on the condition the next refusal names
// instead (#302).
test("a declared PR with no gate reports the marker and the gate in one refusal", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 55. Usefulness: verifies the declared-PR refusal is reported with the completion
// rule in the existing order, so one refusal names every condition the finish
// breaks (#302).
test("the missing-gate refusal is reported with the other refusals in order", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 55. Usefulness: verifies a run that declares a PR and also carries the gate
// behaves exactly as a gated run does today, so the declaration adds no second
// enforcement path and no new refusal (#302).
test("a declared PR with a matching gate runs the gate and nothing else", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const result = await runLoop({
      task: "PR work: address issue 55 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: ciGateGh(head),
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
    await removePath(repo);
  }
});

// The `gh` state of a ruleset-only base branch with no required check, as the gate
// reads it: the ruleset read returns a non-empty array of well-formed rules with no
// required-status-check rule, classic protection answers the exact 404 only a
// caller able to read it receives on an unprotected branch, and the required-names
// read carries no list. Both configuration sources stated the outcome, so the gate
// establishes the absence (issue #336).
function noRequiredCheckGh(headRefOid, calls = []) {
  const read = ciGateGh(headRefOid, calls);
  return async (args) => {
    const key = args.join(" ");
    if (key.includes("rules/branches/main")) {
      calls.push(key);
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
    if (key === "pr checks 42 --required --json name") {
      calls.push(key);
      return { status: 1, stdout: "", stderr: "no required checks reported" };
    }
    return read(args);
  };
}

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
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      // The init copy of local files is out of scope here, and its `git` calls
      // have no answer in the double.
      copyLocalFiles: false,
      gh: noRequiredCheckGh(CLEAN_REPO_HEAD),
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
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// Usefulness: verifies a headless gated run on a base branch that does require a
// check emits no absence event, so the field on the event cannot read as a
// statement about every gated run (issue #336).
test("a gated run on a checked base branch emits no absence event", async () => {
  const repo = await createTempRepo();
  try {
    const events = [];
    const result = await runLoop({
      task: "PR work: address issue #336 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: ciGateGh((await snapshot(repo)).head),
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
    await removePath(repo);
  }
});

// 56. Usefulness: verifies a run that declares PR 42 and gates a different PR is
// refused, so the gate cannot read one pull request while the run declares
// another (#302).
test("a run that declares a PR refuses a gate for a different PR", async () => {
  const repo = await createTempRepo();
  try {
    const calls = [];

    const result = await runLoop({
      task: "PR work: address issue 56 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 7,
      gh: ciGateGh((await snapshot(repo)).head, calls),
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
    await removePath(repo);
  }
});

// 57. Usefulness: pins the exact refusal a declared run gives when the gate names
// another PR, and that the gate for that other PR is never read. A prompt or a
// consumer that reads the reason as a gate verdict would otherwise expect a gate
// result the runtime never produced (#302).
test("a mismatched-gate refusal names the declaration and reads no gate", async () => {
  const repo = await createTempRepo();
  try {
    const calls = [];
    const result = await runLoop({
      task: "PR work: address issue 57 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      // No reviewer turn here, so the status read never runs and no call is made.
      pr: 42,
      requireCi: 7,
      gh: ciGateGh((await snapshot(repo)).head, calls),
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
    // calls the run happens to make (#320 review).
    expect(gateReads(calls)).toEqual([]);
  } finally {
    await removePath(repo);
  }
});

// 58. Usefulness: pins the exact refusal for a declared run whose gate matches and
// whose finish breaks the marker condition and a gate condition together. The gate
// has its own conditions, so the marker is not the only broken one, and a prompt
// that claimed otherwise would send the run after the wrong fix (#302).
test("a matching-gate refusal names the marker and the gate condition together", async () => {
  const repo = await createTempRepo();
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
      gh: ciGateGh((await snapshot(repo)).head),
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
    await removePath(repo);
  }
});

// 57. Usefulness: verifies the missing-gate prompt tells the orchestrator what
// the run needs, because no turn in the run can add a flag. A prompt that only
// said "finish again" would end the run on exit 1 with no recovery named (#302).
test("the missing-gate refusal prompt names the gate the run needs", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 58. Usefulness: verifies the marked-finish prompt names a missing gate only when
// the gate is missing. A declared run whose gate matches loses the gate condition
// once the marker is removed, so a prompt that names a missing gate there tells
// the orchestrator to abort a run it can finish. A declared run with no gate keeps
// both conditions and the gate is named (#302).
test("the marked-finish prompt names a missing gate only when the gate is missing", async () => {
  const repo = await createTempRepo();
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
      gh: ciGateGh((await snapshot(repo)).head),
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
    await removePath(repo);
  }
});

// 58. Usefulness: verifies a run that declares no PR keeps the marker-only
// behavior it has today, so the new declaration changes nothing for an ungated
// run that is not PR work (#302).
test("a run that declares no PR still records a marked finish", async () => {
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// 59. Usefulness: verifies the `gh`-failure prompt does not tell the
// orchestrator it is out of attempts, and names a reviewer turn as the retry.
// Any child turn clears the prior-refusal flag, so the run keeps its corrective
// turn while step budget remains (#293).
test("a gh-failure refusal does not claim the run is out of attempts", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const failing = { on: true };
    const orch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gh = async (args) => {
      const key = args.join(" ");
      if (failing.on && key.includes("pr view 42")) {
        return { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
      }
      return ciGateGh(head)(args);
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
    await removePath(repo);
  }
});

// Answers the runtime read of the required checks for PR 42 and the finish gate
// from the shared gate fixture, with `runs` as the check runs of every commit.
const reviewerReadGh = (headRefOid, runs) => ciGateGh(headRefOid, [], runs);

// Usefulness: verifies a run that declares a PR supplies the required-check
// status the runtime read to the reviewer turn and records that read in the
// result, so a reviewer whose turn cannot reach the network still sees the
// failing check and the parent can compare it with the reviewer Checks line
// (issue #320).
test("a declared PR supplies the runtime-read required-check status to the reviewer", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
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
  const repo = await createTempRepo();
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
    await removePath(repo);
  }
});

// Usefulness: verifies a hung required-check read does not fail or halt the
// dispatch, because the status is supplied evidence and the reviewer keeps its
// own read, so a stalled `gh` must yield an unresolved status and a completed
// reviewer turn (issue #320 review).
test("a hung required-check read yields an unresolved status and a completed turn", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
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
        const key = args.join(" ");
        // Only the ruleset read stalls: the head resolves, so the read reaches the
        // call a hung `gh` would hold open.
        if (rev.recorded.length === 0 && key.includes("rules/branches/main")) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("read timed out")));
          });
        }
        return ciGateGh(head)(args, cwd, options);
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
    await removePath(repo);
  }
});

// Usefulness: verifies the gate-endpoint list the refusal assertions use covers
// every endpoint the finish gate actually reads, because a list that omits one
// lets a refused finish pass a GitHub read it should never make while the test
// still reports no reads (issue #320 review, second round).
test("the refusal assertion covers every endpoint the finish gate reads", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    // A run whose gate matches, so the gate runs and every endpoint it reads is
    // recorded. That recorded list is what a refused finish must not contain.
    const calls = [];
    await runLoop({
      task: "PR work: address issue 320 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      pr: 42,
      requireCi: 42,
      gh: ciGateGh(head, calls),
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
    await removePath(repo);
  }
});

// Usefulness: verifies the headless wait bound follows the turn --timeout the run
// was started with, so a wait the orchestrator runs ends before the turn does and
// the run cannot end on exit 1 with no action (issue #348).
test("the orchestrator prompt states a wait bound below the run's turn timeout", async () => {
  const repo = await createTempRepo();
  try {
    const orch = scripted([JSON.stringify({ action: "abort", reason: "stop" })]);
    await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      timeout: 60,
      requireCi: 42,
      gh: ciGateGh("0".repeat(40)),
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
    await removePath(repo);
  }
});

// Usefulness: verifies a run whose turn --timeout is too short for any bounded
// wait tells the orchestrator not to wait, instead of a wait the turn cannot
// hold (issue #348).
test("the orchestrator prompt names no wait when the turn timeout is too short", async () => {
  const repo = await createTempRepo();
  try {
    const orch = scripted([JSON.stringify({ action: "abort", reason: "stop" })]);
    await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      timeout: 8,
      requireCi: 42,
      gh: ciGateGh("0".repeat(40)),
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
    await removePath(repo);
  }
});

// Usefulness: verifies a resume that fails because the CLI has no such session clears the id and
// reruns the turn once as a first turn with the worker preamble, inside the one charged step
// (issue #360, ADR 0016).
test("a missing worker session reruns the turn as a first turn in the same step", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const orch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "do the work" }),
      finish,
    ]);
    const calls = [];
    const events = [];
    const worker = {
      async run(state, prompt) {
        calls.push({ sessionId: state.sessionId, prompt });
        if (state.sessionId === "gone") {
          throw Object.assign(new Error("No conversation found"), { sessionMissing: true });
        }
        state.sessionId = "fresh";
        return "worker done";
      },
    };

    const result = await runLoop({
      task: "Task",
      cwd: repo,
      maxSteps: 1,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: "gone" },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch, work: worker, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.sessionId)).toEqual(["gone", null]);
    expect(calls[0].prompt).toBe("do the work");
    expect(calls[1].prompt).toContain("You are the implementation agent (worker)");
    expect(calls[1].prompt).toContain("do the work");
    expect(events.filter((e) => e.type === "invocation" && e.role === "worker")).toMatchObject([
      { status: "error", stepsUsed: 1 },
      { status: "ok", stepsUsed: 1 },
    ]);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: acceptance (#490) — the resume fallback reruns the turn as a first turn only for a
// thrown value whose `sessionMissing` reads truthy. A value without it, including `null`,
// `undefined`, and primitives, surfaces as the worker error. A throwing getter surfaces the
// worker's own error with no rerun, and never replaces it with the getter error.
const throwingSessionMissing = new Error("worker failed");
Object.defineProperty(throwingSessionMissing, "sessionMissing", {
  get() {
    throw new Error("sessionMissing getter");
  },
});
test.each([
  ["null", null, false],
  ["undefined", undefined, false],
  ["a string", "worker failed", false],
  ["a number", 42, false],
  ["a plain object without sessionMissing", { message: "worker failed" }, false],
  ["a plain object with sessionMissing false", { sessionMissing: false }, false],
  [
    "a plain object with sessionMissing true",
    { message: "worker failed", sessionMissing: true },
    true,
  ],
  ["an Error without sessionMissing", new Error("worker failed"), false],
  [
    "an Error with sessionMissing true",
    Object.assign(new Error("worker failed"), { sessionMissing: true }),
    true,
  ],
  ["a throwing sessionMissing getter", throwingSessionMissing, false],
])("resume fallback for a worker that throws %s", async (_name, thrown, reruns) => {
  const repo = await createTempRepo();
  try {
    let workerCalls = 0;
    const orch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "do it" }),
      JSON.stringify({ action: "abort", reason: "worker failed" }),
    ]);

    await runLoop({
      task: "Task 490",
      cwd: repo,
      maxSteps: 1,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: "resumed" },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: {
        orch,
        work: {
          async run(state) {
            workerCalls += 1;
            if (workerCalls === 1) {
              throw thrown;
            }
            state.sessionId = "fresh";
            return "worker done";
          },
        },
        rev: scripted([]),
      },
    });

    expect(workerCalls).toBe(reruns ? 2 : 1);
    if (!reruns) {
      const lastOrchestratorPrompt = orch.recorded.at(-1).prompt;
      expect(lastOrchestratorPrompt).not.toContain("sessionMissing getter");
      if (thrown === throwingSessionMissing) {
        expect(lastOrchestratorPrompt).toContain("worker failed");
      }
    }
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a continued run resets the completion gate conservatively
// (#362). The earlier run's worker turn is unknown here, so --require-accept
// treats the tree as changed and unreviewed: a finish with no reviewer turn in
// this run is refused, and a reviewer accept on the current state allows it.
test("a continued --require-accept run needs a reviewer accept before finish", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_ACCEPT]);
    const orchAdapter = scripted(orchReplies);
    const roles = gateRoles();
    roles.orchestrator.sessionId = "earlier-orch";

    const result = await runLoop({
      task: "Task 362",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      continued: true,
      roles,
      agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
    expect(orchAdapter.recorded[0].sessionId).toBe("earlier-orch");
    expect(orchAdapter.recorded[0].prompt).toMatch(/continues an earlier run/i);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the gate state a headless run ends with restores on a continued run
// whose tree is unchanged (#393): the earlier reviewer accept still satisfies --require-accept,
// so the finish needs no new reviewer turn. Distinct from the reset test above, which has no
// earlier gate to restore.
test("a continued --require-accept run restores the earlier accept on an unchanged tree", async () => {
  const repo = await createTempRepo();
  try {
    const events = [];
    const first = await runLoop({
      task: "Task 393",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worked"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });
    expect(first.exitCode).toBe(0);

    const reviewer = scripted([]);
    const second = await runLoop({
      task: "Task 393",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      continued: true,
      earlierGate: gateFromTranscript({ events: [...events, { type: "gate", ...first.gate }] }),
      roles: gateRoles(),
      agents: {
        orch: scripted([JSON.stringify({ action: "finish", summary: SUMMARY })]),
        work: scripted([]),
        rev: reviewer,
      },
    });
    expect(second.exitCode).toBe(0);
    expect(reviewer.recorded.length).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a changed tree keeps the reset (#393): the earlier accept describes a
// state that no longer exists, so the finish is refused until a reviewer turn runs.
test("a continued --require-accept run resets the gate when the tree changed", async () => {
  const repo = await createTempRepo();
  try {
    const events = [];
    const first = await runLoop({
      task: "Task 393",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worked"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });
    expect(first.exitCode).toBe(0);
    await writeFile(join(repo, "edited-between-runs.txt"), "new\n");

    const reviewer = scripted([REVIEW_ACCEPT]);
    const second = await runLoop({
      task: "Task 393",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      continued: true,
      earlierGate: gateFromTranscript({ events: [...events, { type: "gate", ...first.gate }] }),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: reviewer,
      },
    });
    expect(second.exitCode).toBe(0);
    expect(reviewer.recorded.length).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a gate record whose `clean` is not a boolean never restores (#393 review):
// the --require-ci gate reads `clean` for truthiness, so a string would pass a gate that needs a
// clean reviewed tree. The reset makes the finish need a reviewer turn from this run.
test("a continued run resets when the earlier gate record holds an invalid clean value", async () => {
  const repo = await createTempRepo();
  try {
    const state = reviewedState(await snapshot(repo));
    const reviewer = scripted([REVIEW_ACCEPT]);
    const result = await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      continued: true,
      earlierGate: {
        workerRan: true,
        reviewerRan: true,
        reviewerTurnDispatched: true,
        acceptedSinceWorker: true,
        lastReviewed: { ...state, clean: "yes" },
      },
      gh: ciGateGh(state.head),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary: SUMMARY }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: reviewer,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(reviewer.recorded.length).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a restored gate takes `clean` from the current work tree, not from the
// record (#393 review): a record that claims a clean review of a dirty tree must still fail the
// --require-ci clean-tree check.
test("a restored gate reads cleanliness from the current tree, not the record", async () => {
  const repo = await createTempRepo();
  try {
    await writeFile(join(repo, "dirty.txt"), "dirty\n");
    const state = reviewedState(await snapshot(repo));
    expect(state.clean).toBe(false);
    const result = await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      continued: true,
      earlierGate: {
        workerRan: true,
        reviewerRan: true,
        reviewerTurnDispatched: true,
        acceptedSinceWorker: true,
        lastReviewed: { ...state, clean: true },
      },
      gh: ciGateGh(state.head),
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
    expect(result.reason).toContain("the reviewed work tree is not clean");
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a failure that is not a missing session is not retried, and a failed rerun
// is reported once with the cleared id, so the loop cannot retry without bound.
test("only a missing session reruns, and the rerun happens once", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const orch = scripted([JSON.stringify({ action: "run_worker", prompt: "p" }), finish]);
    let missingCalls = 0;
    const worker = {
      async run() {
        missingCalls += 1;
        throw Object.assign(new Error("still missing"), { sessionMissing: true });
      },
    };
    const role = { kind: "work", sessionId: "gone" };

    await runLoop({
      task: "Task",
      cwd: repo,
      maxSteps: 2,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: role,
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch, work: worker, rev: scripted([]) },
    });

    expect(missingCalls).toBe(2);
    expect(role.sessionId).toBeNull();

    let plainCalls = 0;
    const plain = {
      async run() {
        plainCalls += 1;
        throw new Error("boom");
      },
    };
    await runLoop({
      task: "Task",
      cwd: repo,
      maxSteps: 2,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: "keep" },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: {
        orch: scripted([JSON.stringify({ action: "run_worker", prompt: "p" }), finish]),
        work: plain,
        rev: scripted([]),
      },
    });
    expect(plainCalls).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the same finish passes on a run that is not continued, so
// the reset above comes from `continued` and not from the gate itself.
test("a fresh --require-accept run with no worker turn finishes after a review", async () => {
  const repo = await createTempRepo();
  try {
    const result = await runLoop({
      task: "Task 362",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted([]),
        rev: scripted([REVIEW_REJECT]),
      },
    });
    expect(result.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});
