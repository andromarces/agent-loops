import { expect, test } from "vite-plus/test";
import { join } from "node:path";
import { readBatchStatus } from "../../src/batch/status.mjs";
import { updateLoop } from "../../src/batch/store.mjs";
import { runBatch } from "../../src/batch/supervisor.mjs";
import { pollUntil } from "../wait-helpers.mjs";
import {
  BODY,
  childDouble,
  cleanupRepo,
  fakeGh,
  fakeGitDeps,
  waitPrepared,
} from "./supervisor-helpers.mjs";

// Usefulness: the notifier receives one event for a decision, one for a merge, one for completion.
test("the notifier receives decision, merge, and completion events", async () => {
  const decisionEvents = [];
  const first = await waitPrepared([1]);
  const firstRoot = join(first.workTreeRoot, "runs");
  const firstChild = childDouble();
  try {
    await runBatch({
      prepared: first,
      runsRoot: firstRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          decisionEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: firstChild.spawn,
        installSignal: false,
      },
    });
    await updateLoop(firstRoot, first.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the state",
      pid: null,
      startTime: null,
    }));
    await runBatch({
      prepared: { ...first, resume: true },
      runsRoot: firstRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          decisionEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(decisionEvents.some((event) => event.kind === "decision")).toBe(true);

    const completionEvents = [];
    const second = await waitPrepared([1]);
    await runBatch({
      prepared: second,
      runsRoot: join(second.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          completionEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(completionEvents.some((event) => event.kind === "batch-completed")).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a waiting issue sends one merge-required notification when the blockers first appear.
test("a waiting issue sends a merge-required notification", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const events = [];
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
  const child = childDouble();
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          }),
      },
    });
    await pollUntil(() => events.find((event) => event.kind === "merge-required"), 10_000);
    controller.abort();
    await run;
    const merge = events.filter((event) => event.kind === "merge-required");
    expect(merge).toHaveLength(1);
    expect(merge[0].text).toContain("9");
    expect(child.calls).toHaveLength(0);
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0].requiredMerges).toEqual([9]);
    expect(status.completion).toEqual({ status: "interrupted", complete: false });
  } finally {
    await cleanupRepo();
  }
});
