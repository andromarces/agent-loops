import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { answerDecision } from "../../src/batch/decisions.mjs";
import { readLoop, updateLoop } from "../../src/batch/store.mjs";
import { runBatch } from "../../src/batch/supervisor.mjs";
import { pollUntil } from "../wait-helpers.mjs";
import {
  BODY,
  childDouble,
  cleanupRepo,
  fakeGh,
  fakeGitDeps,
  noNotify,
  waitPrepared,
} from "./supervisor-helpers.mjs";

// Usefulness: a blocked issue waits on the monotonic poll and launches after its blockers close.
test("a blocked issue waits on the poll and launches after its blockers close", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let blockedReads = 0;
  let polls = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.some((arg) => arg.includes("blockedBy"))) {
        blockedReads += 1;
        const open = blockedReads <= 2 ? [{ number: 9, state: "OPEN" }] : [];
        if (args.includes("state,blockedBy,body,title")) {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open }, body: BODY }),
            stderr: "",
          };
        }
        if (args.includes("state,blockedBy")) {
          polls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open } }),
            stderr: "",
          };
        }
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: open } }), stderr: "" };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  let now = 0;
  const child = childDouble();
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(child.calls).toHaveLength(1);
    expect(exitCode).toBe(0);
    expect(summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a failed poll read warns, launches nothing, and retries on the next poll.
test("a failed poll read retries on the next poll", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let waitReads = 0;
  let blockedReads = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        waitReads += 1;
        if (waitReads === 1) return { status: 1, timedOut: true, stdout: "", stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        blockedReads += 1;
        const open = blockedReads === 1 ? [{ number: 9, state: "OPEN" }] : [];
        if (args.includes("state,blockedBy,body,title")) {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open }, body: BODY }),
            stderr: "",
          };
        }
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: open } }), stderr: "" };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  let now = 0;
  const child = childDouble();
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(waitReads).toBeGreaterThanOrEqual(2);
    expect(child.calls).toHaveLength(1);
    expect(summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an issue closed while it waits is reported as skipped and launches no child.
test("a closed issue while waiting is skipped and not launched", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let blockedReads = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "CLOSED", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        blockedReads += 1;
        if (args.includes("state,blockedBy,body,title")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
              body: BODY,
            }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  let now = 0;
  const child = childDouble();
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(child.calls).toHaveLength(0);
    expect(exitCode).toBe(0);
    expect(summary.loops[0]).toMatchObject({ status: "skipped", skipReason: "closed" });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an abort during a poll wait ends the batch as interrupted with no child.
test("an abort during a poll wait exits 130", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        if (args.includes("state,blockedBy,body,title")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
              body: BODY,
            }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const child = childDouble();
  const controller = new AbortController();
  let polling = false;
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) => {
          polling = true;
          return new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
        },
      },
    });
    await pollUntil(() => (polling ? true : undefined), 10_000);
    controller.abort();
    const { exitCode, summary } = await run;
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(child.calls).toHaveLength(0);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a poll read carries a timeout and the abort signal.
test("a poll read carries a timeout and the abort signal", async () => {
  const prepared = await waitPrepared([211]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let pollOptions = null;
  const gh = (args, cwd, options) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        pollOptions = options;
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
          }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        if (args.includes("state,blockedBy,body,title")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
              body: BODY,
            }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const child = childDouble();
  const controller = new AbortController();
  const run = runBatch({
    prepared,
    runsRoot,
    gh,
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: child.spawn,
      installSignal: false,
      signal: controller.signal,
      pollIntervalMs: 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  });
  await pollUntil(() => pollOptions ?? undefined, 10_000);
  controller.abort();
  await run;
  expect(pollOptions).not.toBeNull();
  expect(typeof pollOptions.timeoutMs).toBe("number");
  expect(pollOptions.timeoutMs).toBeGreaterThan(0);
  expect(pollOptions.signal).toBeInstanceOf(AbortSignal);
  expect(child.calls).toHaveLength(0);
});

// Usefulness: a caller cancel keeps its own reason object through the poll.
test("a caller cancel keeps its reason identity", async () => {
  const prepared = await waitPrepared([212]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
          }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        if (args.includes("state,blockedBy,body,title")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
              body: BODY,
            }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const reason = { code: "operator-cancel" };
  let seen = null;
  let polling = false;
  const controller = new AbortController();
  const child = childDouble();
  const run = runBatch({
    prepared,
    runsRoot,
    gh,
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: child.spawn,
      installSignal: false,
      signal: controller.signal,
      pollIntervalMs: 60_000,
      sleep: (ms, signal) => {
        polling = true;
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              seen = signal.reason;
              resolve();
            },
            { once: true },
          );
        });
      },
    },
  });
  await pollUntil(() => (polling ? true : undefined), 10_000);
  controller.abort(reason);
  const { exitCode } = await run;
  expect(exitCode).toBe(130);
  expect(seen).toBe(reason);
});

