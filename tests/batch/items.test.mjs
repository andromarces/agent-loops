import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { parseBatchArgs } from "../../src/batch/args.mjs";
import { checkItemEligibility } from "../../src/batch/eligibility.mjs";
import { runBatch } from "../../src/batch/supervisor.mjs";
import { readBatchStatus } from "../../src/batch/status.mjs";
import { removePath } from "../fs-helpers.mjs";

const ROLE_ARGS = [
  "--repo",
  "REPO",
  "--orchestrator",
  "codex",
  "--worker",
  "claude",
  "--reviewer",
  "agy",
  "--loops",
  "2",
  "--max-steps",
  "10",
];

async function itemsFile(items) {
  const dir = await mkdtemp(join(tmpdir(), "batch-items-"));
  const file = join(dir, "items.json");
  await writeFile(file, JSON.stringify(items));
  return { dir, file };
}

// Usefulness: --items-file carries the three kinds, each with its own default mode.
test("a mixed items file parses every kind and default mode", async () => {
  const { dir, file } = await itemsFile([
    { kind: "issue", number: 12 },
    { kind: "pr", number: 7 },
    { kind: "task", text: "Fix the help typo", id: "fix-help-typo" },
    { kind: "pr", number: 8, mode: "review-only", task: "Only review it" },
  ]);
  try {
    const options = parseBatchArgs([...ROLE_ARGS, "--items-file", file]);
    expect(options.items).toHaveLength(4);
    expect(options.items[0]).toMatchObject({ kind: "issue", key: 12, mode: "work-first" });
    expect(options.items[1]).toMatchObject({ kind: "pr", key: "pr-7", mode: "review-first" });
    expect(options.items[2]).toMatchObject({
      kind: "task",
      key: "task-fix-help-typo",
      mode: "work-first",
    });
    expect(options.items[3]).toMatchObject({ key: "pr-8", mode: "review-only" });
    expect(options.issues).toEqual([12, "pr-7", "task-fix-help-typo", "pr-8"]);
  } finally {
    await removePath(dir);
  }
});

// Usefulness: a malformed item is refused before any state write.
test("a malformed items file is a usage error", async () => {
  const cases = [
    [[{ kind: "nope", number: 1 }], /unknown kind/],
    [[{ kind: "issue", number: 1, mode: "nope" }], /unknown mode/],
    [[{ kind: "task", text: "x" }], /requires an id/],
    [[{ kind: "task", text: "x", id: "bad id" }], /malformed id/],
    [
      [
        { kind: "pr", number: 4 },
        { kind: "pr", number: 4 },
      ],
      /repeats the identity/,
    ],
  ];
  for (const [items, message] of cases) {
    const { dir, file } = await itemsFile(items);
    try {
      expect(() => parseBatchArgs([...ROLE_ARGS, "--items-file", file])).toThrow(message);
    } finally {
      await removePath(dir);
    }
  }
});

function prGh(view, calls = []) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify(view), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
}

// Usefulness: a head that moved after start is skipped with both heads in the reason.
test("a moved pull request head is skipped with the frozen and current heads", async () => {
  const result = await checkItemEligibility({
    item: { kind: "pr", key: "pr-7", number: 7, mode: "review-first", head: "a".repeat(40) },
    gh: prGh({ state: "OPEN", headRefOid: "b".repeat(40), headRefName: "feature" }),
    repo: "C:/repo",
    claim: { exists: false },
  });
  expect(result).toMatchObject({ ok: false, reason: "pr-head-moved" });
  expect(result.evidence).toContain("a".repeat(40));
  expect(result.evidence).toContain("b".repeat(40));
});

// Usefulness: a closed pull request is skipped with a named state.
test("a merged pull request item is skipped", async () => {
  const result = await checkItemEligibility({
    item: {
      kind: "pr",
      key: "pr-7",
      number: 7,
      mode: "review-only",
      head: "a".repeat(40),
    },
    gh: prGh({ state: "MERGED", headRefOid: "a".repeat(40), headRefName: "feature" }),
    repo: "C:/repo",
    claim: { exists: false },
  });
  expect(result).toMatchObject({ ok: false, reason: "pr-closed" });
  expect(result.evidence).toContain("MERGED");
});

