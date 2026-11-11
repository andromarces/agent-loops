import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { git } from "../../src/batch/git.mjs";
import { answerDecision, readDecision } from "../../src/batch/decisions.mjs";
import { batchPaths, readLoop, updateLoop } from "../../src/batch/store.mjs";
import { runBatch } from "../../src/batch/supervisor.mjs";
import { endSubprocessTree } from "../../src/lib/exec-tree.mjs";
import { pidAlive } from "../../src/lib/process-identity.mjs";
import { tryStateLock } from "../../src/lib/state-lock.mjs";
import { removePath } from "../fs-helpers.mjs";
import { pollUntil } from "../wait-helpers.mjs";
import {
  BODY,
  batchRepo,
  childDouble,
  cleanupRepo,
  fakeGh,
  fakeGitDeps,
  noNotify,
  preparedFor,
  pushLoop,
  waitForLaunch,
  waitForStatus,
  waitPrepared,
} from "./supervisor-helpers.mjs";

// Usefulness: a resume spends only the remaining budget on the same transcript.
test("a resume with 3 of 10 steps spent passes --max-steps 7 and the same transcript", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const first = child.calls[0];
    expect(first.maxSteps).toBe("10");
    await pushLoop(prepared);

    const childResume = childDouble({ steps: 2 });
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: childResume.spawn, installSignal: false },
    });
    expect(childResume.calls).toHaveLength(1);
    expect(childResume.calls[0].transcript).toBe(first.transcript);
    expect(childResume.calls[0].maxSteps).toBe("7");
    expect(childResume.calls[0].args).toContain("--continue-from");
    expect(resumed.summary.loops[0].stepsUsed).toBe(5);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a resume with no pending work creates no child, claim, or checkpoint write.
test("a resume with no pending work writes nothing", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble();
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    const checkpoint = batchPaths(runsRoot).loop(prepared.id, 1);
    const manifestFile = batchPaths(runsRoot).manifest(prepared.id);
    const beforeLoop = await stat(checkpoint, { bigint: true });
    const beforeManifest = await stat(manifestFile, { bigint: true });
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(1);
    expect(resumed.exitCode).toBe(0);
    expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(beforeLoop.mtimeNs);
    expect((await stat(manifestFile, { bigint: true })).mtimeNs).toBe(beforeManifest.mtimeNs);
    await expect(stat(batchPaths(runsRoot).claim(prepared.repoKey, 1))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: an answered decision resumes the loop after the owner resolves the state.
test("an answered decision resumes the loop after the owner resolves the state", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    await pushLoop(prepared);
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "a resolved state",
      pid: null,
      startTime: null,
    }));

    const pendingChild = childDouble();
    const pending = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: pendingChild.spawn, installSignal: false },
    });
    expect(pendingChild.calls).toHaveLength(0);
    expect(pending.exitCode).toBe(1);
    expect(pending.summary.status).toBe("waiting");
    const pendingLoop = await readLoop(runsRoot, prepared.id, 1);
    expect(pendingLoop.status).toBe("needs-owner");
    expect((await readDecision(runsRoot, prepared.id, pendingLoop.decision)).ok).toBe(true);

    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: pendingLoop.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);

    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(1);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a recorded transcript exit 0 is a success and is never restarted.
test("a transcript that exited 0 is not restarted on recovery", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 0 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: one resumed loop end reads its transcript once, so a late delete cannot hide a read.
test("a resumed loop end reads its transcript once", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    const text = JSON.stringify({ ...data, exitCode: 0 });
    let reads = 0;
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
        readTranscript: async () => {
          reads += 1;
          await removePath(transcript);
          return text;
        },
      },
    });
    expect(reads).toBe(1);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
    expect(resumed.summary.loops[0].report.state).toBe("read");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a recorded transcript exit 2 is a failure and is never restarted.
test("a transcript that exited 2 is not retried on recovery", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 2 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "failed", reason: "exit-2" });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a proven transcript exit 4 stops needs-owner on recovery and reuses its decision.
test("a transcript that exited 4 stops needs-owner on recovery", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true, pr: 42 });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 4 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
      },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.loops[0]).toMatchObject({
      status: "needs-owner",
      reason: "pr-head-unresolved",
      pr: 42,
    });
    expect(resumed.summary.loops[0].workTree).toBe(join(prepared.workTreeRoot, "issue-1"));
    const claim = batchPaths(runsRoot).claim(prepared.repoKey, 1);
    expect((await stat(claim)).isFile()).toBe(true);
    const loop = await readLoop(runsRoot, prepared.id, 1);
    const checkpoint = batchPaths(runsRoot).loop(prepared.id, 1);
    const before = await stat(checkpoint, { bigint: true });
    const again = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
      },
    });
    const after = await readLoop(runsRoot, prepared.id, 1);
    expect(again.exitCode).toBe(1);
    expect(after.decision).toBe(loop.decision);
    expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: two simultaneous resumes launch one loop once.
