import { expect, test } from "vite-plus/test";
import { join } from "node:path";
import { runBatch } from "../../src/batch/supervisor.mjs";
import { pollUntil } from "../wait-helpers.mjs";
import {
  BODY,
  childDouble,
  cleanupRepo,
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
        if (args.includes("state,blockedBy,body")) {
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
        if (args.includes("state,blockedBy,body")) {
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
        if (args.includes("state,blockedBy,body")) {
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
        if (args.includes("state,blockedBy,body")) {
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