// Usefulness: a foreign head is skipped for a work mode and allowed for review-only.
test("a foreign pull request head is skipped only for a work mode", async () => {
  const item = {
    kind: "pr",
    key: "pr-7",
    number: 7,
    mode: "work-first",
    head: "a".repeat(40),
  };
  const view = {
    state: "OPEN",
    headRefOid: "a".repeat(40),
    headRefName: "feature",
    isCrossRepository: true,
  };
  const skipped = await checkItemEligibility({
    item,
    gh: prGh(view),
    repo: "C:/repo",
    claim: { exists: false },
  });
  expect(skipped).toMatchObject({ ok: false, reason: "pr-head-foreign" });
  const allowed = await checkItemEligibility({
    item: { ...item, mode: "review-only" },
    gh: prGh(view),
    repo: "C:/repo",
    claim: { exists: false },
  });
  expect(allowed.ok).toBe(true);
});

// Usefulness: an issue item that names a pull request is skipped, never launched as new work.
test("a pull request number given as an issue item is skipped", async () => {
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ number: 7 }), stderr: "" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const result = await checkItemEligibility({
    item: { kind: "issue", key: 7, number: 7, mode: "work-first" },
    gh,
    repo: "C:/repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), pr: null, incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "is-pull-request" });
  expect(result.evidence).toContain("7");
});

// Usefulness: the acceptance-heading check is off by default and on with the opt-in flag.
test("the not-specified check is opt-in", async () => {
  const body = "## Problem\n\nMissing.\n";
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] }, body }),
          stderr: "",
        };
      }
      if (args.includes("body")) {
        return { status: 0, stdout: JSON.stringify({ body }), stderr: "" };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: [] } }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const item = { kind: "issue", key: 1, number: 1, mode: "work-first" };
  const closures = { closed: new Set(), pr: null, incompletePr: null };
  const byDefault = await checkItemEligibility({
    item,
    gh,
    repo: "C:/repo",
    claim: { exists: false },
    openPrClosures: closures,
  });
  expect(byDefault.ok).toBe(true);
  const optedIn = await checkItemEligibility({
    item,
    gh,
    repo: "C:/repo",
    claim: { exists: false },
    openPrClosures: closures,
    requireSpecification: true,
  });
  expect(optedIn).toMatchObject({ ok: false, reason: "not-specified" });
});

// Usefulness: a free-text task is refused only by a claim of another batch.
test("a free-text task checks only its claim", async () => {
  const gh = async () => {
    throw new Error("a task item must not read GitHub");
  };
  const ok = await checkItemEligibility({
    item: { kind: "task", key: "task-x", text: "Do x", id: "x", mode: "work-first" },
    gh,
    repo: "C:/repo",
    claim: { exists: false },
  });
  expect(ok.ok).toBe(true);
  const claimed = await checkItemEligibility({
    item: { kind: "task", key: "task-x", text: "Do x", id: "x", mode: "work-first" },
    gh,
    repo: "C:/repo",
    claim: { exists: true, held: true, parsed: true, record: { batchId: "other" } },
    batchId: "mine",
  });
  expect(claimed).toMatchObject({ ok: false, reason: "claimed" });
});

const noNotify = async () => ({ spawned: false, ok: true });

function childDouble({ exitCode = 0, events = [], hold = false } = {}) {
  const calls = [];
  const spawn = async ({ args, cwd, logPath }) => {
    const transcript = args[args.indexOf("--transcript") + 1];
    const call = { args, cwd, logPath, transcript };
    calls.push(call);
    let gate = null;
    if (hold) {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      call.release = async () => {
        const data = JSON.parse(await readFile(transcript, "utf8"));
        await writeFile(transcript, JSON.stringify({ ...data, exitCode: 130 }));
        release({ exitCode: 130 });
      };
    }
    await writeFile(
      transcript,
      JSON.stringify({
        events: [...events, { type: "gate" }],
        exitCode,
      }),
    );
    return {
      pid: process.pid,
      startTime: null,
      done: gate ?? Promise.resolve({ exitCode }),
      kill: () => void call.release?.(),
      hardKill: () => void call.release?.(),
      close: () => {},
    };
  };
  return { spawn, calls };
}

function mixedGh({ prHead = "a".repeat(40), prState = "OPEN", afterFreeze = null } = {}) {
  let prReads = 0;
  return async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("number"))
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      prReads += 1;
      if (afterFreeze !== null && prReads > 1) {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: prState,
            headRefOid: afterFreeze,
            headRefName: "feature",
            isCrossRepository: false,
            title: "A pull request",
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          state: prState,
          headRefOid: prHead,
          headRefName: "feature",
          isCrossRepository: false,
          title: "A pull request",
        }),
        stderr: "",
      };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: "[]", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            blockedBy: { nodes: [] },
            body: "## Problem\nMissing.\n\n## Acceptance\n\n- one check\n",
          }),
          stderr: "",
        };
      }
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "An issue" }), stderr: "" };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: [] } }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
}

