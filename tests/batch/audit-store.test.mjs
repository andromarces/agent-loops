import { mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import {
  auditPaths,
  readAudit,
  readFrozenIssueSet,
  removeAudit,
  writeAudit,
} from "../../src/batch/audit-store.mjs";
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

// Usefulness: a finished audit's work tree folder and store cost disk after the frozen issue set exists.
// Both are gone after remove (ADR 0118).
// Behavior exception: this is the one real end-to-end removal run.
// It removes a real Git work tree and asserts the stderr progress at the removal boundary.
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

// Usefulness: a paused or needs-owner audit can be resumed or inspected.
// Remove keeps both the work tree and the store (ADR 0118).
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

// Usefulness: the store holds the stable identity that reconciles an uncertain issue write.
// Remove keeps both artifacts while the write is unreconciled (ADR 0118).
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

// Usefulness: a link inside the work tree that names a directory outside it must survive.
// The removal never follows a link or junction (ADR 0106 decision 13, ADR 0118).
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

// Usefulness: a moved folder must not hide the locked Git registration.
// Otherwise remove deletes the store while Git still holds a locked work tree (ADR 0118 decision 3).
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

// Usefulness: a created audit supplies exactly its frozen issue set in the stored order.
// The read writes nothing (issue #1734).
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

// Usefulness: a paused audit has no finished frozen set.
// A batch start is refused before any state write (issue #1734).
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

// Usefulness: a pending issue write is not reconciled.
// Its issue set cannot be trusted (issue #1734).
test("an unreconciled issue write is refused", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({
    pendingCreate: { identity: "id-1", title: "Unconfirmed" },
    issues: [{ identity: "id-1", title: "Unconfirmed", number: 20, url: "u20", existing: false }],
  });

  await expect(readFrozenIssueSet({ runsRoot, id: state.id, repo })).rejects.toThrow(
    "has an unreconciled issue write",
  );
});

// Usefulness: a frozen set from another repository can launch unrelated issues (issue #1734).
test("an audit of another repository is refused", async () => {
  const { runsRoot, repo, state } = await frozenAuditStore({
    issues: [{ title: "Finding", number: 20, url: "u20", existing: false }],
  });

  await expect(
    readFrozenIssueSet({ runsRoot, id: state.id, repo: `${repo}-other` }),
  ).rejects.toThrow(`Audit ${state.id} belongs to ${repo}.`);
});
