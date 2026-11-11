// The audit store, the frozen issue set, the audit work tree, and audit removal.
import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath, isInside, samePath } from "../lib/canonical-path.mjs";
import { writeFileAtomic } from "../lib/atomic-write.mjs";
import { logError, logWarn } from "../lib/log.mjs";
import { tryStateLock } from "../lib/state-lock.mjs";
import { usage } from "./args.mjs";
import {
  findRegisteredWorkTrees,
  git,
  gitOrThrow,
  identityEqual,
  pathIdentity,
  readRegisteredWorkTrees,
  readWorkTreeGitState,
  removeWorkTree,
} from "./git.mjs";
import { parseObject, readStoreText } from "./store.mjs";
import { newBatchId, progress } from "./supervisor.mjs";

/** Generates an audit id that is safe as a directory and a file name. */
export const newAuditId = newBatchId;

/** The paths of the audit store under one runs root. */
export function auditPaths(runsRoot) {
  const root = join(runsRoot, "batches", "audits");
  return {
    root,
    file: (id) => join(root, `${id}.json`),
    lock: (id) => join(root, `${id}.lock`),
  };
}

/** Reads one audit record, or null when it is missing. */
export async function readAudit(runsRoot, id) {
  const file = auditPaths(runsRoot).file(id);
  return parseObject(await readStoreText(file), file, "Audit");
}

/** Writes an audit record only when its stored text changes. Returns true on a write. */
export async function writeAudit(runsRoot, state) {
  const file = auditPaths(runsRoot).file(state.id);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const current = await readStoreText(file);
  if (current === text) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, text);
  return true;
}

/** The local audits, newest first. A missing store has none. */
export async function listAuditStatus(runsRoot) {
  const { root } = auditPaths(runsRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const audits = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const state = await readAudit(runsRoot, entry.name.slice(0, -".json".length));
      if (state !== null) audits.push(auditSummary(state));
    } catch {
      // A malformed record is not an audit this reader reports.
    }
  }
  return audits.sort((a, b) => {
    const left = String(a.createdAt ?? "");
    const right = String(b.createdAt ?? "");
    return left === right
      ? String(b.auditId).localeCompare(String(a.auditId))
      : right.localeCompare(left);
  });
}

/** Reads one audit for `batch audit status`. */
export async function readAuditStatus({ runsRoot, id }) {
  const state = await readAudit(runsRoot, id);
  if (state === null) throw usage(`No audit ${id}.`);
  return auditSummary(state);
}

/**
 * Resolves the frozen issue set of a finished audit for `batch start --from-audit`.
 * Reads only: no store write and no child. Throws a usage error for an audit that is not
 * `created`, an unreconciled issue write, another repository, or a malformed frozen set.
 * @returns {Promise<number[]>} the frozen issue numbers in their stored order
 */
export async function readFrozenIssueSet({ runsRoot, id, repo }) {
  let state;
  try {
    state = await readAudit(runsRoot, id);
  } catch (err) {
    throw usage(`Audit ${id} is unreadable: ${err.message}`);
  }
  if (state === null) throw usage(`No audit ${id}.`);
  if (state.status !== "created") {
    throw usage(
      `Audit ${id} is ${state.status}, not created. A batch starts only from a created audit.`,
    );
  }
  if (state.pendingCreate !== null && state.pendingCreate !== undefined) {
    throw usage(`Audit ${id} has an unreconciled issue write.`);
  }
  const stateRepo = typeof state.repo === "string" ? await canonicalPath(state.repo) : null;
  if (stateRepo !== (await canonicalPath(repo))) {
    throw usage(`Audit ${id} belongs to ${state.repo}.`);
  }
  const issues = Array.isArray(state.issues) ? state.issues : [];
  if (issues.length === 0) throw usage(`Audit ${id} created no issue.`);
  const numbers = [];
  for (const issue of issues) {
    if (
      issue === null ||
      typeof issue !== "object" ||
      !Number.isSafeInteger(issue.number) ||
      issue.number < 1
    ) {
      throw usage(`Audit ${id} has a malformed frozen issue set.`);
    }
    if (numbers.includes(issue.number)) {
      throw usage(`Audit ${id} has a duplicate issue in its frozen set.`);
    }
    numbers.push(issue.number);
  }
  const created = Array.isArray(state.created) ? state.created : [];
  for (const entry of created) {
    if (!Number.isSafeInteger(entry?.number) || !numbers.includes(entry.number)) {
      throw usage(`Audit ${id} has an unreconciled issue write.`);
    }
  }
  return numbers;
}

