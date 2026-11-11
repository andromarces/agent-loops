import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { runAudit } from "../../src/batch/audit.mjs";
import {
  auditPaths,
  readAudit,
  readAuditStatus,
  writeAudit,
} from "../../src/batch/audit-store.mjs";
import { git, pathIdentity } from "../../src/batch/git.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const roots = [];
const repos = [];
let removeRepo;
let sharedRevision;
let sharedWorkTree;

// Creates the detached checkout of `revision` under `base` and records its identity.
async function auditWorkTree(base, revision) {
  const workTreePath = join(base, "revision");
  await git(["worktree", "add", "--detach", workTreePath, revision], removeRepo);
  const identity = await pathIdentity(workTreePath);
  return {
    path: workTreePath,
    canonicalPath: workTreePath,
    dev: String(identity.dev),
    ino: String(identity.ino),
    revision,
  };
}

beforeAll(async () => {
  removeRepo = await createTempRepo();
  repos.push(removeRepo);
  sharedRevision = (await git(["rev-parse", "HEAD"], removeRepo)).stdout;
  const base = await mkdtemp(join(tmpdir(), "audit-shared-"));
  roots.push(base);
  sharedWorkTree = await auditWorkTree(base, sharedRevision);
}, 60_000);

afterAll(async () => {
  for (const root of roots.splice(0)) await removePath(root);
  for (const repo of repos.splice(0)) await removePath(repo);
});