test("two simultaneous resumes launch a loop once", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    await pushLoop(prepared);
    const resumeChild = childDouble({ hold: true });
    const a = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    const b = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    await waitForLaunch(resumeChild);
    resumeChild.pending[0]?.resolve({ exitCode: 0 });
    await Promise.all([a, b]);
    expect(resumeChild.calls).toHaveLength(1);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a live recorded PID with no start stamp is never restarted.
test("a live recorded process with no start stamp is not restarted", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "running",
      pid: process.pid,
      startTime: null,
    }));
    const resumeChild = childDouble();
    const resumeController = new AbortController();
    const resumed = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
        signal: resumeController.signal,
      },
    });
    await pollUntil(async () => {
      const loop = await readLoop(runsRoot, prepared.id, 1);
      return loop?.reason === "unverified-process-identity" ? loop : undefined;
    }, 10_000);
    resumeController.abort();
    const first = await resumed;
    expect(resumeChild.calls).toHaveLength(0);
    expect(first.summary.loops[0].status).toBe("needs-owner");
    expect((await readLoop(runsRoot, prepared.id, 1)).pid).toBe(process.pid);
    const secondChild = childDouble();
    const second = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: secondChild.spawn, installSignal: false },
    });
    expect(secondChild.calls).toHaveLength(0);
    expect(second.summary.loops[0].status).toBe("needs-owner");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a PR declared by the earlier transcript is imported before recovery, so the resumed
// attempt passes --pr and --require-ci for it.
test("a transcript PR declaration reaches the resumed attempt", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    await pushLoop(prepared);
    const workTree = join(prepared.workTreeRoot, "issue-1");
    const head = (await git(["rev-parse", "HEAD"], workTree)).stdout;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(
      transcript,
      JSON.stringify({
        ...data,
        exitCode: 130,
        options: { pr: null, requireCi: null },
        events: [...data.events, { type: "pr-declared", pr: 5, stepsUsed: 0 }],
      }),
    );
    const pull = {
      number: 5,
      state: "OPEN",
      headRefOid: head,
      isCrossRepository: false,
      baseRefName: prepared.base,
    };
    const gh = (args) => {
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
        return { status: 0, stdout: JSON.stringify([pull]), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", headRefOid: head, mergeCommit: null }),
          stderr: "",
        };
      }
      if (args[0] === "issue" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", closedByPullRequestsReferences: [] }),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    };
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh,
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(1);
    const args = resumeChild.calls[0].args;
    expect(args[args.indexOf("--pr") + 1]).toBe("5");
    expect(args[args.indexOf("--require-ci") + 1]).toBe("5");
    expect(resumed.summary.loops[0].pr).toBe(5);
  } finally {
    await cleanupRepo(repo);
  }
});

// Process-level exception: a forced kill must end a descendant that inherited the group, so it
// needs its own real process tree. Comment: this is the only case in this file that spawns a
// process tree outside the child double.
test("a forced kill ends the child process tree", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid));",
    "setTimeout(() => {}, 60000);",
  ].join(" ");
  const subprocess = execa(process.execPath, ["-e", script], {
    killDescendants: true,
    stdout: "pipe",
  });
  subprocess.catch(() => {});
  const pid = await new Promise((resolve, reject) => {
    subprocess.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    subprocess.catch(reject);
  });
  expect(Number.isInteger(pid)).toBe(true);
  endSubprocessTree(subprocess);
  await pollUntil(() => (pidAlive(pid) ? undefined : true), 10_000);
  expect(pidAlive(pid)).toBe(false);
});

// Usefulness: a lost checkpoint that says queued does not restart a child whose transcript
// already recorded exit 0.
test("a queued checkpoint does not restart a proven transcript", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble();
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "queued",
      cleanup: null,
    }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a fatal exit with no gate event is still a recorded attempt and is never retried.
