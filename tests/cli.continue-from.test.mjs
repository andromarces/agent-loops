import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see `withContinueRepo`). Every other
// test, and every other command, reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { main, parseArgs } from "../src/cli.mjs";
import { readProcessCommands } from "../src/lib/process-ancestry.mjs";
import {
  continueAgents,
  createWithContinueRepo,
  createTempRepo,
  removePath,
  createPsShim,
  symlinkOrSkip,
  within,
} from "./runtime-helpers.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// True when the process-table read of the product works on this host and lists this process.
const processTableReadable = await readProcessCommands().then(
  (table) => table.some((entry) => entry.pid === process.pid),
  () => false,
);

const CONTINUE_BASE = [
  "--orchestrator",
  "codex",
  "--worker",
  "claude",
  "--reviewer",
  "agy",
  "--task",
  "long task",
];

const CONTINUE_ROLES = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy"];

const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

const withContinueRepo = createWithContinueRepo(gitDouble);

// Each fake agent assigns a session id on its first call, as a real adapter does. It records the id
// that it held when the call arrived.
function sessionAgents(orchReplies, seen) {
  let orchCall = 0;
  const adapter = (name, reply) => ({
    async run(state, prompt) {
      seen[name].push({ sessionId: state.sessionId, prompt });
      state.sessionId ??= `${name}-session`;
      return reply(prompt);
    },
  });
  return {
    codex: adapter("codex", () => orchReplies[orchCall++]),
    claude: adapter("claude", () => "worker ok"),
    agy: adapter("agy", () => "reviewer ok"),
  };
}

// Usefulness: verifies --continue-from resumes the earlier orchestrator, worker,
// and reviewer sessions with a new step budget, and records the source (#362).
test("--continue-from resumes the earlier role sessions with a new budget", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    const review = JSON.stringify({ action: "run_reviewer", prompt: "r" });
    const seen = { codex: [], claude: [], agy: [] };
    const first = sessionAgents([work, review, work], seen);
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "2", "--transcript", transcriptPath],
      first,
    );
    expect(process.exitCode).toBe(2);
    expect(seen.codex.map((call) => call.sessionId)).toEqual([
      null,
      "codex-session",
      "codex-session",
    ]);

    const second = { codex: [], claude: [], agy: [] };
    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--max-steps",
        "3",
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([review, FINISH], second),
    );

    expect(process.exitCode).toBe(0);
    expect(second.codex[0].sessionId).toBe("codex-session");
    expect(second.codex[0].prompt).toMatch(/continues an earlier run/i);
    expect(second.agy[0].sessionId).toBe("agy-session");
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.options.continueFrom).toBe(transcriptPath);
    expect(transcript.options.maxSteps).toBe(3);
    expect(transcript.roles.worker.sessionId).toBe("claude-session");
  });
});

// Usefulness: verifies a pre-assigned worker session id is in the transcript, with its unconfirmed
// mark, before the CLI runs. A parent killed during a first turn then leaves a record that
// --continue-from resumes after the ownership check (#564). No other test reads the transcript
// mid-turn.
test("a pre-assigned session id reaches the transcript before the turn and --continue-from restores it", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    let midTurn = null;
    const agents = sessionAgents([work], { codex: [], claude: [], agy: [] });
    agents.claude = {
      async run(state, _prompt, options) {
        state.sessionUnconfirmed = true;
        await options.onSessionAssigned("pre-worker");
        midTurn = await readFile(transcriptPath, "utf8");
        throw new Error("parent killed");
      },
    };
    await main([...CONTINUE_BASE, "--cwd", repo, "--transcript", transcriptPath], agents);

    const record = JSON.parse(midTurn);
    expect(record.roles.worker).toMatchObject({
      sessionId: "pre-worker",
      sessionUnconfirmed: true,
    });
    expect(record.roles.reviewer.sessionId).toBeNull();

    // The mid-turn file is what a kill leaves behind.
    await writeFile(transcriptPath, midTurn);
    let resumed = null;
    const next = sessionAgents([work, FINISH], { codex: [], claude: [], agy: [] });
    next.claude = {
      async run(state) {
        resumed = { sessionId: state.sessionId, unconfirmed: state.sessionUnconfirmed };
        return "worker ok";
      },
    };
    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      next,
    );
    expect(resumed).toEqual({ sessionId: "pre-worker", unconfirmed: true });
  });
});

