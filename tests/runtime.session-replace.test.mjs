import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { workerPrompt } from "../src/prompts/worker.mjs";

// The prompt of a later worker turn: the task text and the repeated rules, with no preamble.
const LATER_TURN_PROMPT = workerPrompt("do the work", false);

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

import { reviewedState, snapshot } from "../src/lib/snapshot.mjs";
import { gateFromTranscript } from "../src/lib/gate.mjs";
import { runLoop } from "../src/runtime.mjs";
import {
  cleanRepoGit,
  createCleanRepoDir,
  createTempRepo,
  removePath,
  scripted,
} from "./runtime-helpers.mjs";
import { gateRoles, prGateGh, REVIEW_ACCEPT, REVIEW_REJECT, SUMMARY } from "./gh-doubles.mjs";

// Usefulness: verifies a worker turn that ran in a replacement conversation is followed by one
// preamble-only turn in that conversation, in the same step, and never reruns the task, so its
// edits are not repeated (issue #396, ADR 0016).
test("a replaced worker conversation receives the preamble without a task rerun", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
        if (calls.length === 1) {
          state.sessionId = "replacement";
          state.conversationReplaced = true;
        } else {
          delete state.conversationReplaced;
        }
        return "worker done";
      },
    };

    const roles = {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "work", sessionId: "gone" },
      reviewer: { kind: "rev", sessionId: null },
    };
    const result = await runLoop({
      task: "Task",
      cwd: repo,
      maxSteps: 1,
      roles,
      agents: { orch, work: worker, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.sessionId)).toEqual(["gone", "replacement"]);
    expect(calls[0].prompt).toBe(LATER_TURN_PROMPT);
    expect(calls[1].prompt).toContain("You are the implementation agent (worker)");
    expect(calls[1].prompt).not.toContain("do the work");
    expect(roles.worker.conversationReplaced).toBeUndefined();
    expect(events.filter((e) => e.type === "invocation" && e.role === "worker")).toMatchObject([
      { status: "ok", stepsUsed: 1 },
      { status: "ok", stepsUsed: 1 },
    ]);
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a failed preamble turn never fails the worker turn that already ran, so a
// completed turn and its edits still reach the orchestrator (issue #396).
test("a failed preamble turn keeps the worker result", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const orch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "do the work" }),
      finish,
    ]);
    let calls = 0;
    const worker = {
      async run(state) {
        calls += 1;
        if (calls === 2) {
          throw new Error("preamble turn failed");
        }
        state.sessionId = "replacement";
        state.conversationReplaced = true;
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
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(orch.recorded.at(-1).prompt).toContain("worker done");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

const ORCHESTRATOR_FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

// Usefulness: verifies a replaced orchestrator conversation on a later turn reruns that read-only
// turn once with the initial instructions, uses the rerun decision, and clears the mark, because the
// new conversation never received the instructions (issue #396, ADR 0016).
test("a replaced orchestrator conversation reruns the turn with its instructions", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const orch = {
      async run(state, prompt) {
        calls.push({ sessionId: state.sessionId, prompt });
        if (calls.length === 1) {
          state.sessionId = "orch-old";
          return JSON.stringify({ action: "run_worker", prompt: "do the work" });
        }
        if (calls.length === 2) {
          state.sessionId = "replacement";
          state.conversationReplaced = true;
          return JSON.stringify({ action: "abort", reason: "decided without the instructions" });
        }
        return ORCHESTRATOR_FINISH;
      },
    };
    const roles = {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "work", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    };

    const result = await runLoop({
      task: "Task",
      cwd: repo,
      maxSteps: 2,
      roles,
      agents: { orch, work: scripted(["worker done"]), rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[1].prompt).toContain("Role execution result");
    expect(calls[1].prompt).not.toContain("You are the orchestrator");
    expect(calls[2].sessionId).toBe("replacement");
    expect(calls[2].prompt).toContain("You are the orchestrator");
    expect(calls[2].prompt).toContain("Role execution result");
    expect(roles.orchestrator.conversationReplaced).toBeUndefined();
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a replaced orchestrator conversation on the turn that already carries the
// initial instructions needs no rerun and only clears the mark (issue #396).
test("a replaced orchestrator conversation on its first turn is not rerun", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const calls = [];
    const orch = {
      async run(state, prompt) {
        calls.push(prompt);
        state.sessionId = "replacement";
        if (calls.length === 1) {
          state.conversationReplaced = true;
        }
        return calls.length === 1
          ? JSON.stringify({ action: "run_worker", prompt: "do the work" })
          : ORCHESTRATOR_FINISH;
      },
    };
    const roles = {
      orchestrator: { kind: "orch", sessionId: "gone" },
      worker: { kind: "work", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    };

    const result = await runLoop({
      task: "Task",
      cwd: repo,
      maxSteps: 2,
      roles,
      agents: { orch, work: scripted(["worker done"]), rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("You are the orchestrator");
    expect(calls[1]).not.toContain("You are the orchestrator");
    expect(roles.orchestrator.conversationReplaced).toBeUndefined();
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a worker or reviewer replacement mark never outlives a turn that fails after
// the adapter succeeded, here an event handler that throws, so no later turn reads a stale mark
// (issue #396, ADR 0016).
test.each([
  ["worker", "run_worker"],
  ["reviewer", "run_reviewer"],
])(
  "a %s turn that fails after the adapter succeeded clears the replacement mark",
  async (name, action) => {
    const repo = await createTempRepo();
    try {
      const orch = scripted([JSON.stringify({ action, prompt: "go" }), ORCHESTRATOR_FINISH]);
      const child = {
        async run(state) {
          state.sessionId = "replacement";
          state.conversationReplaced = true;
          return "done";
        },
      };
      const roles = {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: "gone" },
        reviewer: { kind: "rev", sessionId: "gone" },
      };

      await runLoop({
        task: "Task",
        cwd: repo,
        maxSteps: 2,
        roles,
        agents: {
          orch,
          work: name === "worker" ? child : scripted([]),
          rev: name === "reviewer" ? child : scripted([]),
        },
        onEvent: (event) => {
          if (event.type === "invocation" && event.role === name) {
            throw new Error("event handler failed");
          }
        },
      });

      expect(roles[name].conversationReplaced).toBeUndefined();
    } finally {
      await removePath(repo);
    }
  },
);

// Usefulness: verifies a resume that fails because the CLI has no such session clears the id and
// reruns the turn once as a first turn with the worker preamble, inside the one charged step
// (issue #360, ADR 0016).
test("a missing worker session reruns the turn as a first turn in the same step", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
    expect(calls[0].prompt).toBe(LATER_TURN_PROMPT);
    expect(calls[1].prompt).toContain("You are the implementation agent (worker)");
    expect(calls[1].prompt).toContain("do the work");
    expect(events.filter((e) => e.type === "invocation" && e.role === "worker")).toMatchObject([
      { status: "error", stepsUsed: 1 },
      { status: "ok", stepsUsed: 1 },
    ]);
  } finally {
    gitDouble.answer = null;
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
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies a continued run resets the completion gate conservatively
// (#362). The earlier run's worker turn is unknown here, so --require-accept
// treats the tree as changed and unreviewed: a finish with no reviewer turn in
// this run is refused, and a reviewer accept on the current state allows it.
test("a continued --require-accept run needs a reviewer accept before finish", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
    gitDouble.answer = null;
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
      gh: prGateGh(state.head),
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
      gh: prGateGh(state.head),
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
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// Usefulness: verifies the same finish passes on a run that is not continued, so
// the reset above comes from `continued` and not from the gate itself.
test("a fresh --require-accept run with no worker turn finishes after a review", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
    gitDouble.answer = null;
    await removePath(repo);
  }
});

const FINISH_REPLY = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

// Usefulness: verifies requirements "a denied shell call shows in the result of the turn" and "the flag follows read-only turns too" (issue #713, ADR 0035): a worker or reviewer denial reaches the next orchestrator prompt, a later turn without a denial drops it, and an orchestrator turn keeps no flag on its own state.
test("headless result prompts carry shellDenied for the turn that had it and no later turn", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "inspect" }),
      JSON.stringify({ action: "run_worker", prompt: "more work" }),
      (state) => {
        state.shellDenied = true;
        return FINISH_REPLY;
      },
    ]);
    const workerAdapter = scripted([
      (state) => {
        state.shellDenied = true;
        return "worker did task";
      },
      "worker did more",
    ]);
    const reviewerAdapter = scripted([
      (state) => {
        state.shellDenied = true;
        return "reviewer inspected";
      },
    ]);
    const orchestrator = { kind: "orch", sessionId: null };

    const result = await runLoop({
      task: "Task 713",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator,
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    const [, afterWorker, afterReviewer, afterSecondWorker] = orchAdapter.recorded.map(
      (call) => call.prompt,
    );
    expect(afterWorker).toContain('"shellDenied": true');
    expect(afterReviewer).toContain('"shellDenied": true');
    expect(afterSecondWorker).not.toContain("shellDenied");
    expect(orchestrator).not.toHaveProperty("shellDenied");
  } finally {
    gitDouble.answer = null;
    await removePath(repo);
  }
});