function preparedWith(items, id = "20261109-000000-test0001") {
  return {
    id,
    repo: "C:/repo",
    repoKey: "repo-key",
    base: "main",
    workTreeRoot: join(tmpdir(), `batch-items-work-${id}`),
    loops: 2,
    maxSteps: 10,
    items,
    issues: items.map((item) => item.key),
    taskTemplate: "Work {issue} {title} on {branch} in {repo}",
    requireSpecification: false,
    setupCmd: null,
    setupTimeout: 600,
    testCmd: null,
    testCmdTimeout: null,
    timeout: 60,
    reviewerSandbox: null,
    roles: {
      orchestrator: { kind: "codex", model: null, effort: null },
      worker: { kind: "claude", model: null, effort: null },
      reviewer: { kind: "agy", model: null, effort: null },
    },
  };
}

const workTreeDeps = {
  createWorkTree: async ({ workTree, branch }) => ({
    path: workTree,
    canonicalPath: workTree,
    dev: "1",
    ino: "1",
    branch,
  }),
  createPrWorkTree: async ({ workTree, branch, head }) => ({
    path: workTree,
    canonicalPath: workTree,
    dev: "1",
    ino: "1",
    branch,
    head,
  }),
  planPrWorkTree: async ({ head }) => ({ fetched: head, localHead: null, fastForward: false }),
  verifyWorkTree: async () => null,
  reconcileLoop: async () => ({ status: "resume", reason: null, pr: null, requireCi: null }),
  cleanupLoop: async () => ({ removed: false, reason: "test" }),
};

