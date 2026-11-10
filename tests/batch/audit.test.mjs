import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import {
  auditPaths,
  parseAuditArgs,
  parseFindings,
  prepareAudit,
  readAudit,
  readAuditStatus,
  readFrozenIssueSet,
  removeAudit,
  runAudit,
  writeAudit,
} from "../../src/batch/audit.mjs";
import { canonicalPath } from "../../src/lib/canonical-path.mjs";
import { git, pathIdentity, removeDirectoryWithoutLinks } from "../../src/batch/git.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const roots = [];
const repos = [];
let removeRepo;

beforeAll(async () => {
  removeRepo = await createTempRepo();
  repos.push(removeRepo);
}, 60_000);

afterAll(async () => {
  for (const root of roots.splice(0)) await removePath(root);
  for (const repo of repos.splice(0)) await removePath(repo);
});

function fenced(value) {
  return `Reasoning before the document.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/** Runs `parse`, then returns the stderr lines it logged. */
function warningsFrom(parse) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    parse();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
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

async function preparedAudit(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), "audit-it-"));
  roots.push(base);
  const repo = await createTempRepo();
  repos.push(repo);
  const revision = (await git(["rev-parse", "HEAD"], repo)).stdout;
  const workTreePath = join(base, "revision");
  await git(["worktree", "add", "--detach", workTreePath, revision], repo);
  const identity = await pathIdentity(workTreePath);
  const workTree = {
    path: workTreePath,
    canonicalPath: workTreePath,
    dev: String(identity.dev),
    ino: String(identity.ino),
    revision,
  };
  return {
    id: "20260101-000000-test",
    repo,
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
  const prepared = await preparedAudit();
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
  const prepared = await preparedAudit();
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
  const prepared = await preparedAudit();
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
  const prepared = await preparedAudit();
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

// Usefulness: a repeated worker flag with a different value is refused, not silently overwritten.
test("a repeated worker flag with a conflicting value is a usage error", () => {
  expect(() =>
    parseAuditArgs([
      "--repo",
      ".",
      "--reviewer",
      "claude",
      "--reviewer",
      "agy",
      "--worker",
      "codex",
      "--worker",
      "claude",
    ]),
  ).toThrow("--worker conflicts with an earlier value.");
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

// Usefulness: the findings parser accepts the fenced document and rejects prose, so a malformed
// audit is a failure rather than an empty success.
test("findings parse only from a valid fenced document", () => {
  expect(parseFindings("no document")).toBeNull();
  expect(parseFindings(fenced({ findings: [] }))).toEqual([]);
  expect(parseFindings(fenced({ findings: [{ title: "T", body: "B", evidence: "E" }] }))).toEqual([
    { title: "T", body: "B", evidence: "E", existingIssue: null },
  ]);
  expect(parseFindings(fenced({ findings: [{ title: "", body: "B" }] }))).toBeNull();
});

function removeAuditState({ repo, revision, workTreeRoot, workTree, ...overrides }) {
  return {
    id: "20260101-000000-remove",
    repo,
    repoKey: "abc123abc123",
    createdAt: new Date().toISOString(),
    base: "main",
    revision,
    workTreeRoot,
    workTree,
    settings: {
      reviewers: [
        { kind: "claude", model: null, effort: null },
        { kind: "agy", model: null, effort: null },
      ],
      worker: { kind: "codex", model: null, effort: null },
      timeout: null,
      reviewerSandbox: null,
      setupCmd: null,
      setupTimeout: 600,
    },
    status: "created",
    pauseReason: null,
    reason: null,
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
        status: "succeeded",
        error: null,
        findings: [],
        auditedRevision: revision,
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
        auditedRevision: revision,
        clean: true,
      },
    ],
    existingIssues: [],
    consolidation: { status: "succeeded", error: null, findings: [] },
    pendingCreate: null,
    created: [],
    issues: [
      {
        title: "Frozen finding",
        number: 4,
        url: "https://example/4",
        existing: false,
        reviewers: ["claude", "agy"],
      },
    ],
    ...overrides,
  };
}

async function writeRemoveAudit(base, state) {
  const runsRoot = join(base, "runs");
  await mkdir(auditPaths(runsRoot).root, { recursive: true });
  await writeAudit(runsRoot, state);
  return runsRoot;
}

// The retained states refuse before any Git call, so a directory and a store are enough.
async function filesystemAudit(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), "audit-remove-"));
  roots.push(base);
  const workTreeRoot = join(base, "root");
  const workTreePath = join(workTreeRoot, "revision");
  await mkdir(workTreePath, { recursive: true });
  const identity = await pathIdentity(workTreePath);
  const revision = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const state = removeAuditState({
    repo: join(base, "repo"),
    revision,
    workTreeRoot,
    workTree: {
      path: workTreePath,
      canonicalPath: await canonicalPath(workTreePath),
      dev: String(identity.dev),
      ino: String(identity.ino),
      revision,
    },
    ...overrides,
  });
  return { base, runsRoot: await writeRemoveAudit(base, state), state };
}

// One shared repository gives each real-registration case its own work tree.
async function registeredAudit() {
  const base = await mkdtemp(join(tmpdir(), "audit-remove-"));
  roots.push(base);
  const revision = (await git(["rev-parse", "HEAD"], removeRepo)).stdout;
  const workTreeRoot = join(base, "root");
  const workTreePath = join(workTreeRoot, "revision");
  await mkdir(workTreeRoot, { recursive: true });
  await git(["worktree", "add", "--detach", workTreePath, revision], removeRepo);
  const identity = await pathIdentity(workTreePath);
  const state = removeAuditState({
    repo: removeRepo,
    revision,
    workTreeRoot,
    workTree: {
      path: workTreePath,
      canonicalPath: await canonicalPath(workTreePath),
      dev: String(identity.dev),
      ino: String(identity.ino),
      revision,
    },
  });
  return { base, runsRoot: await writeRemoveAudit(base, state), state };
}

// Usefulness: a finished audit's work tree folder and store are the two artifacts that cost disk
// after the frozen issue set exists, and both are gone after remove (ADR 0118).
// Behavior exception: this is the one real end-to-end removal run, with a real Git work tree
// removed, and it asserts the stderr progress at the removal boundary.
test("remove deletes the work tree and store of a finished audit", async () => {
  const { runsRoot, state } = await registeredAudit();
  const written = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  let result;
  try {
    result = await removeAudit({ runsRoot, id: state.id });
  } finally {
    spy.mockRestore();
  }
  const stderr = written.join("");

  expect(result.exitCode).toBe(0);
  expect(result.summary.status).toBe("removed");
  expect(result.summary.removed).toBe(true);
  expect(stderr).toContain("removing the work tree and store");
  expect(stderr).toContain("removed the work tree and store");
  expect(await pathIdentity(state.workTree.path)).toBe(null);
  expect(await readAudit(runsRoot, state.id)).toBe(null);
  expect(await pathIdentity(state.workTreeRoot)).toBe(null);
});

// Usefulness: a paused or needs-owner audit can still be resumed or inspected, so remove keeps
// both the work tree and the store (ADR 0118).
// Filesystem-only: the status refusal happens before any Git read, so no registration is needed.
test("remove keeps a paused or needs-owner audit", async () => {
  for (const status of ["paused", "needs-owner"]) {
    const { runsRoot, state } = await filesystemAudit({ status });
    const result = await removeAudit({ runsRoot, id: state.id });

    expect(result.exitCode).toBe(1);
    expect(result.summary.removed).toBe(false);
    expect(result.summary.reason).toContain(status);
    expect(await pathIdentity(state.workTree.path)).not.toBe(null);
    expect(await readAudit(runsRoot, state.id)).not.toBe(null);
  }
});

// Usefulness: the store holds the stable identity that reconciles an uncertain issue write, so
// remove keeps both artifacts while the write is unreconciled (ADR 0118).
// Filesystem-only: the unreconciled-write refusal happens before any Git read.
test("remove keeps an audit with an unreconciled issue write", async () => {
  const { runsRoot, state } = await filesystemAudit({
    pendingCreate: { identity: "id-9", title: "Unreconciled" },
  });
  const result = await removeAudit({ runsRoot, id: state.id });

  expect(result.exitCode).toBe(1);
  expect(result.summary.removed).toBe(false);
  expect(result.summary.reason).toContain("unreconciled");
  expect(await pathIdentity(state.workTree.path)).not.toBe(null);
  expect(await readAudit(runsRoot, state.id)).not.toBe(null);
});

// Usefulness: a link inside the work tree that names a directory outside it must survive, so the
// removal never follows a link or junction (ADR 0106 decision 13, ADR 0118).
// In-process: the registration read, Git run, and work-tree removal are injected, so this case
// starts no Git process.
test("remove does not follow a link outside the work tree", async () => {
  const { base, runsRoot, state } = await filesystemAudit();
  const outside = join(base, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "keep.txt"), "kept\n");
  await symlink(
    outside,
    join(state.workTree.path, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = await removeAudit({
    runsRoot,
    id: state.id,
    deps: {
      readRegisteredWorkTrees: async () => [
        { path: state.workTree.path, bare: false, locked: false, reason: null },
      ],
      gitRun: async (args) => ({
        exitCode: 0,
        stdout: args[0] === "rev-parse" ? state.revision : "",
        stderr: "",
        timedOut: false,
      }),
      removeWorkTree: async (_repo, path, identity) => removeDirectoryWithoutLinks(path, identity),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("kept\n");
  expect(await pathIdentity(state.workTree.path)).toBe(null);
});

// Usefulness: a moved folder must not hide the locked Git registration, or remove would delete the
// store while Git still holds a locked work tree (ADR 0118 decision 3).
// In-process: a recorded registration reply and an alternate path form stand in for Git, so this
// case starts no Git process.
test("remove keeps a locked work tree whose folder moved away", async () => {
  const { base, runsRoot, state } = await filesystemAudit();
  // A temp directory can reach the same folder through another form, such as a macOS /var link or
  // a Windows short name.
  const aliasBase = join(base, "alias");
  await symlink(base, aliasBase, process.platform === "win32" ? "junction" : "dir");
  const registeredPath = join(aliasBase, relative(base, state.workTree.path));
  const moved = join(base, "moved-revision");
  await rename(state.workTree.path, moved);

  const result = await removeAudit({
    runsRoot,
    id: state.id,
    deps: {
      readRegisteredWorkTrees: async () => [
        { path: registeredPath, bare: false, locked: true, reason: null },
      ],
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.summary.removed).toBe(false);
  expect(result.summary.reason).toContain("locked");
  expect(await pathIdentity(state.workTree.path)).toBe(null);
  expect(await readAudit(runsRoot, state.id)).not.toBe(null);
  expect(await pathIdentity(moved)).not.toBe(null);
});

// Usefulness: a refusal before the store exists is a usage error, not a partial audit.
test("audit arguments require two reviewers and one worker", () => {
  const base = ["--repo", ".", "--reviewer", "claude", "--reviewer", "agy", "--worker", "codex"];
  expect(parseAuditArgs(base).reviewers).toHaveLength(2);
  expect(() =>
    parseAuditArgs(["--repo", ".", "--reviewer", "claude", "--worker", "codex"]),
  ).toThrow("At least two --reviewer entries are required.");
  expect(() =>
    parseAuditArgs(["--repo", ".", "--reviewer", "claude", "--reviewer", "agy"]),
  ).toThrow("Missing required --worker.");
  expect(warningsFrom(() => parseAuditArgs([...base, "--reviewer-model", "x"]))).toEqual([
    expect.stringContaining("Unknown reviewer model: x"),
  ]);
  expect(() => parseAuditArgs(["--repo", ".", "--reviewer-model", "x"])).toThrow(
    "--reviewer-model requires a preceding --reviewer.",
  );
  expect(() => parseAuditArgs([...base, "--reviewer-sandbox", "read-only"])).toThrow(
    "--reviewer-sandbox requires every --reviewer to be codex.",
  );
  expect(() =>
    parseAuditArgs([
      "--repo",
      ".",
      "--reviewer",
      "claude",
      "--reviewer",
      "claude",
      "--worker",
      "codex",
    ]),
  ).toThrow("Duplicate reviewer settings: claude.");
});

// Usefulness: the operator focus is one text source, and a blank text cannot become a reviewer
// goal, so the refusal happens before a store, work tree, or child exists (issue #1750).
test("focus flags are mutually exclusive and refuse blank text", () => {
  const base = ["--repo", ".", "--reviewer", "claude", "--reviewer", "agy", "--worker", "codex"];
  expect(parseAuditArgs([...base, "--focus", "check cleanup"]).focus).toBe("check cleanup");
  expect(parseAuditArgs([...base, "--focus-file", "focus.txt"]).focusFile).toBe("focus.txt");
  expect(() => parseAuditArgs([...base, "--focus", "a", "--focus-file", "focus.txt"])).toThrow(
    "--focus and --focus-file cannot be combined.",
  );
  expect(() => parseAuditArgs([...base, "--focus", "   "])).toThrow("--focus must not be empty.");
});

// Usefulness: a focus file that holds no text gives the reviewers no goal, so the start is
// refused before any store, work tree, or child exists (issue #1750).
test("a blank focus file is refused and a file supplies the focus text", async () => {
  const main = await createTempRepo();
  repos.push(main);
  const remote = `${main}-remote`;
  repos.push(remote);
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  const dir = await mkdtemp(join(tmpdir(), "audit-focus-"));
  roots.push(dir);
  const blank = join(dir, "blank.txt");
  await writeFile(blank, " \n\t\n");
  const full = join(dir, "focus.txt");
  await writeFile(full, "Check outdated direct dependencies\n");
  const options = {
    id: "20260101-000000-test",
    repo: main,
    reviewers: [
      { kind: "claude", model: null, effort: null },
      { kind: "agy", model: null, effort: null },
    ],
    worker: "codex",
    workerModel: null,
    workerEffort: null,
    base,
    workTreeRoot: dir,
    setupCmd: null,
    setupTimeout: 600,
    timeout: null,
    reviewerSandbox: null,
    focus: null,
    focusFile: blank,
  };

  await expect(prepareAudit(options)).rejects.toThrow("--focus-file must not be empty.");

  const prepared = await prepareAudit({ ...options, focusFile: full });
  expect(prepared.focus).toBe("Check outdated direct dependencies");
});

// Usefulness: the default runner returns an object, so prepareAudit must read its stdout to refuse (issue #1758).
test("prepareAudit refuses a work-tree root inside a Git work tree through the rev-parse answer", async () => {
  const top = await mkdtemp(join(tmpdir(), "audit-git-top-"));
  roots.push(top);
  const repo = await mkdtemp(join(tmpdir(), "audit-git-repo-"));
  roots.push(repo);
  const workTreeRoot = join(top, "nested");
  await mkdir(workTreeRoot);
  const gitRun = async (args) => {
    const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (args[0] === "worktree") return { ...result, stdout: `worktree ${repo}\0` };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { ...result, stdout: top };
    }
    if (args[0] === "rev-parse") return { ...result, stdout: "abc123" };
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  await expect(
    prepareAudit(
      {
        id: "20260101-000000-test",
        repo,
        reviewers: [
          { kind: "claude", model: null, effort: null },
          { kind: "agy", model: null, effort: null },
        ],
        worker: "codex",
        workerModel: null,
        workerEffort: null,
        base: "main",
        workTreeRoot,
        setupCmd: null,
        setupTimeout: 600,
        timeout: null,
        reviewerSandbox: null,
      },
      { gitRun },
    ),
  ).rejects.toThrow("The work-tree root must lie outside every Git work tree.");
});

// Usefulness: the audit freezes one revision and refuses a base that has no remote ref, so no
// reviewer can audit a moving branch.
test("prepare resolves the frozen revision and refuses a missing base", async () => {
  const main = await createTempRepo();
  repos.push(main);
  const remote = `${main}-remote`;
  repos.push(remote);
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`], {
    cwd: main,
  });
  const head = (await git(["rev-parse", "HEAD"], main)).stdout;
  const root = await mkdtemp(join(tmpdir(), "audit-root-"));
  roots.push(root);
  const prepared = await prepareAudit({
    id: "20260101-000000-test",
    repo: main,
    reviewers: [
      { kind: "claude", model: null, effort: null },
      { kind: "agy", model: null, effort: null },
    ],
    worker: "codex",
    workerModel: null,
    workerEffort: null,
    base,
    workTreeRoot: root,
    setupCmd: null,
    setupTimeout: 600,
    timeout: null,
    reviewerSandbox: null,
  });
  expect(prepared.revision).toBe(head);
  await expect(
    prepareAudit({
      id: "20260101-000000-test",
      repo: main,
      reviewers: [
        { kind: "claude", model: null, effort: null },
        { kind: "agy", model: null, effort: null },
      ],
      worker: "codex",
      workerModel: null,
      workerEffort: null,
      base: "no-such-base",
      workTreeRoot: root,
      setupCmd: null,
      setupTimeout: 600,
      timeout: null,
      reviewerSandbox: null,
    }),
  ).rejects.toThrow(/has no refs\/remotes\/origin\/no-such-base/);
});