function fenced(value) {
  return `Reasoning before the document.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function fakeGh({ issues = [] } = {}) {
  const calls = [];
  const all = issues.map((issue) => ({ ...issue }));
  let next = Math.max(0, ...all.map((issue) => issue.number)) + 1;
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(all), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "create") {
      const title = args[args.indexOf("--title") + 1];
      const number = next;
      next += 1;
      const url = `https://github.com/o/r/issues/${number}`;
      all.push({ number, title, state: "OPEN", url });
      return { status: 0, stdout: `${url}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { gh, calls, issues: all };
}

function fakeTurns({ reviewers = {}, consolidations = [] } = {}) {
  const calls = [];
  const queue = [...consolidations];
  const runTurn = async (request) => {
    calls.push(request);
    if (request.roleName === "reviewer") {
      const value = reviewers[request.kind];
      if (value instanceof Error) throw value;
      if (typeof value === "function") return value(request);
      return value ?? fenced({ findings: [] });
    }
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value ?? fenced({ findings: [] });
  };
  return { runTurn, calls };
}

// One clean repository and checkout serve the cases that never change them. A case that writes
// into the checkout asks for its own, so the shared state stays immutable across cases.
async function preparedAudit({ ownWorkTree = false, ...overrides } = {}) {
  const base = await mkdtemp(join(tmpdir(), "audit-it-"));
  roots.push(base);
  const workTree = ownWorkTree ? await auditWorkTree(base, sharedRevision) : sharedWorkTree;
  return {
    id: "20260101-000000-test",
    repo: removeRepo,
    repoKey: "abc123abc123",
    base: "main",
    revision: sharedRevision,
    workTreeRoot: join(base, "root"),
    reviewers: [
      { kind: "claude", model: null, effort: null },
      { kind: "agy", model: null, effort: null },
    ],
    worker: { kind: "codex", model: null, effort: null },
    timeout: null,
    reviewerSandbox: null,
    setupCmd: null,
    setupTimeout: 600,
    mode: "start",
    ...overrides,
    workTree,
  };
}

const depsWith = (workTree) => ({ createWorkTree: async () => workTree });

// Usefulness: an audit reviewer receives the existing reviewer prompt, so the test-slot, secret,
// process, and sandbox rules apply, and a Codex reviewer gets no sandbox by default (ADR 0038).
test("an audit reviewer receives the reviewer prompt and codex defaults to no sandbox", async () => {
  const prepared = await preparedAudit({
    reviewers: [
      { kind: "codex", model: null, effort: null },
      { kind: "claude", model: null, effort: null },
    ],
  });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: {
      codex: fenced({ findings: [] }),
      claude: fenced({ findings: [] }),
    },
    consolidations: [fenced({ findings: [] })],
  });
  await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  const codex = turns.calls.find((call) => call.roleName === "reviewer" && call.kind === "codex");
  const claude = turns.calls.find((call) => call.roleName === "reviewer" && call.kind === "claude");
  expect(codex.prompt).toContain("machine-wide test slot");
  expect(codex.prompt).toContain("Never read, print, or quote `.env`");
  expect(codex.prompt).toContain("Never stop, kill, or signal a process");
  expect(codex.prompt).toContain("Sandbox note, supplied by the runtime:");
  expect(codex.prompt).toContain("no sandbox");
  expect(codex.sandboxMode).toBe("none");
  expect(claude.sandboxMode).toBeNull();
});

// Usefulness: a reviewer that changes the audit checkout fails that audit and stops for the
// owner, leaving the file as found and launching no later reviewer or create (ADR 0019).
test("a reviewer that changes the checkout stops for the owner and leaves the file", async () => {
  const prepared = await preparedAudit({ ownWorkTree: true });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: {
      claude: async (request) => {
        await writeFile(join(request.cwd, "mutation.txt"), "changed\n");
        return fenced({ findings: [{ title: "Contaminated", body: "Body", evidence: "" }] });
      },
      agy: fenced({ findings: [{ title: "Clean", body: "Body", evidence: "" }] }),
    },
  });
  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.status).toBe("needs-owner");
  expect(summary.pauseReason).toBe("work-tree-changed");
  expect(summary.reviewers[0].status).toBe("failed");
  expect(summary.reviewers[1].status).toBe("pending");
  expect(summary.issues).toEqual([]);
  expect(turns.calls.some((call) => call.roleName === "worker")).toBe(false);
  expect(turns.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(1);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
  const status = await git(["status", "--porcelain"], prepared.workTree.path);
  expect(status.stdout).toContain("mutation.txt");
  expect(await readFile(join(prepared.workTree.path, "mutation.txt"), "utf8")).toBe("changed\n");
});

async function pausedAudit(
  prepared,
  { reviewerOne = null, reviewerTwo = null, ...overrides } = {},
) {
  const state = {
    id: prepared.id,
    repo: prepared.repo,
    repoKey: prepared.repoKey,
    createdAt: new Date().toISOString(),
    base: "main",
    revision: prepared.revision,
    workTreeRoot: prepared.workTreeRoot,
    workTree: prepared.workTree,
    settings: {
      reviewers: prepared.reviewers,
      worker: prepared.worker,
      timeout: null,
      reviewerSandbox: null,
      setupCmd: null,
      setupTimeout: 600,
    },
    status: "paused",
    pauseReason: "audit-failed",
    reason: "the audit did not succeed for: agy",
    approvedPartial: false,
    approvedRevision: null,
    approvedFailed: [],
    approvedAt: null,
    reviewers: [
      {
        index: 0,
        kind: "claude",
        model: null,
        effort: null,
        status: reviewerOne === null ? "succeeded" : "failed",
        error: null,
        findings:
          reviewerOne === null ? [{ title: "Old result", body: "Old body", evidence: "" }] : [],
        auditedRevision: reviewerOne === null ? prepared.revision : null,
        clean: reviewerOne === null ? true : null,
      },
      {
        index: 1,
        kind: "agy",
        model: null,
        effort: null,
        status: reviewerTwo === null ? "succeeded" : "failed",
        error: null,
        findings: reviewerTwo === null ? [] : [],
        auditedRevision: reviewerTwo === null ? prepared.revision : null,
        clean: reviewerTwo === null ? true : null,
      },
    ],
    existingIssues: [],
    consolidation: {
      status: "succeeded",
      error: null,
      findings: [{ title: "Old result", body: "Old body", evidence: "", existingIssue: null }],
    },
    pendingCreate: null,
    created: [],
    issues: [],
    ...overrides,
  };
  await mkdir(auditPaths(join(prepared.workTreeRoot, "runs")).root, { recursive: true });
  await writeAudit(join(prepared.workTreeRoot, "runs"), state);
  return state;
}

// Usefulness: a resume that finds a moved HEAD stops for the owner, leaves the checkout as
// found, and discards the saved findings so the old result cannot feed creation.
test("a resume stops for the owner when the checkout moved", async () => {
  const prepared = await preparedAudit({ ownWorkTree: true });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared);
  await git(
    [
      "-c",
      "user.name=Tester",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "move",
    ],
    prepared.workTree.path,
  );
  const moved = (await git(["rev-parse", "HEAD"], prepared.workTree.path)).stdout;
  const gh = fakeGh();
  const blocked = fakeTurns();

  const first = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: blocked.runTurn },
  });

  expect(first.exitCode).toBe(1);
  expect(first.summary.status).toBe("needs-owner");
  expect(first.summary.pauseReason).toBe("work-tree-changed");
  expect(first.summary.issues).toEqual([]);
  expect(blocked.calls).toHaveLength(0);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
  expect((await git(["rev-parse", "HEAD"], prepared.workTree.path)).stdout).toBe(moved);

  await git(["reset", "--hard", prepared.revision], prepared.workTree.path);
  const turns = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [{ title: "Fresh", body: "Body", evidence: "" }] }),
      agy: fenced({ findings: [] }),
    },
    consolidations: [
      fenced({
        findings: [{ title: "Fresh", body: "Body", evidence: "", existingIssue: null }],
      }),
    ],
  });
  const second = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(second.exitCode).toBe(0);
  expect(turns.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(2);
  expect(second.summary.issues.map((issue) => issue.title)).toEqual(["Fresh"]);
});

// Usefulness: the owner's approval does not feed a saved result from a changed checkout; drift
// discards the approval, and a later approval after the owner restores the checkout proceeds.
test("approve does not feed a saved result from a changed checkout", async () => {
  const prepared = await preparedAudit({ ownWorkTree: true });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    reviewerTwo: new Error("failed"),
    approvedPartial: true,
    approvedRevision: prepared.revision,
    approvedFailed: [1],
  });
  await writeFile(join(prepared.workTree.path, "init.txt"), "dirty\n");
  const gh = fakeGh();
  const blocked = fakeTurns();

  const first = await runAudit({
    prepared: { ...prepared, mode: "approve" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: blocked.runTurn },
  });

  expect(first.exitCode).toBe(1);
  expect(first.summary.status).toBe("needs-owner");
  expect(first.summary.approvedPartial).toBe(false);
  expect(first.summary.issues).toEqual([]);
  expect(blocked.calls).toHaveLength(0);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
  expect(await readFile(join(prepared.workTree.path, "init.txt"), "utf8")).toBe("dirty\n");

  await git(["reset", "--hard", prepared.revision], prepared.workTree.path);
  const turns = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [{ title: "Fresh approval", body: "Body", evidence: "" }] }),
    },
    consolidations: [
      fenced({
        findings: [{ title: "Fresh approval", body: "Body", evidence: "", existingIssue: null }],
      }),
    ],
  });
  const second = await runAudit({
    prepared: { ...prepared, mode: "approve" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(second.exitCode).toBe(0);
  expect(second.summary.approvedPartial).toBe(true);
  expect(second.summary.issues.map((issue) => issue.title)).toEqual(["Fresh approval"]);
  expect(turns.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(1);
});

// Usefulness: a fatal post-turn snapshot failure stops the audit before the next reviewer, so a
// possibly changed checkout is never read by another audit or fed to issue creation.
test("a snapshot failure stops the audit before the next reviewer", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: {
      claude: () => {
        throw Object.assign(new Error("the post-turn snapshot failed"), {
          name: "SnapshotError",
        });
      },
      agy: fenced({ findings: [{ title: "Later", body: "Body", evidence: "" }] }),
    },
  });
  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.status).toBe("paused");
  expect(summary.pauseReason).toBe("snapshot-failed");
  expect(summary.reviewers[0].status).toBe("failed");
  expect(summary.reviewers[1].status).toBe("pending");
  expect(summary.issues).toEqual([]);
  expect(turns.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(1);
  expect(turns.calls.some((call) => call.roleName === "worker")).toBe(false);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
});

// Usefulness: setup that changes the audit checkout is a drift, so the run stops for the owner,
// launches no reviewer, and leaves the setup's file as found (ADR 0109).
test("setup that changes the checkout stops for the owner and launches no reviewer", async () => {
  const prepared = await preparedAudit({ ownWorkTree: true });
  await mkdir(prepared.workTreeRoot, { recursive: true });
  const setupScript = join(prepared.workTreeRoot, "setup.cjs");
  await writeFile(setupScript, "require('node:fs').writeFileSync('init.txt','changed');\n");
  prepared.setupCmd = `node ${setupScript}`;
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns();
  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.status).toBe("needs-owner");
  expect(summary.pauseReason).toBe("work-tree-changed");
  expect(turns.calls).toHaveLength(0);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
  expect(await readFile(join(prepared.workTree.path, "init.txt"), "utf8")).toBe("changed");
});

// Usefulness: an approval for another failed set does not authorize creation; the stale approval
// is discarded and the audit pauses with no issue.
test("an approval bound to another failed set is discarded", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    reviewerOne: new Error("failed"),
    approvedPartial: true,
    approvedRevision: prepared.revision,
    approvedFailed: [1],
  });
  const gh = fakeGh();
  const turns = fakeTurns({ reviewers: { claude: new Error("still failed") } });
  const { exitCode, summary } = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.status).toBe("paused");
  expect(summary.pauseReason).toBe("audit-failed");
  expect(summary.approvedPartial).toBe(false);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
  expect(turns.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(1);
});

// Usefulness: an approval for another revision does not authorize creation; the stale approval is
// discarded and the audit pauses with no issue.
test("an approval bound to another revision is discarded", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    reviewerTwo: new Error("failed"),
    approvedPartial: true,
    approvedRevision: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    approvedFailed: [1],
  });
  const gh = fakeGh();
  const turns = fakeTurns({ reviewers: { agy: new Error("still failed") } });
  const { exitCode, summary } = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.status).toBe("paused");
  expect(summary.pauseReason).toBe("audit-failed");
  expect(summary.approvedPartial).toBe(false);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
});

describe("bounded audit reads", () => {
  let prepared;
  beforeAll(async () => {
    prepared = await preparedAudit();
  });

  const isolated = (name) => ({ ...prepared, workTreeRoot: join(prepared.workTreeRoot, name) });
  const runsRootOf = (scoped) => join(scoped.workTreeRoot, "runs");
  const frozenCheckout = async () => ({ head: prepared.revision, clean: true });
  const replyOnAbort =
    (reply) =>
    (args, cwd, options = {}) =>
      new Promise((resolve) => {
        const end = () => resolve(reply);
        if (options.signal?.aborted) end();
        else options.signal?.addEventListener("abort", end, { once: true });
      });

  // Usefulness: the audit issue read ends at the bound instead of hanging the run.
  test("an audit issue read that never returns ends at the bound", async () => {
    const scoped = isolated("bound");
    await pausedAudit(scoped, { existingIssues: null });
    const result = await runAudit({
      prepared: { ...scoped, mode: "resume" },
      runsRoot: runsRootOf(scoped),
      gh: replyOnAbort({ status: null, stdout: "", stderr: "", timedOut: true }),
      deps: { ...depsWith(scoped.workTree), ghTimeoutMs: 20, readCheckout: frozenCheckout },
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.pauseReason).toBe("issue-read-failed");
  });

  // Usefulness: a create that reports success after the run abort ends the audit interrupted.
  test("an audit create that ends after the run abort fails closed", async () => {
    const scoped = isolated("cancel");
    await pausedAudit(scoped);
    const abort = new AbortController();
    const gh = (args, cwd, options = {}) => {
      const reply = { status: 0, stdout: "https://github.com/o/r/issues/7\n", stderr: "" };
      if (args[0] !== "issue" || args[1] !== "create") return Promise.resolve(reply);
      abort.abort(new Error("stopped in the create"));
      return options.signal?.aborted
        ? Promise.resolve(reply)
        : new Promise((resolve) => {
            options.signal.addEventListener("abort", () => resolve(reply), { once: true });
          });
    };
    const result = await runAudit({
      prepared: { ...scoped, mode: "resume" },
      runsRoot: runsRootOf(scoped),
      gh,
      signal: abort.signal,
      deps: { ...depsWith(scoped.workTree), readCheckout: frozenCheckout },
    });
    expect(result.exitCode).toBe(130);
    expect(result.summary.status).toBe("interrupted");
  });
});

// Usefulness: two reviewers audit one revision before one consolidation, and each consolidated
// finding becomes exactly one issue. This is the gate and the creation contract together.
test("two reviewers run before one consolidation and create one issue per finding", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: {
      claude: fenced({
        findings: [
          { title: "First defect", body: "Body one", evidence: "a.mjs:1" },
          { title: "Second defect", body: "Body two", evidence: "b.mjs:2" },
        ],
      }),
      agy: fenced({
        findings: [{ title: "First defect", body: "Body one again", evidence: "a.mjs:1" }],
      }),
    },
    consolidations: [
      fenced({
        findings: [
          { title: "First defect", body: "Body one", evidence: "a.mjs:1", existingIssue: null },
          { title: "Second defect", body: "Body two", evidence: "b.mjs:2", existingIssue: null },
        ],
      }),
    ],
  });

  const lines = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
  try {
    const { exitCode, summary } = await runAudit({
      prepared,
      runsRoot,
      gh: gh.gh,
      deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
    });

    expect(exitCode).toBe(0);
    expect(summary.status).toBe("created");
    expect(turns.calls.map((call) => call.roleName)).toEqual(["reviewer", "reviewer", "worker"]);
    expect(turns.calls[2].prompt).toContain("First defect");
    expect(turns.calls[2].prompt).toContain("Second defect");
    expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(2);
    expect(summary.issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(summary.issues.every((issue) => issue.existing === false)).toBe(true);
    const creationLines = lines.filter(
      (line) => line.includes("creating issue ") || line.includes("created issue #"),
    );
    expect(creationLines).toHaveLength(4);
    expect(creationLines.every((line) => line.startsWith("[agent-loop] info: "))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

// Usefulness: a failed issue creation logs one error line, so the failure stays visible.
test("a failed issue creation logs one error line", async () => {
  const base = await mkdtemp(join(tmpdir(), "audit-log-"));
  roots.push(base);
  const workTreePath = join(base, "revision");
  await mkdir(workTreePath, { recursive: true });
  const revision = "1111111111111111111111111111111111111111";
  const identity = await pathIdentity(workTreePath);
  const prepared = {
    id: "20260101-000000-test",
    repo: "o/r",
    repoKey: "abc123abc123",
    base: "main",
    revision,
    workTreeRoot: join(base, "root"),
    reviewers: [
      { kind: "claude", model: null, effort: null },
      { kind: "agy", model: null, effort: null },
    ],
    worker: { kind: "codex", model: null, effort: null },
    timeout: null,
    reviewerSandbox: null,
    setupCmd: null,
    setupTimeout: 600,
    mode: "resume",
    workTree: {
      path: workTreePath,
      canonicalPath: workTreePath,
      dev: String(identity.dev),
      ino: String(identity.ino),
      revision,
    },
  };
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared);
  const gh = fakeGh();
  const failingGh = async (args) =>
    args[0] === "issue" && args[1] === "create"
      ? { status: 1, stdout: "", stderr: "creation refused" }
      : gh.gh(args);
  const errors = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
  try {
    const { summary } = await runAudit({
      prepared,
      runsRoot,
      gh: failingGh,
      deps: { readCheckout: async () => ({ head: revision, clean: true }) },
    });
    expect(summary.pauseReason).toBe("issue-create-failed");
    const failures = errors.filter((line) => line.includes("issue creation failed"));
    expect(failures).toHaveLength(1);
    expect(failures[0].startsWith("[agent-loop] error: ")).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

// Usefulness: a supplied focus is the only reviewer goal, it reaches every reviewer and the
// consolidation, and the record keeps it for a later resume or status (issue #1750).
test("a focused audit gives the focus to every reviewer and keeps it in the record", async () => {
  const focus =
    "Check refactor, cleanup, documentation, code organization, outdated direct dependencies, and test cost";
  const prepared = await preparedAudit({ focus });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [{ title: "Unused export", body: "Body", evidence: "a.mjs:1" }] }),
      agy: fenced({
        findings: [{ title: "Old dependency", body: "Body", evidence: "package.json" }],
      }),
    },
    consolidations: [
      fenced({
        findings: [
          { title: "Unused export", body: "Body", evidence: "a.mjs:1", existingIssue: null },
          { title: "Old dependency", body: "Body", evidence: "package.json", existingIssue: null },
        ],
      }),
    ],
  });

  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(0);
  expect(summary.focus).toBe(focus);
  const reviewerCalls = turns.calls.filter((call) => call.roleName === "reviewer");
  expect(reviewerCalls).toHaveLength(2);
  for (const call of reviewerCalls) {
    expect(call.prompt).toContain(focus);
    expect(call.prompt).not.toContain("Report only defects");
    expect(call.prompt).toContain("Do not change a tracked file");
    expect(call.prompt).toContain("Do not write to GitHub or any remote");
  }
  const worker = turns.calls.find((call) => call.roleName === "worker");
  expect(worker.prompt).toContain(focus);
  expect(worker.prompt).toContain("even an item outside the focus");
  expect(worker.prompt).not.toContain("Drop a finding that is not");
  expect((await readAudit(runsRoot, prepared.id)).focus).toBe(focus);
  expect((await readAuditStatus({ runsRoot, id: prepared.id })).focus).toBe(focus);
});

// Usefulness: without a focus the reviewers look for every actionable item, and a consolidation
// keeps a non-defect item instead of dropping it (issue #1750).
test("an unfocused audit asks for any actionable item and creates a non-defect finding", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: {
      claude: fenced({
        findings: [{ title: "Remove unused export", body: "Body", evidence: "a.mjs:1" }],
      }),
      agy: fenced({ findings: [] }),
    },
    consolidations: [
      fenced({
        findings: [
          {
            title: "Remove unused export",
            body: "Body",
            evidence: "a.mjs:1",
            existingIssue: null,
          },
        ],
      }),
    ],
  });

  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(0);
  expect(summary.focus).toBe(null);
  expect(summary.created).toHaveLength(1);
  const reviewerCalls = turns.calls.filter((call) => call.roleName === "reviewer");
  for (const call of reviewerCalls) {
    expect(call.prompt).toContain("Report any item someone can act on, defects included.");
    expect(call.prompt).not.toContain("Report only defects");
  }
  expect(turns.calls.find((call) => call.roleName === "worker").prompt).toContain(
    "Keep every item someone can act on",
  );
});

// Usefulness: a resume reruns a failed reviewer with the focus stored at start, so the operator
// does not repeat it and the retried audit keeps its goal (issue #1750).
test("a resume reruns the failed reviewer with the stored focus", async () => {
  const focus = "Check test cost opportunities";
  const prepared = await preparedAudit({ focus });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const failed = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [] }),
      agy: new Error("reviewer unavailable"),
    },
  });
  await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: failed.runTurn },
  });

  const retry = fakeTurns({
    reviewers: { agy: fenced({ findings: [] }) },
    consolidations: [fenced({ findings: [] })],
  });
  const second = await runAudit({
    prepared: { ...prepared, mode: "resume", focus: null },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: retry.runTurn },
  });

  expect(second.exitCode).toBe(0);
  const reviewer = retry.calls.find((call) => call.roleName === "reviewer");
  expect(reviewer.kind).toBe("agy");
  expect(reviewer.prompt).toContain(focus);
});

// Usefulness: approve reuses the focus stored at start for consolidation, so an approved partial
// audit keeps the operator goal (issue #1750).
test("approve reuses the stored focus for consolidation", async () => {
  const focus = "Check documentation";
  const prepared = await preparedAudit({ focus });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const failed = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [] }),
      agy: new Error("no model"),
    },
  });
  await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: failed.runTurn },
  });

  const approved = fakeTurns({
    consolidations: [fenced({ findings: [] })],
  });
  const result = await runAudit({
    prepared: { ...prepared, mode: "approve", focus: null },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: approved.runTurn },
  });

  expect(result.exitCode).toBe(0);
  const worker = approved.calls.find((call) => call.roleName === "worker");
  expect(worker.prompt).toContain(focus);
});

// Usefulness: a failed audit blocks consolidation and creation until a retry succeeds, so no issue
// is created from an incomplete audit set.
test("a failed audit creates no issue until a resume succeeds", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const failed = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [{ title: "One", body: "Body", evidence: "" }] }),
      agy: new Error("reviewer unavailable"),
    },
  });

  const first = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: failed.runTurn },
  });
  expect(first.exitCode).toBe(1);
  expect(first.summary.status).toBe("paused");
  expect(first.summary.pauseReason).toBe("audit-failed");
  expect(failed.calls.some((call) => call.roleName === "worker")).toBe(false);
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);

  const retry = fakeTurns({
    reviewers: { agy: fenced({ findings: [{ title: "Two", body: "Body two", evidence: "" }] }) },
    consolidations: [
      fenced({
        findings: [{ title: "Two", body: "Body two", evidence: "", existingIssue: null }],
      }),
    ],
  });
  const second = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: retry.runTurn },
  });

  expect(second.exitCode).toBe(0);
  expect(second.summary.status).toBe("created");
  expect(retry.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(1);
  expect(retry.calls[0].kind).toBe("agy");
  expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(1);
});

// Usefulness: the owner's approval proceeds with the audits that succeeded, records the failure,
// and never silently reruns or ignores it.
test("approve consolidates only the successful audits and records the failure", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const failed = fakeTurns({
    reviewers: {
      claude: fenced({ findings: [{ title: "Kept", body: "Body", evidence: "" }] }),
      agy: new Error("no model"),
    },
  });
  await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: failed.runTurn },
  });

  const approved = fakeTurns({
    consolidations: [
      fenced({ findings: [{ title: "Kept", body: "Body", evidence: "", existingIssue: null }] }),
    ],
  });
  const result = await runAudit({
    prepared: { ...prepared, mode: "approve" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: approved.runTurn },
  });

  expect(result.exitCode).toBe(0);
  expect(result.summary.approvedPartial).toBe(true);
  expect(result.summary.reviewers[1].status).toBe("failed");
  expect(approved.calls.filter((call) => call.roleName === "reviewer")).toHaveLength(0);
  expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(1);
});

// Usefulness: a repeated approval stores nothing, so the second approve leaves the audit file bytes and mtime unchanged.
test("a repeated approval writes nothing to the audit file", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    reviewerTwo: new Error("failed"),
    settings: {
      reviewers: prepared.reviewers,
      worker: prepared.worker,
      timeout: null,
      reviewerSandbox: null,
      setupCmd: "failing setup",
      setupTimeout: 600,
    },
  });
  const gh = fakeGh();
  const failingSetup = async () => ({ exitCode: 1, isCanceled: false });
  const file = auditPaths(runsRoot).file(prepared.id);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = await runAudit({
      prepared: { ...prepared, mode: "approve" },
      runsRoot,
      gh: gh.gh,
      deps: { ...depsWith(prepared.workTree), execBounded: failingSetup },
    });
    expect(first.exitCode).toBe(1);
    expect(first.summary.pauseReason).toBe("setup-failed");
    expect(first.summary.approvedPartial).toBe(true);
    const before = await readFile(file, "utf8");
    const old = 1_700_000_000;
    await utimes(file, old, old);
    const pinned = (await stat(file)).mtimeMs;

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const second = await runAudit({
      prepared: { ...prepared, mode: "approve" },
      runsRoot,
      gh: gh.gh,
      deps: { ...depsWith(prepared.workTree), execBounded: failingSetup },
    });

    expect(second.exitCode).toBe(1);
    expect(second.summary.pauseReason).toBe("setup-failed");
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(pinned);
  } finally {
    vi.useRealTimers();
  }
});

// Usefulness: an issue that already covers a finding is linked, by the worker's number and by an
// exact title, and no duplicate issue is created.
test("an existing issue is linked and no duplicate is created", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh({
    issues: [
      { number: 7, title: "Old defect", state: "CLOSED", url: "https://example/7" },
      { number: 8, title: "Known title", state: "OPEN", url: "https://example/8" },
    ],
  });
  const turns = fakeTurns({
    reviewers: { claude: fenced({ findings: [] }), agy: fenced({ findings: [] }) },
    consolidations: [
      fenced({
        findings: [
          { title: "New wording for the old one", body: "Body", evidence: "", existingIssue: 7 },
          { title: "known title", body: "Body", evidence: "", existingIssue: null },
          { title: "A genuinely new one", body: "Body", evidence: "", existingIssue: null },
        ],
      }),
    ],
  });
  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(0);
  expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(1);
  expect(summary.linked.map((issue) => issue.number)).toEqual([7, 8]);
  expect(summary.issues).toHaveLength(3);
});

// Usefulness: a consolidation that names an issue outside the frozen read is refused before any
// write, so the runtime never trusts an unknown number.
test("an unknown existing issue pauses the consolidation", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: { claude: fenced({ findings: [] }), agy: fenced({ findings: [] }) },
    consolidations: [
      fenced({
        findings: [{ title: "X", body: "Body", evidence: "", existingIssue: 99 }],
      }),
    ],
  });
  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.status).toBe("paused");
  expect(summary.pauseReason).toBe("consolidation-invalid");
  expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
});

// Usefulness: the created issue set is frozen for the run, so a later resume neither adds nor
// removes an issue and writes nothing.
test("the created issue set does not change on a later resume", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: { claude: fenced({ findings: [] }), agy: fenced({ findings: [] }) },
    consolidations: [
      fenced({ findings: [{ title: "Frozen", body: "Body", evidence: "", existingIssue: null }] }),
    ],
  });
  const first = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });
  const before = await readAudit(runsRoot, prepared.id);
  const creates = gh.calls.filter((args) => args[1] === "create").length;
  const retry = fakeTurns();

  const second = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: retry.runTurn },
  });

  const after = await readAudit(runsRoot, prepared.id);
  expect(second.exitCode).toBe(0);
  expect(second.summary.issues).toEqual(first.summary.issues);
  expect(after.issues).toEqual(before.issues);
  expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(creates);
  expect(retry.calls).toHaveLength(0);
});

// Usefulness: a 1000-entry list is the API page limit, so the runtime refuses to dedupe against an
// incomplete set and creates nothing.
test("an issue read at the page limit pauses before consolidation", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const issues = Array.from({ length: 1000 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    state: "OPEN",
    url: `https://example/${index + 1}`,
  }));
  const gh = fakeGh({ issues });
  const turns = fakeTurns({
    reviewers: { claude: fenced({ findings: [] }), agy: fenced({ findings: [] }) },
  });
  const { exitCode, summary } = await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(1);
  expect(summary.pauseReason).toBe("issue-read-incomplete");
  expect(turns.calls.filter((call) => call.roleName === "worker")).toHaveLength(0);
});

