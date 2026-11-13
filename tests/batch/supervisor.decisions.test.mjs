import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import {
  UNVERIFIED_STEPS_OPTIONS,
  answerDecision,
  createDecision,
  newDecisionId,
  readDecision,
} from "../../src/batch/decisions.mjs";
import { batchPaths, readLoop, updateLoop, updateManifest } from "../../src/batch/store.mjs";
import { newBatchId, runBatch } from "../../src/batch/supervisor.mjs";
import { tryStateLock } from "../../src/lib/state-lock.mjs";
import { removePath } from "../fs-helpers.mjs";
import { pollUntil, within } from "../wait-helpers.mjs";
import {
  BODY,
  batchRepo,
  childDouble,
  deferred,
  fakeGh,
  fakeGitDeps,
  noNotify,
  preparedFor,
  waitForLaunch,
  waitForStatus,
} from "./supervisor-helpers.mjs";

describe("batch decisions and waits", () => {
  let shared;
  beforeAll(async () => {
    const repo = await batchRepo();
    shared = await preparedFor(repo, [1]);
  });

  const prep = (issues, overrides = {}) => ({
    ...shared,
    id: newBatchId(),
    issues,
    loops: overrides.loops ?? issues.length,
    ...overrides,
  });
  const runsFor = (prepared) => join(shared.workTreeRoot, `runs-${prepared.id}`);

  async function setNeedsOwner(
    runsRoot,
    prepared,
    issue,
    { reason, attempts = 1, decision, pid = null, startTime = null, decisionAnswer = null },
  ) {
    await updateLoop(runsRoot, prepared.id, issue, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason,
      attempts,
      decision: decision ?? null,
      decisionAnswer,
      pid,
      startTime,
      skipReason: null,
    }));
  }

  async function makeDecision(runsRoot, prepared, issue, { reason, attempts = 1 }) {
    const id = newDecisionId(prepared.id, issue, attempts, reason);
    await createDecision({
      runsRoot,
      batchId: prepared.id,
      id,
      issue,
      attempt: attempts,
      reason,
      evidence: reason,
    });
    return id;
  }

  // Usefulness: a live answer keeps its identity and never launches or releases the claim.
  test("a live answer on a resumed loop never launches", async () => {
    const prepared = prep([201]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([201]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a live state";
    const decision = await makeDecision(runsRoot, prepared, 201, { reason });
    await setNeedsOwner(runsRoot, prepared, 201, {
      reason,
      decision,
      pid: process.pid,
    });
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: decision,
      option: "abandon",
    });
    expect(answered.ok).toBe(true);
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    expect(resumed.summary.status).toBe("waiting");
    const loop = await readLoop(runsRoot, prepared.id, 201);
    expect(loop.pid).toBe(process.pid);
    expect(loop.status).toBe("needs-owner");
  });

  // Usefulness: an unverified-steps decision lists no resume option that relaunches.
  test("an unverified-steps decision lists no resume option", async () => {
    const prepared = prep([202]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await setNeedsOwner(runsRoot, prepared, 202, {
      reason: "unverified-steps",
      attempts: 1,
    });
    await removePath(batchPaths(runsRoot).transcript(prepared.id, 202));
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    const loop = await readLoop(runsRoot, prepared.id, 202);
    const decision = await readDecision(runsRoot, prepared.id, loop.decision);
    expect(decision.ok).toBe(true);
    expect(decision.decision.options.map((option) => option.key)).toEqual(["abandon", "skip"]);
    expect(decision.decision.recommended).toBe("abandon");
    const refused = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: loop.decision,
      option: "resume",
    });
    expect(refused.ok).toBe(false);
    expect(resumed.summary.status).toBe("waiting");
  });

  // Usefulness: a waiting issue takes a free slot while another child still runs.
  test("a waiting issue launches while another child runs", async () => {
    const prepared = prep([203, 204], { loops: 2 });
    const runsRoot = runsFor(prepared);
    let blockedReads = 0;
    const gh = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        const issue = Number(args[2]);
        if (args.includes("state,blockedBy")) {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
            stderr: "",
          };
        }
        if (args.some((arg) => arg.includes("blockedBy"))) {
          blockedReads += issue === 203 ? 1 : 0;
          const open = issue === 203 && blockedReads === 1 ? [{ number: 9, state: "OPEN" }] : [];
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
    const child = childDouble({ hold: true });
    const run = runBatch({
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
    try {
      await waitForLaunch(child, 1);
      expect(child.calls).toHaveLength(2);
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
      await run;
    } finally {
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a held child's gate is resolvable from `pending` as soon as its call is visible.
  // So a case that waits for the call cannot hang on a gate that a delayed transcript write hides.
  test("a held child's gate is reachable before its transcript write", async () => {
    const prepared = prep([220]);
    const runsRoot = runsFor(prepared);
    const write = deferred();
    const child = childDouble({ hold: true, beforeWrite: () => write.promise });
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    try {
      await pollUntil(() => child.calls[0], 10_000);
      expect(child.calls).toHaveLength(1);
      expect(child.pending).toHaveLength(1);
      child.pending[0].resolve({ exitCode: 0 });
      write.resolve();
      const { exitCode } = await run;
      expect(exitCode).toBe(0);
    } finally {
      write.resolve();
      for (const call of child.calls) call.gate?.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a new owner stop after an applied answer creates a new decision id.
  test("a new stop after an applied answer creates a new decision", async () => {
    const prepared = prep([205]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "the recorded work tree is missing";
    const first = await makeDecision(runsRoot, prepared, 205, { reason });
    await setNeedsOwner(runsRoot, prepared, 205, { reason, decision: first });
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: first,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    await setNeedsOwner(runsRoot, prepared, 205, {
      reason,
      decision: first,
      decisionAnswer: "resume",
    });
    const transcript = batchPaths(runsRoot).transcript(prepared.id, 205);
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 130 }));
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        reconcileLoop: async () => ({
          status: "needs-owner",
          reason: "the recorded work tree is missing",
          pr: null,
          requireCi: null,
        }),
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const loop = await readLoop(runsRoot, prepared.id, 205);
    expect(loop.status).toBe("needs-owner");
    expect(loop.decision).not.toBe(first);
    expect((await readDecision(runsRoot, prepared.id, loop.decision)).ok).toBe(true);
    expect(resumed.summary.status).toBe("waiting");
  });

  // Usefulness: a live answer updates the status and completes the batch once.
  test("a live abandon answer completes the batch", async () => {
    const prepared = prep([206, 207], { loops: 2 });
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([206, 207]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a live decision";
    const decision = await makeDecision(runsRoot, prepared, 206, { reason });
    await setNeedsOwner(runsRoot, prepared, 206, { reason, decision });
    await updateLoop(runsRoot, prepared.id, 207, (loop) => ({
      ...loop,
      status: "queued",
      attempts: 0,
      workTree: null,
      pid: null,
      startTime: null,
    }));
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "waiting",
      completionNotified: false,
    }));
    const events = [];
    const child = childDouble({ hold: true });
    const run = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 50,
      },
    });
    try {
      await waitForLaunch(child);
      expect(child.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: decision,
        option: "abandon",
      });
      expect(answered.ok).toBe(true);
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
      const { exitCode, summary } = await run;
      expect(exitCode).toBe(1);
      expect(summary.status).toBe("failed");
      expect(summary.loops[0].status).toBe("failed");
      expect(summary.loops[1].status).toBe("succeeded");
      expect(events.filter((event) => event.kind === "batch-completed")).toHaveLength(1);
    } finally {
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
    }
  });

  // Usefulness: a malformed decision isolates its loop and keeps the queue running.
  test("a malformed decision isolates its loop", async () => {
    const prepared = prep([208, 209], { loops: 2 });
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([208, 209]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await setNeedsOwner(runsRoot, prepared, 208, {
      reason: "unverified-steps",
      attempts: 1,
    });
    await updateLoop(runsRoot, prepared.id, 209, (loop) => ({
      ...loop,
      status: "queued",
      attempts: 0,
      workTree: null,
      pid: null,
      startTime: null,
    }));
    const broken = newDecisionId(prepared.id, 208, 1, "unverified-steps");
    await mkdir(batchPaths(runsRoot).decisions(prepared.id), { recursive: true });
    await writeFile(batchPaths(runsRoot).decision(prepared.id, broken), "{");
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(1);
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
    expect(resumed.summary.loops[0].reason).toContain("unreadable");
    expect(resumed.summary.loops[1].status).toBe("succeeded");
  });

  // Usefulness: a resume of only an unanswered decision writes nothing.
  test("a resume of only an unanswered decision writes nothing", async () => {
    const prepared = prep([210]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a waiting state";
    const decision = await makeDecision(runsRoot, prepared, 210, { reason });
    await setNeedsOwner(runsRoot, prepared, 210, { reason, decision });
    await updateManifest(runsRoot, prepared.id, (value) => ({ ...value, status: "waiting" }));
    const manifestFile = batchPaths(runsRoot).manifest(prepared.id);
    const loopFile = batchPaths(runsRoot).loop(prepared.id, 210);
    const beforeManifest = await stat(manifestFile, { bigint: true });
    const beforeLoop = await stat(loopFile, { bigint: true });
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    expect(resumed.summary.status).toBe("waiting");
    expect((await stat(manifestFile, { bigint: true })).mtimeNs).toBe(beforeManifest.mtimeNs);
    expect((await stat(loopFile, { bigint: true })).mtimeNs).toBe(beforeLoop.mtimeNs);
  });

  // Usefulness: every malformed transcript refusal matches the origin text on an attempted loop.
  test("malformed transcripts keep the origin refusal text", async () => {
    const cases = [
      ["missing", null, "the transcript is missing"],
      ["empty", "", "the transcript is missing"],
      ["invalid", "{", "the transcript is missing"],
      ["null", "null", "the transcript is missing"],
      ["non-object", "[]", "the transcript holds no event list"],
      ["no-events", "{}", "the transcript holds no event list"],
    ];
    const issues = cases.map((_, index) => 501 + index);
    const prepared = prep(issues);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set(issues) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    for (let index = 0; index < cases.length; index += 1) {
      const issue = issues[index];
      const transcript = batchPaths(runsRoot).transcript(prepared.id, issue);
      await updateLoop(runsRoot, prepared.id, issue, (loop) => ({
        ...loop,
        status: "interrupted",
        reason: "interrupted",
        skipReason: null,
        attempts: 1,
        transcript,
        pid: null,
        startTime: null,
      }));
      const content = cases[index][1];
      if (content === null) await removePath(transcript);
      else await writeFile(transcript, content);
    }
    await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    for (let index = 0; index < cases.length; index += 1) {
      const loop = await readLoop(runsRoot, prepared.id, issues[index]);
      expect(loop.status).toBe("needs-owner");
      const decision = await readDecision(runsRoot, prepared.id, loop.decision);
      expect(decision?.ok).toBe(true);
      expect(decision.decision.evidence).toBe(cases[index][2]);
    }
  });

  // Usefulness: a recorded live child holds its only slot until the process dies.
  test("a recorded live child holds its slot until it dies", async () => {
    const prepared = prep([213, 214], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const live = execa(process.execPath, ["-e", "setTimeout(() => {}, 8000)"]);
    live.catch(() => {});
    try {
      await runBatch({
        prepared,
        runsRoot,
        gh: fakeGh({ closed: new Set([213, 214]) }),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: childDouble().spawn,
          installSignal: false,
        },
      });
      const reason = "a live decision";
      const decision = await makeDecision(runsRoot, prepared, 213, { reason });
      await setNeedsOwner(runsRoot, prepared, 213, { reason, decision, pid: live.pid });
      await updateLoop(runsRoot, prepared.id, 214, (loop) => ({
        ...loop,
        status: "queued",
        attempts: 0,
        workTree: null,
        pid: null,
        startTime: null,
      }));
      const child = childDouble({ hold: true });
      const firstPoll = deferred();
      const run = runBatch({
        prepared: { ...prepared, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: child.spawn,
          installSignal: false,
          pollIntervalMs: 50,
          sleep: async (ms, signal) => {
            firstPoll.resolve();
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, ms);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          },
        },
      });
      try {
        await within(firstPoll.promise, 10_000, "the first poll wait");
        expect(child.calls).toHaveLength(0);
        live.kill("SIGKILL");
        await waitForLaunch(child);
        expect(child.calls).toHaveLength(1);
        for (const pending of child.pending) pending.resolve({ exitCode: 0 });
        await run;
      } finally {
        for (const pending of child.pending) pending.resolve({ exitCode: 0 });
        await run.catch(() => {});
      }
    } finally {
      live.kill("SIGKILL");
    }
  });

  // Usefulness: a resume after an abandon finalizes the batch and sends one completion.
  test("a resume after an abandon finalizes the batch", async () => {
    const prepared = prep([215]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([215]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a stopped state";
    const decision = await makeDecision(runsRoot, prepared, 215, { reason });
    await setNeedsOwner(runsRoot, prepared, 215, { reason, decision });
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "waiting",
      completionNotified: false,
    }));
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: decision,
      option: "abandon",
    });
    expect(answered.ok).toBe(true);
    const events = [];
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.status).toBe("failed");
    expect(resumed.summary.loops[0].status).toBe("failed");
    expect(events.filter((event) => event.kind === "batch-completed")).toHaveLength(1);
  });

  // Usefulness: a resume after a skip finalizes the batch as complete with one notification.
  test("a resume after a skip finalizes the batch", async () => {
    const prepared = prep([216]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([216]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const id = newDecisionId(prepared.id, 216, 1, "unverified-steps");
    await createDecision({
      runsRoot,
      batchId: prepared.id,
      id,
      issue: 216,
      attempt: 1,
      reason: "unverified-steps",
      evidence: "the transcript is missing",
      options: UNVERIFIED_STEPS_OPTIONS,
      recommended: "abandon",
    });
    await setNeedsOwner(runsRoot, prepared, 216, {
      reason: "unverified-steps",
      decision: id,
    });
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "waiting",
      completionNotified: false,
    }));
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: id,
      option: "skip",
    });
    expect(answered.ok).toBe(true);
    const events = [];
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.summary.status).toBe("completed");
    expect(resumed.summary.loops[0].status).toBe("skipped");
    expect(events.filter((event) => event.kind === "batch-completed")).toHaveLength(1);
  });

  // Usefulness: a held lock with an unanswered decision reports paused, not waiting.
  test("a held lock with an unanswered decision reports paused", async () => {
    const prepared = prep([217]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([217]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a waiting state";
    const decision = await makeDecision(runsRoot, prepared, 217, { reason });
    await setNeedsOwner(runsRoot, prepared, 217, { reason, decision });
    await updateManifest(runsRoot, prepared.id, (value) => ({ ...value, status: "waiting" }));
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-217.resume.lock");
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    try {
      const resumed = await runBatch({
        prepared: { ...prepared, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: childDouble().spawn,
          installSignal: false,
        },
      });
      expect(resumed.exitCode).toBe(1);
      expect(resumed.summary.status).toBe("paused");
      expect(resumed.summary.loops[0].status).toBe("needs-owner");
    } finally {
      await release?.();
    }
  });

  // Usefulness: a resumed exit 4 loop reconciles the pull request head and can end succeeded.
  test("an answered resume on an exit 4 loop reconciles the pull request", async () => {
    const prepared = prep([218]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 4, pr: 42 }).spawn,
        installSignal: false,
      },
    });
    const stopped = await readLoop(runsRoot, prepared.id, 218);
    expect(stopped).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: stopped.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        reconcileLoop: async () => ({
          status: "succeeded",
          reason: null,
          pr: 42,
          requireCi: null,
        }),
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "succeeded", pr: 42 });
  });

  // Usefulness: a live resume answer continues the same transcript and recorded pull request.
  test("a live resume answer continues the same transcript and pull request", async () => {
    const prepared = prep([219, 220], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble();
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 219, "needs-owner");
      expect(stopped.calls).toHaveLength(1);
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      await waitForLaunch(holding);
      expect(holding.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await waitForLaunch(continued);
      expect(continued.calls).toHaveLength(1);
      const args = continued.calls[0].args;
      const continueIndex = args.indexOf("--continue-from");
      expect(continueIndex).toBeGreaterThan(-1);
      expect(args[continueIndex + 1]).toBe(stopped.calls[0].transcript);
      expect(args[args.indexOf("--pr") + 1]).toBe("42");
      await continued.calls[0].written;
      const data = JSON.parse(await readFile(stopped.calls[0].transcript, "utf8"));
      expect(data.events.some((event) => event.type === "continued")).toBe(true);
      expect(data.events.some((event) => event.type === "pr-declared")).toBe(true);
      await run;
    } finally {
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a live resume answer refreshes eligibility and does not launch past an open blocker.
  test("a live resume answer does not launch past an open blocker", async () => {
    const prepared = prep([222, 223], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    let blocked = false;
    const baseGh = fakeGh();
    const gh = (args) => {
      if (blocked && args[0] === "issue" && args[1] === "view" && args[2] === "222") {
        if (args.some((arg) => typeof arg === "string" && arg.includes("blockedBy"))) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
            }),
            stderr: "",
          };
        }
      }
      return baseGh(args);
    };
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 222, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      await waitForLaunch(holding);
      expect(holding.calls).toHaveLength(1);
      blocked = true;
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await waitForStatus(runsRoot, prepared.id, 222, "waiting");
      expect(continued.calls).toHaveLength(0);
      expect((await readLoop(runsRoot, prepared.id, 222)).status).toBe("waiting");
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a held resume lock stops a live resume answer before it launches.
  test("a held resume lock stops a live resume answer", async () => {
    const prepared = prep([224, 225], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    const controller = new AbortController();
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-224.resume.lock");
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    expect(release).not.toBe(null);
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 224, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      await waitForLaunch(holding);
      expect(holding.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      const raced = await Promise.race([
        run.then((value) => ({ value })),
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      expect(continued.calls).toHaveLength(0);
      expect(raced).not.toBe(null);
      expect(raced.value.summary.status).toBe("paused");
      expect((await readLoop(runsRoot, prepared.id, 224)).status).toBe("queued");
    } finally {
      await release?.();
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a live resume answer ignores its own open pull request closure and continues.
  test("a live resume answer ignores its own open pull request closure", async () => {
    const prepared = prep([226, 227], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble();
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    let closing = false;
    const ownBranch = `batch/${prepared.id}/226`;
    const baseGh = fakeGh();
    const gh = (args) => {
      if (
        closing &&
        args[0] === "pr" &&
        args[1] === "list" &&
        args.includes("--state") &&
        !args.includes("--head")
      ) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 42,
              headRefName: ownBranch,
              closingIssuesReferences: [{ number: 226 }],
              baseRefName: "main",
              body: "",
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
      return baseGh(args);
    };
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 226, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      await waitForLaunch(holding);
      expect(holding.calls).toHaveLength(1);
      closing = true;
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await waitForLaunch(continued);
      expect(continued.calls).toHaveLength(1);
      const args = continued.calls[0].args;
      const continueIndex = args.indexOf("--continue-from");
      expect(continueIndex).toBeGreaterThan(-1);
      expect(args[continueIndex + 1]).toBe(stopped.calls[0].transcript);
      expect(args[args.indexOf("--pr") + 1]).toBe("42");
      await run;
      expect((await readLoop(runsRoot, prepared.id, 226)).status).toBe("succeeded");
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a live resume answer does not launch a loop that used every step.
  test("a live resume answer does not launch an exhausted loop", async () => {
    const prepared = prep([228, 229], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, steps: 10, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 228, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      await waitForLaunch(holding);
      expect(holding.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await waitForStatus(runsRoot, prepared.id, 228, "failed");
      expect(continued.calls).toHaveLength(0);
      await run;
      expect(await readLoop(runsRoot, prepared.id, 228)).toMatchObject({
        status: "failed",
        reason: "step-budget-exhausted",
      });
      const claim = batchPaths(runsRoot).claim(prepared.repoKey, 228);
      await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: an open pull request of another branch still skips the loop.
  test("an open pull request of another branch still skips the loop", async () => {
    const prepared = prep([230, 231], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    let closing = false;
    const baseGh = fakeGh();
    const gh = (args) => {
      if (
        closing &&
        args[0] === "pr" &&
        args[1] === "list" &&
        args.includes("--state") &&
        !args.includes("--head")
      ) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 99,
              headRefName: "another-branch",
              closingIssuesReferences: [{ number: 230 }],
              baseRefName: "main",
              body: "",
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
      return baseGh(args);
    };
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 230, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      await waitForLaunch(holding);
      expect(holding.calls).toHaveLength(1);
      closing = true;
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await waitForStatus(runsRoot, prepared.id, 230, "skipped");
      expect(continued.calls).toHaveLength(0);
      expect(await readLoop(runsRoot, prepared.id, 230)).toMatchObject({
        status: "skipped",
        skipReason: "closed-by-open-pr",
      });
      await run;
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a batch resume answer continues the same transcript and recorded pull request.
  test("a batch resume answer continues the same transcript and pull request", async () => {
    const prepared = prep([221]);
    const runsRoot = runsFor(prepared);
    const first = childDouble({ exitCode: 4, pr: 42 });
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: first.spawn,
        installSignal: false,
      },
    });
    const stopped = await readLoop(runsRoot, prepared.id, 221);
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: stopped.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    const continued = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        reconcileLoop: async () => ({
          status: "resume",
          reason: null,
          pr: 42,
          requireCi: null,
        }),
        notifier: noNotify,
        spawn: continued.spawn,
        installSignal: false,
      },
    });
    expect(continued.calls).toHaveLength(1);
    const args = continued.calls[0].args;
    const continueIndex = args.indexOf("--continue-from");
    expect(continueIndex).toBeGreaterThan(-1);
    expect(args[continueIndex + 1]).toBe(first.calls[0].transcript);
    expect(args[args.indexOf("--pr") + 1]).toBe("42");
    expect(resumed.exitCode).toBe(0);
  });
});