// Usefulness: a mixed issue and pull request batch runs each loop in its own mode and work tree.
test("a mixed batch runs an issue work-first and a pull request review-first", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [
    { kind: "issue", number: 1, key: 1, mode: "work-first", task: null },
    {
      kind: "pr",
      number: 7,
      key: "pr-7",
      mode: "review-first",
      task: null,
      head: undefined,
    },
  ];
  const child = childDouble();
  try {
    const { exitCode, summary } = await runBatch({
      prepared: preparedWith(items),
      runsRoot,
      gh: mixedGh(),
      deps: { ...workTreeDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(exitCode).toBe(0);
    expect(summary.loops.map((loop) => loop.issue)).toEqual([1, "pr-7"]);
    expect(child.calls).toHaveLength(2);
    const issueCall = child.calls.find((call) => call.cwd.endsWith("issue-1"));
    const prCall = child.calls.find((call) => call.cwd.endsWith("pr-7"));
    expect(issueCall).toBeTruthy();
    expect(prCall).toBeTruthy();
    expect(issueCall.args).not.toContain("--pr");
    expect(issueCall.args).toContain("--require-accept");
    expect(prCall.args[prCall.args.indexOf("--mode") + 1]).toBe("review-first");
    expect(prCall.args[prCall.args.indexOf("--pr") + 1]).toBe("7");
    expect(prCall.args[prCall.args.indexOf("--require-ci") + 1]).toBe("7");
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: an item whose pull request head moved after start is skipped before any launch.
test("a moved pull request head skips the item before a claim or work tree", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [{ kind: "pr", number: 7, key: "pr-7", mode: "review-first", task: null }];
  const child = childDouble();
  const created = [];
  try {
    const { exitCode, summary } = await runBatch({
      prepared: preparedWith(items),
      runsRoot,
      gh: mixedGh({ afterFreeze: "b".repeat(40) }),
      deps: {
        ...workTreeDeps,
        createWorkTree: async (options) => {
          created.push(options);
          return workTreeDeps.createWorkTree(options);
        },
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
      },
    });
    expect(exitCode).toBe(0);
    expect(summary.loops[0]).toMatchObject({
      status: "skipped",
      skipReason: "pr-head-moved",
    });
    expect(summary.loops[0].reason).toContain("a".repeat(40));
    expect(summary.loops[0].reason).toContain("b".repeat(40));
    expect(child.calls).toHaveLength(0);
    expect(created).toHaveLength(0);
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: a review-only item dispatches no gate flags and records its reviewer verdict.
test("a review-only pull request item succeeds with its verdict", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [{ kind: "pr", number: 7, key: "pr-7", mode: "review-only", task: null }];
  const child = childDouble({
    events: [
      {
        type: "result",
        role: "reviewer",
        result: {
          status: "ok",
          response: "Conclusion: no.\n\nVerdict: reject",
          report: { notes: "one finding" },
        },
      },
    ],
  });
  try {
    const { summary } = await runBatch({
      prepared: preparedWith(items),
      runsRoot,
      gh: mixedGh(),
      deps: { ...workTreeDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls[0].args).not.toContain("--require-accept");
    expect(child.calls[0].args).not.toContain("--pr");
    expect(child.calls[0].args).not.toContain("--require-ci");
    expect(summary.loops[0].status).toBe("succeeded");
    expect(summary.loops[0].report).toMatchObject({
      verdict: "reject",
      findings: "one finding",
    });
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: per-item task text replaces the template only for that item.
test("per-item task text replaces the template for that item only", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [
    { kind: "issue", number: 1, key: 1, mode: "work-first", task: "Custom issue task" },
    { kind: "issue", number: 2, key: 2, mode: "work-first", task: null },
  ];
  const child = childDouble();
  try {
    await runBatch({
      prepared: preparedWith(items),
      runsRoot,
      gh: mixedGh(),
      deps: { ...workTreeDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    const first = child.calls.find((call) => call.cwd.endsWith("issue-1"));
    const second = child.calls.find((call) => call.cwd.endsWith("issue-2"));
    expect(first.args[first.args.indexOf("--task") + 1]).toBe("Custom issue task");
    expect(second.args[second.args.indexOf("--task") + 1]).toContain("Work 2");
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: a free-text task keeps its identity, branch, work tree, transcript, and budget on resume.
test("a free-text task survives interrupt and resume with the same identity", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [
    {
      kind: "task",
      text: "Fix the help typo",
      id: "fix-help-typo",
      key: "task-fix-help-typo",
      mode: "work-first",
      task: null,
    },
  ];
  const prepared = preparedWith(items);
  const first = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const start = runBatch({
      prepared,
      runsRoot,
      gh: mixedGh(),
      deps: {
        ...workTreeDeps,
        notifier: noNotify,
        spawn: first.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const started = await start;
    expect(started.summary.loops[0].status).toBe("interrupted");
    expect(started.summary.loops[0].workTree).toContain("task-fix-help-typo");
    expect(started.summary.loops[0].branch).toBe(`batch/${prepared.id}/task-fix-help-typo`);
    expect(started.summary.loops[0].transcript).toContain("task-fix-help-typo.json");

    const second = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: mixedGh(),
      deps: { ...workTreeDeps, notifier: noNotify, spawn: second.spawn, installSignal: false },
    });
    expect(resumed.summary.loops[0].status).toBe("succeeded");
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].cwd).toBe(started.summary.loops[0].workTree);
    expect(second.calls[0].transcript).toBe(started.summary.loops[0].transcript);
    expect(second.calls[0].args).toContain("--continue-from");
    expect(second.calls[0].args[second.calls[0].args.indexOf("--max-steps") + 1]).toBe("10");
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: a PR item with no frozen head never launches, even when the current read succeeds.
test("a pull request item without a frozen head is refused", async () => {
  const result = await checkItemEligibility({
    item: { kind: "pr", key: "pr-7", number: 7, mode: "review-first", head: null },
    gh: prGh({ state: "OPEN", headRefOid: "a".repeat(40), headRefName: "feature" }),
    repo: "C:/repo",
    claim: { exists: false },
  });
  expect(result).toMatchObject({ ok: false, reason: "pr-head-unfrozen" });
});

// Usefulness: a transient PR lookup failure never lets an issue item launch as new work.
test("a failed PR lookup skips an issue item instead of launching it", async () => {
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view") throw new Error("gh failed");
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            blockedBy: { nodes: [] },
            body: "## Problem\nMissing.\n\n## Acceptance\n\n- one check\n",
          }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: [] } }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const result = await checkItemEligibility({
    item: { kind: "issue", key: 7, number: 7, mode: "work-first" },
    gh,
    repo: "C:/repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), pr: null, incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "eligibility-unverified" });
  expect(result.evidence).toContain("pull request lookup failed");
});

// Usefulness: a pull request refusal creates no batch store or loop checkpoint.
test("a refused pull request item leaves no batch store", async () => {
  const frozen = "a".repeat(40);
  for (const [view, reason] of [
    [{ state: "MERGED", headRefOid: frozen, headRefName: "feature" }, "pr-closed"],
    [
      {
        state: "OPEN",
        headRefOid: "b".repeat(40),
        headRefName: "feature",
        isCrossRepository: false,
      },
      "pr-head-moved",
    ],
    [
      {
        state: "OPEN",
        headRefOid: frozen,
        headRefName: "feature",
        isCrossRepository: true,
      },
      "pr-head-foreign",
    ],
  ]) {
    const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
    const items = [
      { kind: "pr", number: 7, key: "pr-7", mode: "work-first", task: null, head: frozen },
    ];
    const prepared = preparedWith(items);
    const child = childDouble();
    let reads = 0;
    const gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        reads += 1;
        const reply = reads === 1 ? { ...view, headRefOid: frozen } : view;
        return { status: 0, stdout: JSON.stringify(reply), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
    try {
      const { summary } = await runBatch({
        prepared,
        runsRoot,
        gh,
        deps: { ...workTreeDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
      });
      expect(summary.loops[0]).toMatchObject({ status: "skipped", skipReason: reason });
      expect(child.calls).toHaveLength(0);
      await expect(
        stat(join(runsRoot, "batches", prepared.id, "batch.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(runsRoot, "batches", prepared.id, "loops"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await removePath(runsRoot);
    }
  }
});

// Usefulness: a head that moves between eligibility and fetch is skipped, not reviewed elsewhere.
test("a pull request head that moves before the fetch is skipped", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const frozen = "a".repeat(40);
  const items = [
    { kind: "pr", number: 7, key: "pr-7", mode: "review-first", task: null, head: frozen },
  ];
  const prepared = preparedWith(items);
  const child = childDouble();
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: mixedGh({ prHead: frozen }),
      deps: {
        ...workTreeDeps,
        createPrWorkTree: async () => {
          const error = new Error(
            `pull request 7 head moved: the frozen head is ${frozen}, the fetched head is ${"b".repeat(40)}`,
          );
          error.code = "pr-head-moved";
          throw error;
        },
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({
      status: "skipped",
      skipReason: "pr-head-moved",
    });
    expect(summary.loops[0].reason).toContain(frozen);
    expect(child.calls).toHaveLength(0);
    await expect(
      stat(join(runsRoot, "batches", "claims", prepared.repoKey, "pr-7.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: an issue item that names a pull request is refused before any batch store.
test("a pull request number as an issue item leaves no batch store", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [{ kind: "issue", number: 7, key: 7, mode: "work-first", task: null }];
  const prepared = preparedWith(items);
  const child = childDouble();
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ number: 7 }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: { ...workTreeDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(summary.loops[0]).toMatchObject({
      status: "skipped",
      skipReason: "is-pull-request",
    });
    expect(child.calls).toHaveLength(0);
    await expect(stat(join(runsRoot, "batches", prepared.id, "batch.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: batch status lists a preflight-skipped pull request with its reason.
test("batch status lists a preflight-skipped pull request item", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [
    { kind: "issue", number: 1, key: 1, mode: "work-first", task: null },
    { kind: "pr", number: 7, key: "pr-7", mode: "work-first", task: null },
  ];
  const prepared = preparedWith(items);
  const child = childDouble();
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: mixedGh({ prState: "MERGED" }),
      deps: { ...workTreeDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops.map((loop) => loop.issue)).toEqual([1, "pr-7"]);
    expect(status.loops.find((loop) => loop.issue === "pr-7")).toMatchObject({
      status: "skipped",
      skipReason: "pr-closed",
    });
  } finally {
    await removePath(runsRoot);
  }
});

// Usefulness: a PR item has no checkpoint until its launch-time head check passes.
test("a queued pull request item has no checkpoint before its launch", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-items-runs-"));
  const items = [
    { kind: "issue", number: 1, key: 1, mode: "work-first", task: null },
    { kind: "pr", number: 7, key: "pr-7", mode: "review-only", task: null },
  ];
  const prepared = { ...preparedWith(items), loops: 1 };
  const first = childDouble({ hold: true });
  const second = childDouble();
  const spawn = async (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const run = runBatch({
    prepared,
    runsRoot,
    gh: mixedGh(),
    deps: { ...workTreeDeps, notifier: noNotify, spawn, installSignal: false },
  });
  try {
    for (let attempt = 0; attempt < 100 && first.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(first.calls).toHaveLength(1);
    await expect(
      stat(join(runsRoot, "batches", prepared.id, "loops", "pr-7.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await first.calls[0].release();
    const { summary } = await run;
    expect(second.calls).toHaveLength(1);
    expect(summary.loops.find((loop) => loop.issue === "pr-7").status).toBe("succeeded");
  } finally {
    await removePath(runsRoot);
  }
});