// Builds one audit record in a plain temporary directory, with no Git repository or process, for
// the read-only frozen-set tests.
async function frozenAuditStore(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), "audit-read-"));
  roots.push(base);
  const repo = join(base, "repo");
  await mkdir(repo);
  const runsRoot = join(base, "runs");
  const state = {
    id: "20260101-000000-read",
    repo,
    status: "created",
    pendingCreate: null,
    created: [],
    issues: [],
    ...overrides,
  };
  await mkdir(auditPaths(runsRoot).root, { recursive: true });
  await writeAudit(runsRoot, state);
  return { runsRoot, repo, state };
}

// Usefulness: a created audit supplies exactly its frozen issue set in the stored order, and the
// read writes nothing (issue #1734).
test("a created audit supplies its frozen issue set in order", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({
    issues: [
      { identity: "id-1", title: "Second finding", number: 12, url: "u12", existing: false },
      { title: "Linked finding", number: 4, url: "u4", existing: true },
    ],
  });
  const file = auditPaths(runsRoot).file(state.id);
  const before = await stat(file);

  const numbers = await readFrozenIssueSet({ runsRoot, id: state.id, repo });

  expect(numbers).toEqual([12, 4]);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
});

// Usefulness: a paused audit has no finished frozen set, so a batch start is refused before any
// state write (issue #1734).
test("a paused audit is refused", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({ status: "paused" });

  await expect(readFrozenIssueSet({ runsRoot, id: state.id, repo })).rejects.toThrow(
    `Audit ${state.id} is paused, not created.`,
  );
});

// Usefulness: a needs-owner audit is not finished, so a batch start is refused (issue #1734).
test("a needs-owner audit is refused", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({ status: "needs-owner" });

  await expect(readFrozenIssueSet({ runsRoot, id: state.id, repo })).rejects.toThrow(
    `Audit ${state.id} is needs-owner, not created.`,
  );
});

// Usefulness: a pending issue write is not reconciled, so its issue set cannot be trusted
// (issue #1734).
test("an unreconciled issue write is refused", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({
    pendingCreate: { identity: "id-1", title: "Unconfirmed" },
    issues: [{ identity: "id-1", title: "Unconfirmed", number: 20, url: "u20", existing: false }],
  });

  await expect(readFrozenIssueSet({ runsRoot, id: state.id, repo })).rejects.toThrow(
    "has an unreconciled issue write",
  );
});

// Usefulness: the frozen set of another repository would launch unrelated issues (issue #1734).
test("an audit of another repository is refused", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({
    issues: [{ title: "Finding", number: 20, url: "u20", existing: false }],
  });

  await expect(
    readFrozenIssueSet({ runsRoot, id: state.id, repo: `${repo}-other` }),
  ).rejects.toThrow(`Audit ${state.id} belongs to ${repo}.`);
});