// Timeout for a --continue-from test that calls main() twice with a real Git repo. Measured per
// continueAfterEdit test (seven tests), as setup / first main() / transcript edit / second main():
// - windows-latest, run 38161410038: 0.51-0.61 s / 3.0-5.2 s / 1-3 ms / 2.9-3.2 s.
// - Local Windows 11, five runs: 0.34-2.4 s / 1.8-10.0 s / 6-30 ms / 1.8-7.0 s.
// - ubuntu-latest, same run: 22-40 ms / 134-283 ms / 0-8 ms / 148-171 ms.
// - macos-latest, same run: 67-110 ms / 348-738 ms / 1 ms / 367-458 ms.
//
// Cause: a main() runs its git calls through execa one after another, and each call costs about
// 0.04-0.06 s on windows-latest. Run 38162688022 (timing patch, since removed): a second main() ran
// 37 git calls, 2.07-2.25 s of its 2.09-2.27 s. A first main() ran 37, 45 or 61 calls (2.05-3.69
// s). Per second main(): 10 rev-parse --show-toplevel (0.54-0.60 s), 8 status, 8 ls-files and 8
// rev-parse --verify (0.43-0.53 s each).
//
// Run 38205835481 (timing patch, since removed), seven tests, on the code after #760: first main()
// 1.73-3.23 s, second main() 1.73-2.02 s. A second main() runs 10 rev-parse --show-toplevel
// (0.45-0.54 s), 8 status, 8 ls-files and 8 rev-parse --verify (0.36-0.48 s each). A first main()
// runs 10, 12 or 16 show-toplevel calls. #760 left the count unchanged: each snapshot resolves its
// own root, and no change of this PR explains the lower timings. The fs calls take 0-7 ms per call
// name.
//
// Local macOS, git shim log of the test "resets when the transcript has no gate record" (#760): the
// second main() ran 37 git calls. The 10 show-toplevel calls were 8 snapshots, 1 transcript
// containment check and 1 local-files copy. The other 27 were 8 status, 8 ls-files, 8 rev-parse
// --verify, and 1 each of --is-inside-work-tree, worktree list and --git-common-dir.
//
// The tests keep real Git, so the timeout covers this cost. The slowest run above, plus setup,
// takes about 6 s on windows-latest and up to 20 s on a slow local Windows machine. So 30 s keeps a
// margin. The #744 timeout at 15028 ms (run 38115126864) did not reproduce in these runs.
const CONTINUE_AFTER_EDIT_TIMEOUT_MS = 30_000;

