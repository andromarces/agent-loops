import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, expect, test } from "vite-plus/test";
import {
  auditPaths,
  parseAuditArgs,
  parseFindings,
  prepareAudit,
  readAudit,
  readAuditStatus,
  readFrozenIssueSet,
  runAudit,
  writeAudit,
} from "../../src/batch/audit.mjs";
import { git, pathIdentity } from "../../src/batch/git.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const roots = [];
const repos = [];

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
  expect(() => parseAuditArgs([...base, "--reviewer-model", "x"])).toThrow(
    "Unsupported reviewer model: x",
  );
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

// Usefulness: a created audit supplies exactly its frozen issue set in the stored order, and the
// read writes nothing (issue #1734).
test("a created audit supplies its frozen issue set in order", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    status: "created",
    pauseReason: null,
    reason: null,
    issues: [
      { identity: "id-1", title: "Second finding", number: 12, url: "u12", existing: false },
      { title: "Linked finding", number: 4, url: "u4", existing: true },
    ],
  });
  const file = auditPaths(runsRoot).file(prepared.id);
  const before = await stat(file);

  const numbers = await readFrozenIssueSet({ runsRoot, id: prepared.id, repo: prepared.repo });

  expect(numbers).toEqual([12, 4]);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
});

// Usefulness: a paused audit has no finished frozen set, so a batch start is refused before any
// state write (issue #1734).
test("a paused audit is refused", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared);

  await expect(
    readFrozenIssueSet({ runsRoot, id: prepared.id, repo: prepared.repo }),
  ).rejects.toThrow(`Audit ${prepared.id} is paused, not created.`);
});

// Usefulness: a needs-owner audit is not finished, so a batch start is refused (issue #1734).
test("a needs-owner audit is refused", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, { status: "needs-owner" });

  await expect(
    readFrozenIssueSet({ runsRoot, id: prepared.id, repo: prepared.repo }),
  ).rejects.toThrow(`Audit ${prepared.id} is needs-owner, not created.`);
});

// Usefulness: a pending issue write is not reconciled, so its issue set cannot be trusted
// (issue #1734).
test("an unreconciled issue write is refused", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    status: "created",
    pauseReason: null,
    reason: null,
    pendingCreate: { identity: "id-1", title: "Unconfirmed" },
    issues: [{ identity: "id-1", title: "Unconfirmed", number: 20, url: "u20", existing: false }],
  });

  await expect(
    readFrozenIssueSet({ runsRoot, id: prepared.id, repo: prepared.repo }),
  ).rejects.toThrow("has an unreconciled issue write");
});

// Usefulness: the frozen set of another repository would launch unrelated issues (issue #1734).
test("an audit of another repository is refused", async () => {
  const prepared = await preparedAudit();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  await pausedAudit(prepared, {
    status: "created",
    pauseReason: null,
    reason: null,
    issues: [{ title: "Finding", number: 20, url: "u20", existing: false }],
  });

  await expect(
    readFrozenIssueSet({ runsRoot, id: prepared.id, repo: `${prepared.repo}-other` }),
  ).rejects.toThrow(`Audit ${prepared.id} belongs to ${prepared.repo}.`);
});
