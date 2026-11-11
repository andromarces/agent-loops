import { expect, test, vi } from "vite-plus/test";
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
  waitForLaunch,
  waitForStatus,
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

// Usefulness: a blocker that settles before its dependent enters waiting still sends one event.
test("a blocker that settles first still sends one owner-merge event", async () => {
  const prepared = await waitPrepared([9, 2], { loops: 1 });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const events = [];
  const lines = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body,title")) {
        const open = args[2] === "2" ? [{ number: 9, state: "OPEN" }] : [];
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open }, body: BODY }),
          stderr: "",
        };
      }
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
  const child = childDouble({ hold: true, pr: 12 });
  const controller = new AbortController();
  let run = null;
  try {
    run = runBatch({
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
        pollIntervalMs: 1_000_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          }),
      },
    });
    await waitForLaunch(child, 0);
    await waitForStatus(runsRoot, prepared.id, 9, "running");
    expect(child.pending).toHaveLength(1);
    child.pending[0].resolve({ exitCode: 0 });
    await waitForStatus(runsRoot, prepared.id, 9, "succeeded");
    await waitForStatus(runsRoot, prepared.id, 2, "waiting");
    await pollUntil(() => events.find((event) => event.kind === "owner-merge"), 10_000);
    const merges = events.filter((event) => event.kind === "owner-merge");
    expect(merges).toHaveLength(1);
    expect(merges[0].text).toContain("issue 2");
    expect(merges[0].text).toContain("PR #12");
    const progress = lines.filter((line) => line.includes("owner merges remain"));
    expect(progress).toHaveLength(1);
    expect(progress[0]).toContain("PR #12");
  } finally {
    controller.abort();
    if (run) await run.catch(() => {});
    spy.mockRestore();
    await cleanupRepo();
  }
});

// Usefulness: only waiting loops send one owner-merge event and line, and a resume sends once more.
test("only waiting loops notify once on the default path and on resume", async () => {
  const prepared = await waitPrepared([9, 2], { loops: 2 });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const events = [];
  const lines = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  let waitReads = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body,title")) {
        const open = args[2] === "2" ? [{ number: 9, state: "OPEN" }] : [];
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open }, body: BODY }),
          stderr: "",
        };
      }
      if (args.includes("state,blockedBy")) {
        waitReads += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
          }),
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
  const notifier = async (event) => {
    events.push(event);
    return { spawned: false, ok: true };
  };
  let now = 0;
  const child = childDouble({ hold: true, pr: 12 });
  const controller = new AbortController();
  const resumeController = new AbortController();
  let run = null;
  let resume = null;
  try {
    run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms, signal) => {
          now += ms;
          if (signal?.aborted) return;
          await Promise.resolve();
        },
      },
    });
    await waitForLaunch(child, 0);
    await waitForStatus(runsRoot, prepared.id, 2, "waiting");
    expect(child.pending).toHaveLength(1);
    child.pending[0].resolve({ exitCode: 0 });
    await pollUntil(() => events.find((event) => event.kind === "owner-merge"), 10_000);
    const readsAtEvent = waitReads;
    await pollUntil(() => (waitReads >= readsAtEvent + 2 ? true : undefined), 10_000);
    const firstMerge = events.filter((event) => event.kind === "owner-merge");
    expect(firstMerge).toHaveLength(1);
    expect(firstMerge[0].text).toContain("issue 2");
    expect(firstMerge[0].text).toContain("9");
    expect(firstMerge[0].text).toContain("PR #12");
    const firstProgress = lines.filter((line) => line.includes("owner merges remain"));
    expect(firstProgress).toHaveLength(1);
    expect(firstProgress[0]).toContain("PR #12");
    controller.abort();
    await run;
    run = null;

    const resumeEvents = [];
    const resumeLines = [];
    spy.mockImplementation((chunk) => {
      resumeLines.push(String(chunk));
      return true;
    });
    resume = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          resumeEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
        signal: resumeController.signal,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms, signal) => {
          now += ms;
          if (signal?.aborted) return;
          await Promise.resolve();
        },
      },
    });
    await pollUntil(() => resumeEvents.find((event) => event.kind === "owner-merge"), 10_000);
    const resumeReads = waitReads;
    await pollUntil(() => (waitReads >= resumeReads + 2 ? true : undefined), 10_000);
    resumeController.abort();
    const { summary } = await resume;
    resume = null;
    expect(resumeEvents.filter((event) => event.kind === "owner-merge")).toHaveLength(1);
    expect(resumeLines.filter((line) => line.includes("owner merges remain"))).toHaveLength(1);
    expect(summary.status).toBe("interrupted");
  } finally {
    controller.abort();
    resumeController.abort();
    if (run) await run.catch(() => {});
    if (resume) await resume.catch(() => {});
    spy.mockRestore();
    await cleanupRepo();
  }
});