// Usefulness: verifies --continue-from refuses, before any turn, a claude session that a live
// process still holds (#647), through the real process table. No other CLI test starts a holder.
test(
  "--continue-from refuses a claude session that a live process holds",
  async (ctx) => {
    // A sandbox can deny the process table (ADR 0019: `ps` exits 127 with `operation not permitted`).
    // The read then fails, the check fails open, and the run exits 0. The test fails only when the
    // read works and the refusal is missing.
    if (!processTableReadable) {
      ctx.skip("The host process table cannot be read, so the check fails open here.");
    }
    const heldId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await withContinueRepo(async (repo, transcriptPath) => {
      const work = JSON.stringify({ action: "run_worker", prompt: "w" });
      await main(
        [...CONTINUE_BASE, "--cwd", repo, "--transcript", transcriptPath],
        sessionAgents([work, FINISH], { codex: [], claude: [], agy: [] }),
      );
      const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
      transcript.roles.worker.sessionId = heldId;
      await writeFile(transcriptPath, JSON.stringify(transcript));
      // The holder passes the id through a session flag, as the adapter does.
      const holder = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60000)", "--", "--resume", heldId],
        {
          stdio: "ignore",
        },
      );
      try {
        const seen = { codex: [], claude: [], agy: [] };
        await main(
          [...CONTINUE_BASE, "--cwd", repo, "--continue-from", transcriptPath],
          sessionAgents([FINISH], seen),
        );
        expect(process.exitCode).toBe(1);
        expect(seen.codex).toEqual([]);
      } finally {
        holder.kill("SIGKILL");
      }
    });
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies the transcript carries the gate state across --continue-from through the CLI
// (#393). A reviewer accept from the first run satisfies --require-accept in the continued run on
// the unchanged tree. The continued run dispatches no reviewer.
test(
  "--continue-from restores the recorded reviewer accept on an unchanged tree",
  async () => {
    const repo = await createTempRepo();
    // Outside the work tree: a transcript inside it is an untracked file that changes the tree.
    const transcriptDir = await mkdtemp(join(tmpdir(), "cli-test-gate-transcript-"));
    const transcriptPath = join(transcriptDir, "run.json");
    const origExitCode = process.exitCode;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const accept = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";
      const reviewerCalls = [];
      const agents = (orchReplies, reviewerReply) => {
        let call = 0;
        return {
          codex: { run: async () => orchReplies[call++] },
          claude: { run: async () => "worker ok" },
          agy: {
            run: async () => {
              reviewerCalls.push(reviewerReply);
              return reviewerReply;
            },
          },
        };
      };
      const args = [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--require-accept",
        "--transcript",
        transcriptPath,
      ];
      await main(
        args,
        agents(
          [
            JSON.stringify({ action: "run_worker", prompt: "w" }),
            JSON.stringify({ action: "run_reviewer", prompt: "r" }),
            FINISH,
          ],
          accept,
        ),
      );
      expect(process.exitCode).toBe(0);
      expect(reviewerCalls.length).toBe(1);

      await main([...args, "--continue-from", transcriptPath], agents([FINISH], accept));
      expect(process.exitCode).toBe(0);
      expect(reviewerCalls.length).toBe(1);
    } finally {
      process.exitCode = origExitCode;
      logSpy.mockRestore();
      await removePath(repo);
      await removePath(transcriptDir);
    }
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies an edited transcript cannot bypass --require-accept (#393 review). A forged
// `gate` record that claims an accept is ignored, because the restore reads only the reviewer and
// worker result events. The last reviewer turn here rejected.
test(
  "--continue-from ignores a forged gate record that claims an accept",
  async () => {
    const repo = await createTempRepo();
    const transcriptDir = await mkdtemp(join(tmpdir(), "cli-test-gate-transcript-"));
    const transcriptPath = join(transcriptDir, "run.json");
    const origExitCode = process.exitCode;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reject = "Conclusion: no.\nWhy: no.\nBlockers: none.\nChecks: t\nVerdict: reject";
      const accept = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";
      const reviewerReplies = [reject, accept];
      let reviewerCalls = 0;
      const agents = (orchReplies) => {
        let call = 0;
        return {
          codex: { run: async () => orchReplies[call++] },
          claude: { run: async () => "worker ok" },
          agy: { run: async () => reviewerReplies[reviewerCalls++] },
        };
      };
      const args = [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--require-accept",
        "--transcript",
        transcriptPath,
      ];
      await main(
        args,
        agents([
          JSON.stringify({ action: "run_worker", prompt: "w" }),
          JSON.stringify({ action: "run_reviewer", prompt: "r" }),
          FINISH,
        ]),
      );
      expect(process.exitCode).toBe(1);

      const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
      const reviewed = transcript.events.findLast(
        (event) => event.type === "result" && event.role === "reviewer",
      ).result.reviewed;
      transcript.gate = {
        workerRan: true,
        reviewerRan: true,
        reviewerTurnDispatched: true,
        acceptedSinceWorker: true,
        lastReviewed: reviewed,
      };
      await writeFile(transcriptPath, JSON.stringify(transcript));

      await main(
        [...args, "--continue-from", transcriptPath],
        agents([FINISH, JSON.stringify({ action: "run_reviewer", prompt: "r" }), FINISH]),
      );
      expect(process.exitCode).toBe(0);
      expect(reviewerCalls).toBe(2);
    } finally {
      process.exitCode = origExitCode;
      logSpy.mockRestore();
      errSpy.mockRestore();
      await removePath(repo);
      await removePath(transcriptDir);
    }
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

const GATE_ACCEPT = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: t\nVerdict: accept";

const GATE_REJECT = "Conclusion: no.\nWhy: no.\nBlockers: none.\nChecks: t\nVerdict: reject";

const RUN_WORKER = JSON.stringify({ action: "run_worker", prompt: "w" });

const RUN_REVIEWER = JSON.stringify({ action: "run_reviewer", prompt: "r" });

// Runs a --require-accept headless run whose reviewer replies come from `reviewerReplies`. It lets
// `tamper(transcript)` edit the written transcript. It then continues the run with a finish that
// the gate refuses unless it restored an accept. It returns the reviewer calls of the continuation
// and the exit code. The transcript sits outside the work tree, so the tree stays unchanged.
async function continueAfterEdit({ firstOrch, reviewerReplies, tamper }) {
  const repo = await createTempRepo();
  const transcriptDir = await mkdtemp(join(tmpdir(), "cli-test-gate-transcript-"));
  const transcriptPath = join(transcriptDir, "run.json");
  const origExitCode = process.exitCode;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let reviewerCalls = 0;
    const agents = (orchReplies) => {
      let call = 0;
      return {
        codex: { run: async () => orchReplies[call++] },
        claude: { run: async () => "worker ok" },
        agy: { run: async () => reviewerReplies[reviewerCalls++] ?? GATE_ACCEPT },
      };
    };
    const args = [
      ...CONTINUE_BASE,
      "--cwd",
      repo,
      "--require-accept",
      "--transcript",
      transcriptPath,
    ];
    await main(args, agents(firstOrch));
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    tamper(transcript);
    await writeFile(transcriptPath, JSON.stringify(transcript));
    const before = reviewerCalls;
    await main(
      [...args, "--continue-from", transcriptPath],
      agents([FINISH, RUN_REVIEWER, FINISH]),
    );
    return { exitCode: process.exitCode, reviewerCalls: reviewerCalls - before };
  } finally {
    process.exitCode = origExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
    await removePath(repo);
    await removePath(transcriptDir);
  }
}

const ACCEPTED_RUN = [RUN_WORKER, RUN_REVIEWER, FINISH];

// Usefulness: verifies an incomplete later turn cancels the restore (#393 review). A worker turn
// that started after the accept and never returned a result, such as a canceled or failed turn, can
// have changed the tree. The continuation then needs a new reviewer turn.
test(
  "--continue-from resets when a worker invocation follows the accepted review",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterEdit({
      firstOrch: ACCEPTED_RUN,
      reviewerReplies: [GATE_ACCEPT],
      tamper: (transcript) => {
        const gate = transcript.events.pop();
        transcript.events.push({ type: "invocation", role: "worker", status: "error" }, gate);
      },
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies a transcript whose later reviewer result was deleted does not restore the
// earlier accept (#393 review). The recorded result count no longer matches the events.
test(
  "--continue-from resets when a result event was deleted",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterEdit({
      firstOrch: [RUN_WORKER, RUN_REVIEWER, RUN_REVIEWER, FINISH, FINISH],
      reviewerReplies: [GATE_ACCEPT, GATE_REJECT],
      tamper: (transcript) => {
        const last = transcript.events.findLastIndex((event) => event.type === "result");
        transcript.events.splice(last, 1);
      },
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies an earlier result event with an unknown role resets (#393 review). The
// replay accepts only `worker` and `reviewer` result events. The edit cannot hide the worker turn
// that makes a reviewer reject count as a review of work.
test(
  "--continue-from resets when an earlier result event has a malformed role",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterEdit({
      firstOrch: [RUN_WORKER, RUN_REVIEWER, FINISH, FINISH],
      reviewerReplies: [GATE_REJECT],
      tamper: (transcript) => {
        transcript.events.find((event) => event.type === "result" && event.role === "worker").role =
          "wrk";
      },
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies reordered reviewer results cannot let an obsolete accept replace the latest
// rejection (#393 review). The replay in file order ends on the rewritten accept. That differs from
// the state that the run recorded, so the gate resets.
test(
  "--continue-from resets when reviewer results were reordered",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterEdit({
      firstOrch: [RUN_WORKER, RUN_REVIEWER, RUN_REVIEWER, FINISH, FINISH],
      reviewerReplies: [GATE_ACCEPT, GATE_REJECT],
      tamper: (transcript) => {
        const at = transcript.events.flatMap((event, i) =>
          event.type === "result" && event.role === "reviewer" ? [i] : [],
        );
        const [a, b] = at;
        [transcript.events[a], transcript.events[b]] = [transcript.events[b], transcript.events[a]];
      },
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies a transcript with no gate record resets (#393 review), as every transcript
// did before the restore existed. This holds even when its events end on a reviewer accept.
test(
  "--continue-from resets when the transcript has no gate record",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterEdit({
      firstOrch: ACCEPTED_RUN,
      reviewerReplies: [GATE_ACCEPT],
      tamper: (transcript) => {
        transcript.events = transcript.events.filter((event) => event.type !== "gate");
      },
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Runs continueAfterEdit with `edit` applied to the last reviewer result event.
async function continueAfterResultEdit(edit) {
  return continueAfterEdit({
    firstOrch: ACCEPTED_RUN,
    reviewerReplies: [GATE_ACCEPT],
    tamper: (transcript) => {
      edit(transcript.events.findLast((e) => e.type === "result" && e.role === "reviewer").result);
    },
  });
}

// Usefulness: verifies a null reviewer response in the events the restore reads resets instead
// of aborting the run (#393 review). One edit per test keeps each inside the test timeout (#556).
test(
  "--continue-from resets, and does not abort, on a null reviewer response",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterResultEdit((result) => {
      result.response = null;
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies a reviewed head that is not a string resets instead of aborting the run
// (#393 review). Separate from the null-response case so each fits the test timeout (#556).
test(
  "--continue-from resets, and does not abort, on a non-string reviewed head",
  async () => {
    const { exitCode, reviewerCalls } = await continueAfterResultEdit((result) => {
      result.reviewed.head = { not: "a head" };
    });
    expect(exitCode).toBe(0);
    expect(reviewerCalls).toBe(1);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies a changed role kind or model is refused before any turn runs (#362). The
// refusal leaves the earlier transcript unchanged, even when --transcript names the same file.
test("--continue-from refuses a changed role and keeps the transcript", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const seen = { codex: [], claude: [], agy: [] };
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], seen),
    );
    const before = await readFile(transcriptPath, "utf8");

    const calls = { codex: [], claude: [], agy: [] };
    const changed = [
      [
        ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "codex"],
        "reviewer was agy in the earlier run, not codex",
      ],
      [
        [...CONTINUE_ROLES, "--worker-model", "opus"],
        'worker model was (omitted) in the earlier run, not "opus"',
      ],
    ];
    for (const [roleArgs, message] of changed) {
      errorSpy.mockClear();
      await main(
        [
          ...roleArgs,
          "--task",
          "long task",
          "--cwd",
          repo,
          "--continue-from",
          transcriptPath,
          "--transcript",
          transcriptPath,
        ],
        sessionAgents([FINISH], calls),
      );
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(message);
    }
    expect(calls.codex).toEqual([]);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);
  });
});

// Usefulness: verifies a CLI default that resolves to another model than the earlier run recorded
// is refused before any turn (#394). The refusal leaves the transcript unchanged. An unchanged
// model continues.
test("--continue-from refuses a changed resolved model and keeps the transcript", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    const reporting = (model, seen) => {
      const agents = sessionAgents([work, FINISH], seen);
      const run = agents.claude.run;
      agents.claude.run = async (state, prompt, options) => {
        state.resolvedModel = model;
        return run(state, prompt, options);
      };
      return agents;
    };
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      reporting("model-1", { codex: [], claude: [], agy: [] }),
    );
    const before = await readFile(transcriptPath, "utf8");
    expect(JSON.parse(before).roles.worker.resolvedModel).toBe("model-1");

    const args = [
      ...CONTINUE_BASE,
      "--cwd",
      repo,
      "--continue-from",
      transcriptPath,
      "--transcript",
      transcriptPath,
    ];
    const changed = { codex: [], claude: [], agy: [] };
    await main(args, reporting("model-2", changed));
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      'worker resolved to "model-1" in the earlier run, not "model-2"',
    );
    expect(changed.codex).toEqual([]);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);

    process.exitCode = undefined;
    await main(args, reporting("model-1", { codex: [], claude: [], agy: [] }));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(await readFile(transcriptPath, "utf8")).roles.worker.resolvedModel).toBe(
      "model-1",
    );
  });
});

// Runs a first headless run that stops on the step limit. It then records a resolved model for the
// worker in its transcript, as a Claude or Copilot turn does. `fn(repo, transcriptPath, errorSpy)`
// then continues the run.
async function withRecordedModel(fn, recordedModel = "model-1") {
  const repo = await createTempRepo();
  const transcriptPath = join(await mkdtemp(join(tmpdir(), "cli-test-probe-")), "run.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], { codex: [], claude: [], agy: [] }),
    );
    const recorded = JSON.parse(await readFile(transcriptPath, "utf8"));
    recorded.roles.worker.resolvedModel = recordedModel;
    await writeFile(transcriptPath, JSON.stringify(recorded));
    process.exitCode = undefined;
    await fn(repo, transcriptPath, errorSpy);
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    logSpy.mockRestore();
    await removePath(repo);
    await removePath(dirname(transcriptPath));
  }
}

const continueArgs = (repo, transcriptPath) => [
  ...CONTINUE_BASE,
  "--cwd",
  repo,
  "--continue-from",
  transcriptPath,
  "--transcript",
  transcriptPath,
];

// Usefulness: the resolved-model probe runs under the mutation check of a child turn (#394). A
// probe that changes the work tree halts the continuation with exit 1 before any turn. The earlier
// transcript stays whole.
test(
  "--continue-from halts when the probe changes the work tree",
  async () => {
    await withRecordedModel(async (repo, transcriptPath, errorSpy) => {
      const before = await readFile(transcriptPath, "utf8");
      const seen = { codex: [], claude: [], agy: [] };
      const agents = sessionAgents([FINISH], seen);
      agents.claude.run = async () => {
        await writeFile(join(repo, "probe-leak.txt"), "leak\n");
        return "OK";
      };
      await main(continueArgs(repo, transcriptPath), agents);
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(/mutat/i);
      expect(seen.codex).toEqual([]);
      expect(await readFile(transcriptPath, "utf8")).toBe(before);
    });
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: after a turn that named no single model (recorded null), an unchanged model B must
// not be refused (#394). A B-to-A change must not be compared against a stale A. The run continues,
// tells the operator that the check did not run, and starts no probe.
test.each([["model-1"], ["model-2"]])(
  "--continue-from compares nothing after an unresolved turn, probe would say %s",
  async (probeModel) => {
    await withRecordedModel(async (repo, transcriptPath, errorSpy) => {
      const seen = { codex: [], claude: [], agy: [] };
      const work = JSON.stringify({ action: "run_worker", prompt: "w" });
      const agents = sessionAgents([work, FINISH], seen);
      const run = agents.claude.run;
      agents.claude.run = async (state, prompt, options) => {
        state.resolvedModel = probeModel;
        return run(state, prompt, options);
      };
      await main(continueArgs(repo, transcriptPath), agents);
      // The only Claude call resumes the earlier session: no probe (a new session) ran.
      expect(seen.claude.map((call) => call.sessionId)).toEqual(["claude-session"]);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(
        /did not run for worker \(claude\), because the latest turn of the earlier run did not name one model/,
      );
      expect(errorSpy.mock.calls.flat().join("\n")).not.toMatch(/resolved to/);
    }, null);
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: a SIGINT during the probe cancels it through the signal of the run (#394). The
// continuation is refused with exit 130, before any turn, and the earlier transcript stays whole.
test(
  "--continue-from cancels a probe on SIGINT and exits 130",
  async () => {
    await withRecordedModel(async (repo, transcriptPath) => {
      const before = await readFile(transcriptPath, "utf8");
      const seen = { codex: [], claude: [], agy: [] };
      const agents = sessionAgents([FINISH], seen);
      let probeSignal;
      agents.claude.run = async (_state, _prompt, options) => {
        probeSignal = options.signal;
        process.emit("SIGINT");
        const err = new Error("canceled");
        err.isCanceled = true;
        throw err;
      };
      const listenersBefore = process.listenerCount("SIGINT");
      await main(continueArgs(repo, transcriptPath), agents);
      expect(process.exitCode).toBe(130);
      expect(probeSignal?.aborted).toBe(true);
      expect(seen.codex).toEqual([]);
      expect(await readFile(transcriptPath, "utf8")).toBe(before);
      expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
    });
  },
  CONTINUE_AFTER_EDIT_TIMEOUT_MS,
);

// Usefulness: verifies a real SIGINT during a stalled process-table read ends the continued run
// with exit 130 before any turn (#647). It also ends the shim of the read, so the holder check
// cannot defeat cancellation. A child process is needed, because a real signal exercises the exit
// handler of execa.
test.skipIf(process.platform === "win32")(
  "--continue-from exits 130 on SIGINT during a stalled holder check",
  async () => {
    const shim = await createPsShim("__STALL__");
    let repo;
    let child;
    try {
      repo = await createTempRepo();
      const role = (kind, sessionId) => ({ kind, model: null, effort: null, sessionId });
      const transcript = join(shim.dir, "run.json");
      await writeFile(
        transcript,
        JSON.stringify({
          task: "long task",
          cwd: repo,
          roles: {
            orchestrator: role("codex", null),
            worker: role("claude", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
            reviewer: role("agy", null),
          },
          events: [],
        }),
      );
      child = spawn(
        process.execPath,
        [CLI, ...CONTINUE_BASE, "--cwd", repo, "--continue-from", transcript],
        {
          env: { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH}` },
          stdio: "ignore",
        },
      );
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      // The shim beats only after the read started, so the signal cancels a running read.
      await shim.ready();
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 15_000, "The CLI exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      // The cancel ends the shim before its 10 s ceiling (11.2 s at most).
      expect(await shim.heartbeatStopped()).toBe(true);
    } finally {
      // Ends only the child that this test spawned, through its handle, when it still runs.
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await shim.cleanup();
      if (repo) {
        await removePath(repo);
      }
    }
  },
  30_000,
);

// Usefulness: verifies --continue-from takes a value, in both forms.
test("--continue-from requires a value and accepts the inline form", () => {
  expect(() => parseArgs([...CONTINUE_BASE, "--continue-from"])).toThrow();
  expect(parseArgs([...CONTINUE_BASE, "--continue-from=run.json"]).continueFrom).toMatch(
    /run\.json$/,
  );
  expect(parseArgs(CONTINUE_BASE).continueFrom).toBeNull();
});

// Usefulness: verifies a continuation whose --transcript names the --continue-from
// file keeps every earlier event, in order, and appends the new ones after them
// (#362 review). The earlier run's outcome is kept in a boundary event.
test("--continue-from with the same --transcript path keeps the earlier events", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    const review = JSON.stringify({ action: "run_reviewer", prompt: "r" });
    const seen = { codex: [], claude: [], agy: [] };
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], seen),
    );
    const earlier = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(earlier.exitCode).toBe(2);
    expect(earlier.events.length).toBeGreaterThan(0);

    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--max-steps",
        "2",
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([review, FINISH], { codex: [], claude: [], agy: [] }),
    );

    const after = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(after.events.slice(0, earlier.events.length)).toEqual(earlier.events);
    const boundary = after.events[earlier.events.length];
    expect(boundary).toMatchObject({
      type: "continued",
      earlier: { exitCode: 2, error: "Step limit reached with work remaining." },
    });
    expect(after.events.slice(earlier.events.length + 1).map((event) => event.type)).toContain(
      "result",
    );
    expect(after.exitCode).toBe(0);
  });
});

// Usefulness: verifies a different --transcript path holds only the new run's events.
test("--continue-from with another --transcript path records only the new events", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], { codex: [], claude: [], agy: [] }),
    );
    const next = join(repo, "next.json");
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--continue-from", transcriptPath, "--transcript", next],
      sessionAgents([FINISH], { codex: [], claude: [], agy: [] }),
    );
    const after = JSON.parse(await readFile(next, "utf8"));
    expect(after.events.some((event) => event.type === "continued")).toBe(false);
  });
});

// Usefulness: verifies a large earlier event is read and kept whole by a same-path
// continuation: no size limit, truncation, or split (#362 review).
test("--continue-from keeps a large earlier event whole", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const work = JSON.stringify({ action: "run_worker", prompt: "w" });
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", transcriptPath],
      sessionAgents([work, work], { codex: [], claude: [], agy: [] }),
    );
    const earlier = JSON.parse(await readFile(transcriptPath, "utf8"));
    const big = `${"x".repeat(8 * 1024 * 1024)}\n${"é😀".repeat(1000)}end`;
    earlier.events.push({ type: "result", role: "worker", result: { response: big }, at: "t" });
    await writeFile(transcriptPath, JSON.stringify(earlier, null, 2), "utf8");

    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([FINISH], { codex: [], claude: [], agy: [] }),
    );

    const after = JSON.parse(await readFile(transcriptPath, "utf8"));
    const kept = after.events[earlier.events.length - 1];
    expect(kept.result.response.length).toBe(big.length);
    expect(kept.result.response === big).toBe(true);
  });
});

// Well above the smallest spread that threw in a standalone bisection of
// [].push(...list, {}): 124,862 elements on Node v26.8.1 and 125,217 on Node
// v22.23.3. With a spread restored at the call site in src/cli.mjs, this test
// failed on both versions at this count.
const EARLIER_EVENTS = 500_000;

// Usefulness: verifies a same-path continuation reads a written transcript with more events than an
// argument spread can pass. It rewrites the transcript with every earlier event in order, then the
// boundary event. The earlier transcript is written directly, so one run of the real read-and-write
// path is all the test pays for.
test("--continue-from rewrites a large written transcript with every earlier event", async () => {
  await withContinueRepo(async (repo, transcriptPath) => {
    const role = (kind) => ({ kind, model: null, effort: null, sessionId: "s" });
    const events = Array.from({ length: EARLIER_EVENTS }, (_, index) => ({
      type: "e",
      index,
    }));
    await writeFile(
      transcriptPath,
      JSON.stringify({
        task: "long task",
        cwd: repo,
        options: { maxSteps: 1 },
        roles: { orchestrator: role("codex"), worker: role("claude"), reviewer: role("agy") },
        events,
        exitCode: 2,
        error: "Step limit reached with work remaining.",
      }),
      "utf8",
    );

    await main(
      [
        ...CONTINUE_BASE,
        "--cwd",
        repo,
        "--continue-from",
        transcriptPath,
        "--transcript",
        transcriptPath,
      ],
      sessionAgents([FINISH], { codex: [], claude: [], agy: [] }),
    );

    expect(process.exitCode).toBe(0);
    const after = JSON.parse(await readFile(transcriptPath, "utf8"));
    const count = EARLIER_EVENTS;
    expect(after.events[0].index).toBe(0);
    expect(after.events[count - 1].index).toBe(count - 1);
    expect(after.events[count].type).toBe("continued");
    expect(after.events.length).toBeGreaterThan(count + 1);
  });
});

async function expectEarlierEventsSurvive(ctx, linkRole) {
  const repo = await createTempRepo();
  const out = await mkdtemp(join(tmpdir(), "continue-link-"));
  const origExitCode = process.exitCode;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const real = join(out, "run.json");
    const link = join(out, "alias.json");
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--max-steps", "1", "--transcript", real],
      continueAgents([RUN_WORKER, RUN_WORKER]),
    );
    const earlier = JSON.parse(await readFile(real, "utf8")).events;
    expect(earlier.length).toBeGreaterThan(0);
    await symlinkOrSkip(ctx, "run.json", link);

    const [from, to] = linkRole === "link" ? [real, link] : [link, real];
    await main(
      [...CONTINUE_BASE, "--cwd", repo, "--continue-from", from, "--transcript", to],
      continueAgents([FINISH]),
    );

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const later = JSON.parse(await readFile(real, "utf8")).events;
    expect(later.length).toBeGreaterThan(earlier.length);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
  } finally {
    process.exitCode = origExitCode;
    vi.restoreAllMocks();
    await Promise.all([removePath(repo), removePath(out)]);
  }
}

// Usefulness: verifies a --transcript link to the --continue-from file keeps the link, writes the target, and carries the earlier events (#658); the rewrite replaced the link before.
test("--transcript names a link to the --continue-from file: link kept, earlier events survive", (ctx) =>
  expectEarlierEventsSurvive(ctx, "link"));

// Usefulness: verifies a --continue-from link to the --transcript file counts as the same file, so the rewrite carries the earlier events instead of dropping them (#658).
test("--continue-from names a link to the --transcript file: earlier events survive", (ctx) =>
  expectEarlierEventsSurvive(ctx, "source"));