// Usefulness: a create that landed before a crash is adopted from a fresh read, so the retry does
// not create a duplicate.
test("a retry adopts a pending creation from a fresh issue read", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh({
    issues: [
      {
        number: 5,
        title: "Already landed",
        state: "OPEN",
        url: "https://example/5",
        body: "Audit-Finding: id-1",
      },
    ],
  });
  const state = {
    id: prepared.id,
    repo: prepared.repo,
    repoKey: prepared.repoKey,
    createdAt: new Date().toISOString(),
    base: "main",
    revision: prepared.revision,
    workTreeRoot: prepared.workTreeRoot,
    workTree: prepared.workTree,
    settings: {
      reviewers: prepared.reviewers,
      worker: prepared.worker,
      timeout: null,
      reviewerSandbox: null,
      setupCmd: null,
      setupTimeout: 600,
    },
    status: "paused",
    pauseReason: "issue-create-failed",
    reason: "the issue creation failed",
    approvedPartial: false,
    reviewers: [
      {
        index: 0,
        kind: "claude",
        model: null,
        effort: null,
        status: "succeeded",
        error: null,
        findings: [],
        auditedRevision: prepared.revision,
        clean: true,
      },
      {
        index: 1,
        kind: "agy",
        model: null,
        effort: null,
        status: "succeeded",
        error: null,
        findings: [],
        auditedRevision: prepared.revision,
        clean: true,
      },
    ],
    existingIssues: [],
    consolidation: {
      status: "succeeded",
      error: null,
      findings: [{ title: "Already landed", body: "Body", evidence: "", existingIssue: null }],
    },
    pendingCreate: { identity: "id-1", title: "Already landed" },
    created: [],
    issues: [],
  };
  await mkdir(auditPaths(runsRoot).root, { recursive: true });
  await writeAudit(runsRoot, state);

  const turns = fakeTurns();
  const { exitCode, summary } = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(0);
  expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(0);
  expect(summary.issues[0].number).toBe(5);
});