// Usefulness: parallel wait reads keep the manifest order when the second read finishes first.
test("parallel wait reads keep the manifest order", async () => {
  const prepared = await waitPrepared([301, 302]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh({ closed: new Set([301, 302]) }),
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: childDouble().spawn,
      installSignal: false,
    },
  });
  for (const issue of [301, 302]) {
    await updateLoop(runsRoot, prepared.id, issue, (loop) => ({
      ...loop,
      status: "waiting",
      reason: null,
      skipReason: "blocked",
      blockingIssues: [],
      pid: null,
      startTime: null,
    }));
  }
  let inFlight = 0;
  let maxInFlight = 0;
  const events = [];
  const controller = new AbortController();
  const gh = async (args) => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("state,blockedBy")) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const issue = Number(args[2]);
      await new Promise((resolve) => setTimeout(resolve, issue === 301 ? 60 : 10));
      inFlight -= 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const result = await runBatch({
    prepared: { ...prepared, resume: true },
    runsRoot,
    gh,
    deps: {
      ...fakeGitDeps,
      notifier: async (event) => {
        if (event.kind === "merge-required") events.push(event.text);
        if (events.length === 2) controller.abort();
        return { spawned: false, ok: true };
      },
      spawn: childDouble().spawn,
      installSignal: false,
      signal: controller.signal,
      pollIntervalMs: 10,
    },
  });
  expect(maxInFlight).toBe(2);
  expect(events).toHaveLength(2);
  expect(events[0]).toContain("issue 301");
  expect(events[1]).toContain("issue 302");
  expect(result.summary.status).toBe("interrupted");
});

// Usefulness: an abort during parallel wait reads keeps the cancel result and its reason.
test("an abort during parallel wait reads keeps the cancel result", async () => {
  const prepared = await waitPrepared([303, 304]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh({ closed: new Set([303, 304]) }),
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: childDouble().spawn,
      installSignal: false,
    },
  });
  for (const issue of [303, 304]) {
    await updateLoop(runsRoot, prepared.id, issue, (loop) => ({
      ...loop,
      status: "waiting",
      reason: null,
      skipReason: "blocked",
      blockingIssues: [],
      pid: null,
      startTime: null,
    }));
  }
  let started = 0;
  let startedBeforeAbort = 0;
  let seenReason = null;
  const reason = { code: "operator-cancel" };
  const controller = new AbortController();
  const gh = (args, cwd, options) => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("state,blockedBy")) {
      started += 1;
      return new Promise((resolve) => {
        const done = () => {
          seenReason = options.signal.reason;
          resolve({
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
            }),
            stderr: "",
          });
        };
        if (options.signal.aborted) done();
        else options.signal.addEventListener("abort", done, { once: true });
      });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const run = runBatch({
    prepared: { ...prepared, resume: true },
    runsRoot,
    gh,
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: childDouble().spawn,
      installSignal: false,
      signal: controller.signal,
      pollIntervalMs: 10,
    },
  });
  for (let attempt = 0; attempt < 100 && started < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  startedBeforeAbort = started;
  controller.abort(reason);
  const { exitCode, summary } = await run;
  expect(startedBeforeAbort).toBe(2);
  expect(exitCode).toBe(130);
  expect(summary.status).toBe("interrupted");
  expect(seenReason).toBe(reason);
});

// Usefulness: one repository read serves every issue launch in a batch.
test("one repository read serves every issue launch", async () => {
  const prepared = await waitPrepared([305, 306]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let repositoryReads = 0;
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 99, closingIssuesReferences: [], headRefName: "b" }]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      repositoryReads += 1;
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "api") return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body,title")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] }, body: BODY }),
          stderr: "",
        };
      }
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
    }
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const result = await runBatch({
    prepared,
    runsRoot,
    gh,
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: childDouble().spawn,
      installSignal: false,
    },
  });
  expect(repositoryReads).toBe(1);
  expect(result.summary.loops).toHaveLength(2);
});

// Usefulness: a child result during a wait read keeps needs-owner and its stored answer.
test("a child result during a wait read keeps needs-owner", async () => {
  const prepared = await waitPrepared([401, 402]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ hold: true });
  const second = childDouble();
  const controller = new AbortController();
  let triggered = false;
  let waitReads = 0;
  const gh = async (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body,title")) {
        const issue = Number(args[2]);
        const blocked = issue === 402 ? [{ number: 9, state: "OPEN" }] : [];
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: blocked }, body: BODY }),
          stderr: "",
        };
      }
      if (args.includes("state,blockedBy")) {
        waitReads += 1;
        if (!triggered) {
          triggered = true;
          await first.calls[0].written;
          const transcript = first.calls[0].transcript;
          const data = JSON.parse(await readFile(transcript, "utf8"));
          await writeFile(transcript, JSON.stringify({ ...data, exitCode: 130 }));
          for (const pending of first.pending) pending.resolve({ exitCode: 4 });
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const loop = await readLoop(runsRoot, prepared.id, 401);
            if (loop?.status === "needs-owner" && typeof loop.decision === "string") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
          }),
          stderr: "",
        };
      }
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const run = runBatch({
    prepared,
    runsRoot,
    gh,
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: (options) => (first.calls.length === 0 ? first.spawn(options) : second.spawn(options)),
      installSignal: false,
      signal: controller.signal,
      pollIntervalMs: 20,
    },
  });
  try {
    for (let attempt = 0; attempt < 200 && first.calls.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(first.calls).toHaveLength(1);
    let loop = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      loop = await readLoop(runsRoot, prepared.id, 401);
      if (loop?.status === "needs-owner" && typeof loop.decision === "string") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(loop?.status).toBe("needs-owner");
    for (let attempt = 0; attempt < 200 && waitReads < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waitReads).toBeGreaterThanOrEqual(2);
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: loop.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    for (let attempt = 0; attempt < 200 && second.calls.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(second.calls).toHaveLength(1);
  } finally {
    controller.abort();
    for (const pending of first.pending) pending.resolve({ exitCode: 130 });
    await run;
  }
});