export function auditSummary(state) {
  const issues = Array.isArray(state.issues) ? state.issues : [];
  return {
    auditId: state.id,
    status: state.status,
    revision: state.revision,
    base: state.base,
    focus: state.focus ?? null,
    workTree: state.workTree?.path ?? null,
    pauseReason: state.pauseReason ?? null,
    reason: state.reason ?? null,
    approvedPartial: state.approvedPartial === true,
    approvedRevision: state.approvedRevision ?? null,
    approvedFailed: Array.isArray(state.approvedFailed) ? state.approvedFailed : [],
    reviewers: (state.reviewers ?? []).map((reviewer) => ({
      kind: reviewer.kind,
      model: reviewer.model,
      effort: reviewer.effort,
      status: reviewer.status,
      error: reviewer.error ?? null,
      findings: Array.isArray(reviewer.findings) ? reviewer.findings.length : 0,
    })),
    existingIssueCount: Array.isArray(state.existingIssues) ? state.existingIssues.length : 0,
    created: Array.isArray(state.created) ? state.created : [],
    linked: issues.filter((issue) => issue.existing === true),
    issues,
  };
}
/** Creates the one linked work tree of an audit at its frozen revision. */
export async function createAuditWorkTree({ repo, revision, workTree }) {
  await mkdir(dirname(workTree), { recursive: true });
  await gitOrThrow(["worktree", "add", "--detach", workTree, revision], repo);
  const identity = await pathIdentity(workTree);
  if (identity === null) throw new Error("The audit work tree is missing after git worktree add.");
  return {
    path: resolve(workTree),
    canonicalPath: await canonicalPath(workTree),
    dev: String(identity.dev),
    ino: String(identity.ino),
    revision,
  };
}

/**
 * The HEAD and clean state of an audit checkout. Returns null when Git cannot read it, so a caller
 * fails closed instead of treating an unreadable checkout as clean.
 */
export async function readAuditCheckout(workTree) {
  const state = await readWorkTreeGitState(workTree);
  if (state.head.exitCode !== 0 || state.status.exitCode !== 0) return null;
  return { head: state.head.stdout, clean: state.status.stdout === "" };
}

export function checkoutIsFrozen(checkout, revision) {
  return checkout !== null && checkout.head === revision && checkout.clean === true;
}
/** A finished audit is the only removable state: the frozen set exists and no write is open. */
function removalBlocker(state) {
  if (state.status !== "created") return `the audit is ${state.status ?? "not finished"}`;
  if (state.pendingCreate !== null && state.pendingCreate !== undefined) {
    return "an issue write is unreconciled";
  }
  if (!Array.isArray(state.issues)) return "the audit has no frozen issue set";
  return null;
}

// Git can report a registered path in another form than the recorded one. An example is a
// resolved /private/var path on macOS or a long temp path on Windows. The direct forms are
// compared, then the canonical parent plus the folder name, because the leaf itself is missing.
async function sameRecordedWorkTree(entryPath, candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (samePath(resolve(entryPath), resolve(candidate))) return true;
    const entryParent = await canonicalPath(dirname(entryPath));
    const candidateParent = await canonicalPath(dirname(candidate));
    const entryReal = join(entryParent, basename(entryPath));
    const candidateReal = join(candidateParent, basename(candidate));
    if (samePath(entryReal, candidateReal)) return true;
  }
  return false;
}

