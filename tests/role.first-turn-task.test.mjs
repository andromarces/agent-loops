import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vite-plus/test";
import { statePaths } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  recordingAdapter,
  repos,
  REPORT,
  reviewerTurn,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

const TASK_BLOCK = "Init task:\nFix the flaky test.";

async function startRun() {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  return repo;
}

const workerTurn = (repo, agents, overrides = []) =>
  executeRoleCommand(withRepo(dispatchArgv(overrides), repo), { agents, stdin: stdinPrompt });

// Usefulness: acceptance of #826. A worker that gets only "continue working" still learns the task,
// once, and a resumed turn of the same role does not repeat it.
test("the first worker turn shows the init task under its own label and a later turn does not", async () => {
  const repo = await startRun();
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  await workerTurn(repo, agents);

  const [first, second] = worker.recorded.map((call) => call.prompt);
  expect(first).toContain(TASK_BLOCK);
  expect(first.indexOf(TASK_BLOCK)).toBeLessThan(first.indexOf("Instructions:\ncontinue working"));
  expect(second).not.toContain("Fix the flaky test.");
});

// Usefulness: acceptance of #826 for the reviewer, whose prompt is rebuilt on every turn and so
// needs its own once-only rule.
test("the first reviewer turn shows the init task under its own label and a later turn does not", async () => {
  const repo = await startRun();
  const reviewer = recordingAdapter([`${REPORT}\nVerdict: accept`]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  await reviewerTurn(repo, agents);
  await reviewerTurn(repo, agents);

  const [first, second] = reviewer.recorded.map((call) => call.prompt);
  expect(first).toContain(TASK_BLOCK);
  expect(first.indexOf(TASK_BLOCK)).toBeLessThan(first.indexOf("Instructions:\ncontinue working"));
  expect(second).not.toContain("Fix the flaky test.");
});

// Usefulness: a resume that fails with a missing session reruns the turn as a first turn (ADR 0016),
// and the new conversation has never seen the task, so each rerun prompt must carry it again.
for (const role of ["worker", "reviewer"]) {
  test(`a ${role} turn rerun as a first turn after a missing session shows the init task`, async () => {
    const repo = await startRun();
    const prompts = [];
    const flaky = {
      async run(state, prompt) {
        prompts.push(prompt);
        if (state.sessionId === "sess-old") {
          throw Object.assign(new Error("No conversation found"), { sessionMissing: true });
        }
        state.sessionId = "sess-new";
        return REPORT;
      },
    };
    const first = recordingAdapter([
      (state) => {
        state.sessionId = "sess-old";
        return REPORT;
      },
    ]);
    const agents =
      role === "worker"
        ? { fake1: first, fake2: recordingAdapter([]) }
        : { fake1: recordingAdapter([]), fake2: first };
    await workerTurn(repo, agents, INIT_OVERRIDES);
    if (role === "reviewer") {
      await reviewerTurn(repo, agents);
    }
    // The role under test now holds a stored session that the CLI no longer has.
    agents[role === "worker" ? "fake1" : "fake2"] = flaky;
    await (role === "worker" ? workerTurn(repo, agents) : reviewerTurn(repo, agents));

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Fix the flaky test.");
    expect(prompts[1]).toContain(TASK_BLOCK);
  });
}

// Usefulness: a role with no stored session id starts a new child conversation, which also gets the
// full preamble, so the init task belongs in that turn. This pins the once-per-conversation rule for
// the only way a real adapter reaches it: a first turn that failed before reporting a session.
for (const role of ["worker", "reviewer"]) {
  test(`a ${role} turn in a new conversation after a failed first turn shows the init task`, async () => {
    const repo = await startRun();
    const prompts = [];
    const failsOnce = {
      async run(state, prompt) {
        prompts.push({ sessionId: state.sessionId, prompt });
        if (prompts.length === 1) {
          throw new Error("boom before any session id");
        }
        state.sessionId = "sess-new";
        return REPORT;
      },
    };
    const agents =
      role === "worker"
        ? { fake1: failsOnce, fake2: recordingAdapter([]) }
        : { fake1: recordingAdapter([]), fake2: failsOnce };
    await workerTurn(repo, agents, INIT_OVERRIDES);
    if (role === "reviewer") {
      await reviewerTurn(repo, agents);
    }
    await (role === "worker" ? workerTurn(repo, agents) : reviewerTurn(repo, agents));

    expect(prompts.map((p) => p.sessionId)).toEqual([null, null]);
    expect(prompts[0].prompt).toContain(TASK_BLOCK);
    expect(prompts[1].prompt).toContain(TASK_BLOCK);
  });
}

// Usefulness: a turn canceled after the preamble-only turn carried the init task keeps the replaced
// conversation mark, so the resumed turn repeats the preamble (ADR 0027). The task must still reach
// that conversation once: the repeat would give one child conversation the task twice.
test("a resumed turn does not resend the init task to a replacement conversation that got it", async () => {
  const repo = await startRun();
  const worker = recordingAdapter([
    REPORT,
    (state) => {
      state.sessionId = "replacement";
      state.conversationReplaced = true;
      return REPORT;
    },
    () => {
      throw Object.assign(new Error("worker was canceled."), { isCanceled: true });
    },
  ]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  // The replaced turn runs, then the preamble-only turn in the same dispatch is canceled.
  const canceled = await workerTurn(repo, agents);
  expect(canceled.exitCode).toBe(130);
  const resumed = await workerTurn(repo, agents, ["--resume-interrupted"]);
  expect(resumed.exitCode).toBe(0);

  const prompts = worker.recorded.map((call) => call.prompt);
  expect(prompts).toHaveLength(4);
  expect(prompts[2]).toContain(TASK_BLOCK);
  expect(worker.recorded[3].incomingSessionId).toBe("replacement");
  expect(prompts[3]).toContain("You are the implementation agent");
  expect(prompts[3]).not.toContain("Fix the flaky test.");
});

const cancelTurn = () => {
  throw Object.assign(new Error("worker was canceled."), { isCanceled: true });
};

// Usefulness: the delivery record must survive every cancel of the replacement path, so a second
// cancel and the resumes after it never give the replacement conversation the task again.
test("successive cancels in a replacement conversation never resend the init task", async () => {
  const repo = await startRun();
  const worker = recordingAdapter([
    REPORT,
    (state) => {
      state.sessionId = "replacement";
      state.conversationReplaced = true;
      return REPORT;
    },
    cancelTurn, // the preamble-only turn, which carries the task
    cancelTurn, // the resumed turn that repeats the preamble
  ]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  expect((await workerTurn(repo, agents)).exitCode).toBe(130);
  expect((await workerTurn(repo, agents, ["--resume-interrupted"])).exitCode).toBe(130);
  expect((await workerTurn(repo, agents, ["--resume-interrupted"])).exitCode).toBe(0);

  const prompts = worker.recorded.map((call) => call.prompt);
  expect(prompts).toHaveLength(5);
  expect(prompts[2]).toContain(TASK_BLOCK);
  expect(prompts[3]).not.toContain("Fix the flaky test.");
  expect(prompts[4]).not.toContain("Fix the flaky test.");
});

// Usefulness: #890. A replaced reviewer conversation gets the task in the same dispatch, so a run
// that finishes on that accept never leaves the conversation without it, and a later turn does not repeat it.
test("a replaced reviewer conversation gets the init task in the same dispatch and once", async () => {
  const repo = await startRun();
  const reviewer = recordingAdapter([
    `${REPORT}
Verdict: accept`,
    (state) => {
      state.sessionId = "replacement";
      state.conversationReplaced = true;
      return `${REPORT}
Verdict: accept`;
    },
  ]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  await reviewerTurn(repo, agents);
  const replaced = await reviewerTurn(repo, agents);

  expect(replaced.exitCode).toBe(0);
  expect(replaced.payload.verdict).toBe("accept");
  const seen = reviewer.recorded.map((call) => [
    call.incomingSessionId,
    call.prompt.includes("Fix the flaky test."),
  ]);
  expect(seen).toEqual([
    [null, true],
    ["sess-1", false],
    ["replacement", true],
  ]);

  await reviewerTurn(repo, agents);
  expect(reviewer.recorded[3].prompt).not.toContain("Fix the flaky test.");
});

// Usefulness: a state file from before the task record, or one with a bad value, must not crash a
// dispatch. The record then reads as unsent, so the reviewer conversation gets the task once.
test("a state with no task record or a malformed one reads as unsent and records the delivery", async () => {
  const repo = await startRun();
  const reviewer = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  await workerTurn(repo, agents, INIT_OVERRIDES);
  await reviewerTurn(repo, agents);

  const { stateFile } = statePaths({ cwd: repo });
  for (const value of [undefined, 42]) {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (value === undefined) delete state.roles.reviewer.taskSentTo;
    else state.roles.reviewer.taskSentTo = value;
    await writeFile(stateFile, JSON.stringify(state));
    expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
    expect((await reviewerTurn(repo, agents)).exitCode).toBe(0);
  }

  const has = reviewer.recorded.map((call) => call.prompt.includes("Fix the flaky test."));
  expect(has).toEqual([true, true, false, true, false]);
});

// Usefulness: a reviewer turn that carries the task and runs in a replacement conversation delivers
// the task to that conversation, so the next turn must not send it again.
test("two consecutive reviewer replacements deliver the init task once per conversation", async () => {
  const repo = await startRun();
  const replaceWith = (id) => (state) => {
    state.sessionId = id;
    state.conversationReplaced = true;
    return `${REPORT}\nVerdict: accept`;
  };
  const reviewer = recordingAdapter([
    `${REPORT}\nVerdict: accept`,
    replaceWith("replacement-1"),
    replaceWith("replacement-2"),
  ]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  for (let turn = 0; turn < 5; turn += 1) {
    await reviewerTurn(repo, agents);
  }

  const has = reviewer.recorded.map((call) => call.prompt.includes("Fix the flaky test."));
  // The task-only turn after turn 2 carries the task into replacement-1 and runs in replacement-2.
  expect(has).toEqual([true, false, true, false, false, false]);
});

// Usefulness: the worker follows the same rule as the reviewer. A task-carrying resumed turn that
// runs in a second replacement delivers the task there, so the preamble-only turn leaves it out.
test("a worker turn that carries the init task into a replacement conversation does not repeat it", async () => {
  const repo = await startRun();
  const controller = new AbortController();
  const worker = recordingAdapter([
    REPORT,
    (state) => {
      state.sessionId = "replacement-1";
      state.conversationReplaced = true;
      controller.abort(); // ends the dispatch before the preamble-only turn
      return REPORT;
    },
    (state) => {
      state.sessionId = "replacement-2";
      state.conversationReplaced = true;
      return REPORT;
    },
  ]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  await workerTurn(repo, agents, INIT_OVERRIDES);
  const canceled = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
    signal: controller.signal,
  });
  expect(canceled.exitCode).toBe(130);
  await workerTurn(repo, agents, ["--resume-interrupted"]);
  await workerTurn(repo, agents);

  const has = worker.recorded.map((call) => call.prompt.includes("Fix the flaky test."));
  // Calls: init, replaced turn, task-carrying resume that replaces again, preamble-only, later turn.
  expect(worker.recorded).toHaveLength(5);
  expect(has).toEqual([true, false, true, false, false]);
});