test("a fatal exit without a gate event is not retried", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 1, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(
      transcript,
      JSON.stringify({
        ...data,
        exitCode: 1,
        error: "detected a mutation",
        events: data.events.filter((event) => event.type !== "gate"),
      }),
    );
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "failed", reason: "exit-1" });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a resumed transcript that ended in an abort keeps the aborted reason and names it.
test("a transcript that ended in an abort is aborted on recovery", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 1, hold: true });
  const controller = new AbortController();
  const lines = [];
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((line) => lines.push(String(line)));
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(
      transcript,
      JSON.stringify({
        ...data,
        exitCode: 1,
        error: "the issue is already done",
        events: [
          ...data.events.filter((event) => event.type !== "gate"),
          { type: "action", action: { action: "abort", reason: "the issue is already done" } },
        ],
      }),
    );
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "failed", reason: "aborted" });
    const failures = lines.filter((line) => line.includes("failed (aborted"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("the issue is already done");
  } finally {
    errorSpy.mockRestore();
    await cleanupRepo();
  }
});

// Usefulness: a resume that loses the ownership lock never reports a running loop as complete.
test("a loop owned by another resume is not reported complete", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  let release;
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-1.resume.lock");
    release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    expect(release).not.toBe(null);
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.status).toBe("paused");
  } finally {
    await release?.();
    await cleanupRepo(repo);
  }
});

// Usefulness: a held lock reports paused even when the skipped loop keeps a needs-owner checkpoint.
test("a needs-owner loop owned by another resume reports paused", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  let release;
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, spawn: child.spawn, installSignal: false, signal: controller.signal },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the remote state",
      pid: null,
      startTime: null,
    }));
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-1.resume.lock");
    release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    expect(release).not.toBe(null);
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.status).toBe("paused");
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
  } finally {
    await release?.();
    await cleanupRepo(repo);
  }
});

// Usefulness: a queued checkpoint trusts no replaced work tree. It stops as needs-owner.
test("a queued checkpoint with a replaced work tree stops before launch", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
    controller.abort();
    await run;
    const workTree = join(prepared.workTreeRoot, "issue-1");
    const transcript = child.calls[0].transcript;
    await removePath(workTree);
    await mkdir(workTree);
    await removePath(transcript);
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "queued",
      setupDone: true,
      pid: null,
      startTime: null,
    }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a malformed decision file fails closed and never restarts the loop.
test("a malformed decision keeps the loop needs-owner on resume", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
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
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "a damaged state",
      decision: "bad-decision",
      pid: null,
      startTime: null,
    }));
    await mkdir(batchPaths(runsRoot).decisions(prepared.id), { recursive: true });
    await writeFile(batchPaths(runsRoot).decision(prepared.id, "bad-decision"), "{");
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
    expect(resumed.exitCode).toBe(1);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a pending decision and a merge wait both survive, and only the unblocked loop runs.
test("a pending decision and a merge wait survive a resume", async () => {
  const prepared = await waitPrepared([1, 2], { loops: 2 });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const ghWith = (openIssue1) => (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const issue = Number(args[2]);
      if (args.includes("state,blockedBy")) {
        const open = openIssue1 && issue === 1 ? [{ number: 9, state: "OPEN" }] : [];
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        const open = openIssue1 && issue === 1 ? [{ number: 9, state: "OPEN" }] : [];
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
  try {
    const firstController = new AbortController();
    const first = runBatch({
      prepared,
      runsRoot,
      gh: ghWith(true),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
        signal: firstController.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          }),
      },
    });
    await waitForStatus(runsRoot, prepared.id, 1, "waiting");
    await waitForStatus(runsRoot, prepared.id, 2, "succeeded");
    firstController.abort();
    await first;
    expect((await readLoop(runsRoot, prepared.id, 1)).status).toBe("waiting");
    expect((await readLoop(runsRoot, prepared.id, 2)).status).toBe("succeeded");
    await updateLoop(runsRoot, prepared.id, 2, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the state",
      decision: null,
      pid: null,
      startTime: null,
    }));
    let now = 0;
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: ghWith(false),
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
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0].cwd).toContain("issue-1");
    expect(resumed.summary.loops[0].status).toBe("succeeded");
    expect(resumed.summary.loops[1].status).toBe("needs-owner");
    expect(resumed.summary.loops[1].decision).toBeTruthy();
    expect(resumed.summary.status).toBe("waiting");
  } finally {
    await cleanupRepo();
  }
});