// Usefulness: an uncertain create is reconciled by its stable body marker, so a reworded re-audit
// links the created issue instead of creating a duplicate.
test("a reworded re-audit reconciles a pending creation by its marker", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    existingIssues: null,
    consolidation: { status: "pending", error: null, findings: [] },
    pendingCreate: { identity: "id-2", title: "Old title" },
  });
  const gh = fakeGh({
    issues: [
      {
        number: 9,
        title: "Old title",
        state: "OPEN",
        url: "https://example/9",
        body: "Audit-Finding: id-2",
      },
    ],
  });
  const turns = fakeTurns({
    consolidations: [
      fenced({
        findings: [{ title: "Reworded finding", body: "Body", evidence: "", existingIssue: 9 }],
      }),
    ],
  });
  const { exitCode, summary } = await runAudit({
    prepared: { ...prepared, mode: "resume" },
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });

  expect(exitCode).toBe(0);
  expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(0);
  expect(summary.issues).toHaveLength(1);
  expect(summary.issues[0]).toMatchObject({
    number: 9,
    title: "Reworded finding",
    existing: false,
  });
});

// Usefulness: a status read is a pure read, so it changes no store mtime.
test("status writes nothing", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = fakeGh();
  const turns = fakeTurns({
    reviewers: { claude: fenced({ findings: [] }), agy: fenced({ findings: [] }) },
  });
  await runAudit({
    prepared,
    runsRoot,
    gh: gh.gh,
    deps: { ...depsWith(prepared.workTree), runTurn: turns.runTurn },
  });
  const file = auditPaths(runsRoot).file(prepared.id);
  const before = await stat(file);
  const summary = await readAuditStatus({ runsRoot, id: prepared.id });
  const after = await stat(file);
  expect(summary.status).toBe("created");
  expect(after.mtimeMs).toBe(before.mtimeMs);
});