// The ADR 0106 decision 13 identity, registration, revision, and cleanliness checks, applied to
// the detached audit work tree. A null return means remove.
async function auditWorkTreeBlocker(
  state,
  { readRegistrations = readRegisteredWorkTrees, runGit = git } = {},
) {
  const workTree = state.workTree;
  if (workTree === null || typeof workTree !== "object" || typeof workTree.path !== "string") {
    return "the recorded work tree is missing";
  }
  if (typeof state.workTreeRoot !== "string") return "the recorded work tree root is missing";
  if (typeof state.repo !== "string") return "the recorded repository is missing";

  const identity = await pathIdentity(workTree.path);
  if (identity === null) {
    // A moved folder must not hide the registration that Git still holds, and a live lock keeps
    // both artifacts even when the folder is gone.
    const found = await findRegisteredWorkTrees(state.repo, null, { readRegistrations });
    if (found.reason !== null) return found.reason;
    const recorded = [workTree.path, workTree.canonicalPath];
    const own = [];
    for (const entry of found.entries) {
      if (await sameRecordedWorkTree(entry.path, recorded)) own.push(entry);
    }
    if (own.some((entry) => entry.locked)) return "the work tree is locked by a live run";
    if (own.length > 0) return "Git still registers the work tree";
    return null;
  }
  if (!identityEqual(identity, workTree)) return "the work tree identity changed";

  const canonical = await canonicalPath(workTree.path);
  if (canonical !== workTree.canonicalPath) return "the work tree identity changed";
  const root = await canonicalPath(state.workTreeRoot);
  if (!isInside(root, canonical)) return "the path is outside the audit work tree root";
  if (canonical === (await canonicalPath(state.repo))) return "the main work tree is never removed";

  const found = await findRegisteredWorkTrees(state.repo, canonical, { readRegistrations });
  if (found.reason !== null) return found.reason;
  const own = found.own;
  if (own.length !== 1) return "the path is not the registered audit work tree";
  if (own[0].locked) return "the work tree is locked by a live run";

  const reads = await readWorkTreeGitState(workTree.path, { runner: runGit });
  if (reads.head.exitCode !== 0 || reads.head.stdout !== state.revision) {
    return "the recorded revision is not checked out";
  }
  if (reads.status.exitCode !== 0 || reads.status.stdout !== "")
    return "the work tree is not clean";
  return null;
}

// Removes the audit root only when it is the recorded parent, a real directory, and empty. A link
// or any remaining entry keeps it, and rmdir never follows a link.
async function removeEmptyAuditRoot(workTree, workTreeRoot) {
  if (typeof workTreeRoot !== "string" || typeof workTree?.path !== "string") return;
  if (dirname(resolve(workTree.path)) !== resolve(workTreeRoot)) return;
  try {
    const found = await lstat(workTreeRoot);
    if (!found.isDirectory() || found.isSymbolicLink()) return;
    await rmdir(workTreeRoot);
  } catch {
    // A remaining entry, a link, or a failed removal keeps the root.
  }
}

/**
 * Removes one finished audit's work tree and store. Only a `created` audit with a frozen issue set
 * and no unreconciled write is removable. Every other state keeps both. The store goes last, so a
 * failed work-tree removal leaves the record that a retry needs.
 * `deps` injects the registration read, Git run, and work-tree removal for an in-process test.
 * @returns {Promise<{ exitCode: number, summary: object }>}
 */
export async function removeAudit({ runsRoot, id, deps = {} }) {
  const readRegistrations = deps.readRegisteredWorkTrees ?? readRegisteredWorkTrees;
  const runGit = deps.gitRun ?? git;
  const removeTree = deps.removeWorkTree ?? removeWorkTree;
  const paths = auditPaths(runsRoot);
  const release = await tryStateLock(paths.lock(id), { label: "Audit", noun: "audit" });
  if (release === null) {
    logWarn(`audit ${id}: kept: another command owns the audit`);
    return {
      exitCode: 1,
      summary: {
        auditId: id,
        status: "locked",
        removed: false,
        reason: "another command owns the audit",
      },
    };
  }

  try {
    const state = await readAudit(runsRoot, id);
    if (state === null) throw usage(`No audit ${id}.`);
    progress(`audit ${state.id}: removing the work tree and store`);
    const keep = (reason, level = "warn") => {
      const line = `audit ${state.id}: kept: ${reason}`;
      if (level === "error") logError(line);
      else logWarn(line);
      return {
        exitCode: 1,
        summary: {
          auditId: state.id,
          status: state.status ?? null,
          removed: false,
          reason,
          workTree: state.workTree?.path ?? null,
          store: paths.file(state.id),
        },
      };
    };

    const blocker =
      removalBlocker(state) ?? (await auditWorkTreeBlocker(state, { readRegistrations, runGit }));
    if (blocker !== null) return keep(blocker);

    const removal = await removeTree(state.repo, state.workTree.path, {
      dev: state.workTree.dev,
      ino: state.workTree.ino,
    });
    if (!removal.removed) {
      return keep(removal.reason ?? "the work tree removal failed", "error");
    }

    await removeEmptyAuditRoot(state.workTree, state.workTreeRoot);
    await unlink(paths.file(state.id)).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
    progress(`audit ${state.id}: removed the work tree and store`);
    return {
      exitCode: 0,
      summary: {
        auditId: state.id,
        status: "removed",
        removed: true,
        reason: null,
        workTree: state.workTree.path,
        store: paths.file(state.id),
      },
    };
  } finally {
    await release();
  }
}
