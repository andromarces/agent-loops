// Reviewer audits and consolidated issue creation (ADR 0109). One foreground command runs two or
// more read-only reviewer turns on one frozen revision, one consolidation turn after every requested
// audit succeeds, and one runtime-owned issue write per consolidated finding. No child creates,
// edits, comments on, or labels an issue.
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { defaultAgents, supportedAgents } from "../agents/index.mjs";
import { invoke } from "../child-turn.mjs";
import { DEFAULT_TIMEOUT, openCodeOptionsError } from "../lib/args.mjs";
import { normalizeAgent } from "../lib/agent-kinds.mjs";
import { writeFileAtomic } from "../lib/atomic-write.mjs";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { sha256 } from "../lib/hash.mjs";
import { parseWorkTreeList } from "../lib/git-read.mjs";
import { isFatalTurnError, withMutationCheck } from "../lib/snapshot.mjs";
import { tryStateLock } from "../lib/state-lock.mjs";
import { escapeLineSeparators } from "../prompts/escape.mjs";
import { reviewerPrompt } from "../prompts/reviewer.mjs";
import {
  canonicalWritePath,
  refuseWorkTreeRootInGitWorkTree,
  roleOptionRefusalFor,
} from "./args.mjs";
import {
  git,
  gitOrThrow,
  identityEqual,
  isInside,
  pathIdentity,
  readRegisteredWorkTrees,
  removeWorkTree,
} from "./git.mjs";
import { progress, runSetup } from "./supervisor.mjs";

const MAX_REVIEWERS = 16;
const ISSUE_PAGE_LIMIT = 1000;
const DEFAULT_SETUP_TIMEOUT = 600;
const MAX_TITLE_LENGTH = 256;
const MAX_FINDINGS = 100;

const usage = (message) => Object.assign(new Error(message), { usage: true });

/** A pause that names its reason code, so the checkpoint keeps a short value and a detail. */
class Pause extends Error {
  constructor(reason, message) {
    super(message);
    this.pauseReason = reason;
  }
}

/** A stop that leaves the audit work tree as found for the owner (ADR 0019, ADR 0109). */
class NeedsOwner extends Error {
  constructor(reason, message) {
    super(message);
    this.pauseReason = reason;
    this.needsOwner = true;
  }
}

function positiveInt(flag, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw usage(`${flag} must be a positive integer.`);
  }
  return number;
}

/**
 * Parses `agent-loop batch audit start` arguments. Throws an error with `usage: true` for a missing
 * or invalid value. Performs no filesystem read and writes nothing.
 * @param {string[]} argv arguments after `batch audit start`
 */
export function parseAuditArgs(argv) {
  const options = {
    repo: null,
    reviewers: [],
    worker: null,
    workerModel: null,
    workerEffort: null,
    base: null,
    workTreeRoot: null,
    setupCmd: null,
    setupTimeout: DEFAULT_SETUP_TIMEOUT,
    timeout: DEFAULT_TIMEOUT,
    reviewerSandbox: null,
  };
  let current = null;
  let sandboxAlias = false;
  const repeated = new Map();
  const setScalar = (key, flag, value) => {
    if (repeated.has(key) && repeated.get(key) !== value) {
      throw usage(`${flag} conflicts with an earlier value.`);
    }
    repeated.set(key, value);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const read = (name) => {
      if (inline !== null) {
        if (inline === "") throw usage(`Missing value for ${name}.`);
        return inline;
      }
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw usage(`Missing value for ${name}.`);
      return value;
    };

    switch (flag) {
      case "--repo":
        options.repo = resolve(read(flag));
        break;
      case "--reviewer":
        if (options.reviewers.length >= MAX_REVIEWERS) {
          throw usage(`--reviewer accepts at most ${MAX_REVIEWERS} entries.`);
        }
        current = { kind: read(flag), model: null, effort: null };
        options.reviewers.push(current);
        break;
      case "--reviewer-model":
        if (current === null) throw usage("--reviewer-model requires a preceding --reviewer.");
        current.model = read(flag);
        break;
      case "--reviewer-effort":
        if (current === null) throw usage("--reviewer-effort requires a preceding --reviewer.");
        current.effort = read(flag);
        break;
      case "--worker":
        options.worker = setScalar("worker", flag, read(flag));
        break;
      case "--worker-model":
        options.workerModel = setScalar("worker-model", flag, read(flag));
        break;
      case "--worker-effort":
        options.workerEffort = setScalar("worker-effort", flag, read(flag));
        break;
      case "--base":
        options.base = read(flag);
        break;
      case "--work-tree-root":
        options.workTreeRoot = resolve(read(flag));
        break;
      case "--setup-cmd":
        options.setupCmd = read(flag);
        break;
      case "--setup-timeout":
        options.setupTimeout = positiveInt(flag, read(flag));
        break;
      case "--timeout": {
        const seconds = Number(read(flag));
        if (!Number.isSafeInteger(seconds) || seconds < 0) {
          throw usage("--timeout must be a non-negative integer.");
        }
        options.timeout = seconds === 0 ? null : seconds;
        break;
      }
      case "--reviewer-sandbox": {
        const value = read(flag);
        if (!["read-only", "workspace-write"].includes(value)) {
          throw usage(
            `--reviewer-sandbox must be one of read-only, workspace-write, got: ${value}`,
          );
        }
        setSandbox(options, value, false, sandboxAlias);
        sandboxAlias = false;
        break;
      }
      case "--reviewer-workspace-write":
        if (inline !== null) throw usage("--reviewer-workspace-write does not take a value.");
        setSandbox(options, "workspace-write", true, sandboxAlias);
        sandboxAlias = true;
        break;
      default:
        throw usage(`Unknown argument: ${raw}`);
    }
  }

  if (options.repo === null) throw usage("Missing required --repo.");
  if (options.reviewers.length < 2) throw usage("At least two --reviewer entries are required.");
  if (options.worker === null) throw usage("Missing required --worker.");
  const seen = new Set();
  for (const reviewer of options.reviewers) {
    const key = `${reviewer.kind}\0${reviewer.model}\0${reviewer.effort}`;
    if (seen.has(key)) throw usage(`Duplicate reviewer settings: ${reviewer.kind}.`);
    seen.add(key);
  }
  for (const reviewer of options.reviewers) {
    if (!supportedAgents.has(reviewer.kind)) {
      throw usage(`Unsupported reviewer: ${reviewer.kind}`);
    }
    const openCode = openCodeOptionsError(
      "reviewer",
      reviewer.kind,
      reviewer.model,
      reviewer.effort,
    );
    if (openCode) throw usage(openCode);
    const roleRefusal = roleOptionRefusalFor(
      "reviewer",
      reviewer.kind,
      reviewer.model,
      reviewer.effort,
    );
    if (roleRefusal) throw usage(roleRefusal);
  }
  if (!supportedAgents.has(options.worker)) {
    throw usage(`Unsupported worker: ${options.worker}`);
  }
  const workerOpenCode = openCodeOptionsError(
    "worker",
    options.worker,
    options.workerModel,
    options.workerEffort,
  );
  if (workerOpenCode) throw usage(workerOpenCode);
  const workerRefusal = roleOptionRefusalFor(
    "worker",
    options.worker,
    options.workerModel,
    options.workerEffort,
  );
  if (workerRefusal) throw usage(workerRefusal);
  if (
    options.reviewerSandbox !== null &&
    !options.reviewers.every((reviewer) => normalizeAgent(reviewer.kind) === "codex")
  ) {
    throw usage("--reviewer-sandbox requires every --reviewer to be codex.");
  }
  return options;
}

function setSandbox(options, value, viaAlias, aliasSeen) {
  const earlier = options.reviewerSandbox;
  if (earlier !== null && earlier !== value) {
    if (viaAlias || aliasSeen) {
      throw usage(`--reviewer-workspace-write conflicts with --reviewer-sandbox ${earlier}.`);
    }
    throw usage(`--reviewer-sandbox ${value} conflicts with --reviewer-sandbox ${earlier}.`);
  }
  options.reviewerSandbox = value;
}

async function assertWritableDirectory(path) {
  let current = path;
  for (;;) {
    try {
      const found = await stat(current);
      if (!found.isDirectory()) {
        throw usage("The work-tree root is not a directory the audit can write.");
      }
      await access(current, constants.W_OK);
      return;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        if (err?.usage) throw err;
        throw usage("The work-tree root is not a directory the audit can write.");
      }
      const parent = dirname(current);
      if (parent === current) {
        throw usage("The work-tree root is not a directory the audit can write.");
      }
      current = parent;
    }
  }
}

/**
 * Resolves the repository, base branch, revision, and work-tree root of an audit, refusing before
 * any state write or child process exists.
 * @param {object} options parsed options
 * @param {{ gitRun?: (args: string[], cwd: string) => Promise<object> }} [deps]
 */
export async function prepareAudit(options, { gitRun = git } = {}) {
  const repo = await canonicalPath(options.repo);
  const listed = await gitRun(["worktree", "list", "--porcelain", "-z"], repo);
  if (listed.exitCode !== 0) throw usage(`--repo is not a Git work tree: ${listed.stderr}`);
  const entries = parseWorkTreeList(listed.stdout);
  const first = entries[0];
  if (first === undefined || first.bare) {
    throw usage("--repo must name a Git main work tree.");
  }
  const main = await canonicalPath(first.path);
  if (main !== repo) throw usage(`--repo must name the main work tree (${main}).`);

  let base = options.base ?? null;
  if (base === null) {
    const remote = await gitRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
    if (remote.exitCode === 0 && remote.stdout !== "") {
      base = remote.stdout.startsWith("origin/")
        ? remote.stdout.slice("origin/".length)
        : remote.stdout;
    } else {
      base = "main";
    }
  }
  const revision = await gitRun(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`],
    repo,
  );
  if (revision.exitCode !== 0 || revision.stdout === "") {
    throw usage(`--base ${base} has no refs/remotes/origin/${base}.`);
  }

  const workTreeRoot =
    options.workTreeRoot ??
    join(dirname(repo), `${basename(repo)}-audit-${options.id ?? "preview"}`);
  const rootCanonical = await canonicalWritePath(workTreeRoot);
  await refuseWorkTreeRootInGitWorkTree(rootCanonical, { gitRun });
  await assertWritableDirectory(rootCanonical);

  const repoKey = sha256(repo.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase())).slice(0, 12);
  return {
    ...options,
    repo,
    base,
    revision: revision.stdout,
    workTreeRoot: rootCanonical,
    repoKey,
    reviewers: options.reviewers.map((reviewer) => ({
      kind: normalizeAgent(reviewer.kind) ?? reviewer.kind,
      model: reviewer.model,
      effort: reviewer.effort,
    })),
    worker: {
      kind: normalizeAgent(options.worker) ?? options.worker,
      model: options.workerModel,
      effort: options.workerEffort,
    },
  };
}

/** Generates an audit id that is safe as a directory and a file name. */
export function newAuditId(now = new Date()) {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** The paths of the audit store under one runs root. */
export function auditPaths(runsRoot) {
  const root = join(runsRoot, "batches", "audits");
  return {
    root,
    file: (id) => join(root, `${id}.json`),
    lock: (id) => join(root, `${id}.lock`),
  };
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function parseAudit(text, file) {
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Audit record is not valid JSON: ${file}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Audit record is not a JSON object: ${file}`);
  }
  return value;
}

/** Reads one audit record, or null when it is missing. */
export async function readAudit(runsRoot, id) {
  const file = auditPaths(runsRoot).file(id);
  return parseAudit(await readText(file), file);
}

/** Writes an audit record only when its stored text changes. Returns true on a write. */
export async function writeAudit(runsRoot, state) {
  const file = auditPaths(runsRoot).file(state.id);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const current = await readText(file);
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

function auditSummary(state) {
  const issues = Array.isArray(state.issues) ? state.issues : [];
  return {
    auditId: state.id,
    status: state.status,
    revision: state.revision,
    base: state.base,
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

function initialState(prepared) {
  return {
    id: prepared.id,
    repo: prepared.repo,
    repoKey: prepared.repoKey,
    createdAt: new Date().toISOString(),
    base: prepared.base,
    revision: prepared.revision,
    workTreeRoot: prepared.workTreeRoot,
    workTree: null,
    settings: {
      reviewers: prepared.reviewers,
      worker: prepared.worker,
      timeout: prepared.timeout,
      reviewerSandbox: prepared.reviewerSandbox,
      setupCmd: prepared.setupCmd,
      setupTimeout: prepared.setupTimeout,
    },
    status: "running",
    pauseReason: null,
    reason: null,
    approvedPartial: false,
    approvedRevision: null,
    approvedFailed: [],
    approvedAt: null,
    reviewers: prepared.reviewers.map((reviewer, index) => ({
      index,
      kind: reviewer.kind,
      model: reviewer.model,
      effort: reviewer.effort,
      status: "pending",
      error: null,
      findings: [],
      auditedRevision: null,
      clean: null,
    })),
    existingIssues: null,
    consolidation: { status: "pending", error: null, findings: [] },
    pendingCreate: null,
    created: [],
    issues: null,
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
  const head = await git(["rev-parse", "HEAD"], workTree);
  const status = await git(["status", "--porcelain"], workTree);
  if (head.exitCode !== 0 || status.exitCode !== 0) return null;
  return { head: head.stdout, clean: status.stdout === "" };
}

function checkoutIsFrozen(checkout, revision) {
  return checkout !== null && checkout.head === revision && checkout.clean === true;
}

/** Drops every saved audit result and the owner approval when the audit evidence changed. */
function discardSavedFindings(state) {
  return {
    ...state,
    approvedPartial: false,
    approvedRevision: null,
    approvedFailed: [],
    approvedAt: null,
    reviewers: state.reviewers.map((reviewer) =>
      reviewer.status === "succeeded" || reviewer.status === "running"
        ? {
            ...reviewer,
            status: "pending",
            error: null,
            findings: [],
            auditedRevision: null,
            clean: null,
          }
        : reviewer,
    ),
    consolidation: { status: "pending", error: null, findings: [] },
  };
}

function sameIndexes(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function failedIndexes(state) {
  return state.reviewers
    .filter((reviewer) => reviewer.status === "failed")
    .map((reviewer) => reviewer.index);
}

/** True when the owner approved this exact failed set on this exact audited revision. */
function approvalMatches(state) {
  return (
    state.approvedPartial === true &&
    state.approvedRevision === state.revision &&
    sameIndexes(state.approvedFailed, failedIndexes(state))
  );
}

/** Clears an approval whose failed set or revision changed since the owner gave it. */
function clearStaleApproval(state) {
  if (state.approvedPartial === true && !approvalMatches(state)) {
    return {
      ...state,
      approvedPartial: false,
      approvedRevision: null,
      approvedFailed: [],
      approvedAt: null,
    };
  }
  return state;
}

function savedFindingsAreBound(state) {
  return state.reviewers.every(
    (reviewer) =>
      reviewer.status !== "succeeded" ||
      (reviewer.auditedRevision === state.revision && reviewer.clean === true),
  );
}

function reviewerSandboxMode(kind, reviewerSandbox) {
  if (kind !== "codex") return null;
  return reviewerSandbox ?? "none";
}

export function parseFindings(response) {
  if (typeof response !== "string") return null;
  const candidates = [];
  for (const match of response.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  const trimmed = response.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let value;
    try {
      value = JSON.parse(candidates[index]);
    } catch {
      continue;
    }
    if (value !== null && typeof value === "object" && Array.isArray(value.findings)) {
      const findings = normalizeFindings(value.findings);
      if (findings !== null) return findings;
    }
  }
  return null;
}

function normalizeFindings(raw) {
  if (raw.length > MAX_FINDINGS) return null;
  const findings = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.title !== "string" || typeof entry.body !== "string") return null;
    const title = entry.title.trim();
    const body = entry.body.trim();
    if (title === "" || body === "" || title.length > MAX_TITLE_LENGTH) return null;
    const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
    let existingIssue = null;
    if (entry.existingIssue !== undefined && entry.existingIssue !== null) {
      if (!Number.isSafeInteger(entry.existingIssue) || entry.existingIssue < 1) return null;
      existingIssue = entry.existingIssue;
    }
    findings.push({ title, body, evidence, existingIssue });
  }
  return findings;
}

/** Validates a consolidation against the frozen issue list, or null when it is not usable. */
export function validateConsolidation(findings, issues) {
  if (findings === null) return null;
  const numbers = new Set(issues.map((issue) => issue.number));
  const titles = new Set();
  const out = [];
  for (const finding of findings) {
    const key = finding.title.trim().toLowerCase();
    if (titles.has(key)) return null;
    titles.add(key);
    if (finding.existingIssue !== null && !numbers.has(finding.existingIssue)) return null;
    out.push({ ...finding, title: finding.title.trim() });
  }
  return out;
}

function auditPrompt({ revision, base, kind }) {
  return escapeLineSeparators(`You are reviewer ${kind} of one read-only project audit. Audit revision ${revision} of the base branch ${base} in this work tree.

Do not change a tracked file or an untracked file that Git does not ignore, and do not change Git state. Do not write to GitHub or any remote: do not create, edit, comment on, label, or close an issue or a pull request, and do not push. Read-only queries are allowed. Report only defects that a reader can act on, not praise or general observations.

Return exactly one fenced json code block with this document:
{"findings":[{"title":"...","body":"...","evidence":"..."}]}

Rules for the document:
- One finding per actionable defect. Do not repeat a finding under two titles.
- The title is a concise issue title of at most 256 characters.
- The body states the problem, where it occurs, and the failure scenario.
- The evidence names the files, symbols, inputs, or commands that support the finding.
- If the revision has no actionable defect, return an empty findings array.
- Put the document before any other closing text, and include no other fenced json block.`);
}

function consolidationPrompt({ auditId, revision, findings, issues }) {
  const supplied = findings.map(({ reviewer, finding }) => ({
    reviewer,
    title: finding.title,
    body: finding.body,
    evidence: finding.evidence,
  }));
  const issueList = issues.map(({ number, title, state }) => ({ number, title, state }));
  return escapeLineSeparators(`You are the consolidation worker of audit run ${auditId} on revision ${revision}. Merge the reviewer findings into one issue set.

Reviewer findings, supplied by the runtime as JSON:
${JSON.stringify(supplied, null, 2)}

Open and closed issues of the repository, supplied by the runtime as JSON:
${JSON.stringify(issueList, null, 2)}

Rules:
- Merge findings that describe the same defect. One defect becomes one finding.
- Drop a finding that is not an actionable defect against this revision.
- Compare every finding with every supplied issue, open or closed. When an issue already covers it, set existingIssue to that number. Otherwise set existingIssue to null.
- Never create, edit, comment on, label, or close an issue yourself. The runtime makes every remote write.
- Keep an issue title at most 256 characters, and state a concrete problem, its location, and its failure scenario in the body.

Return exactly one fenced json code block with this document:
{"findings":[{"title":"...","body":"...","evidence":"...","existingIssue":12}]}

Use null for existingIssue when no supplied issue covers the finding, and include no other fenced json block.`);
}

async function defaultRunTurn({
  kind,
  model,
  effort,
  roleName,
  prompt,
  cwd,
  timeout,
  signal,
  sandboxMode = null,
}) {
  const state = { kind, model, effort, sessionId: null };
  return withMutationCheck(
    cwd,
    roleName,
    () =>
      invoke({
        agents: defaultAgents,
        state,
        roleName,
        prompt,
        opts: {
          cwd,
          readOnly: true,
          ...(sandboxMode === null || sandboxMode === undefined ? {} : { sandbox: sandboxMode }),
          timeout,
          signal,
        },
        onEvent: () => {},
        stepsUsed: 0,
      }),
    { signal },
  );
}

async function readIssueList({ gh, repo, withBody = false }) {
  let reply;
  try {
    reply = await gh(
      [
        "issue",
        "list",
        "--state",
        "all",
        "--limit",
        String(ISSUE_PAGE_LIMIT),
        "--json",
        withBody ? "number,title,state,url,body" : "number,title,state,url",
      ],
      repo,
    );
  } catch (err) {
    throw new Pause("issue-read-failed", `the issue read failed: ${err.message}`);
  }
  if (reply?.status !== 0) {
    throw new Pause("issue-read-failed", "the issue read failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(reply.stdout);
  } catch {
    throw new Pause("issue-read-failed", "the issue read returned an unreadable value");
  }
  if (!Array.isArray(parsed)) {
    throw new Pause("issue-read-failed", "the issue read returned an unreadable value");
  }
  if (parsed.length >= ISSUE_PAGE_LIMIT) {
    throw new Pause(
      "issue-read-incomplete",
      `the issue list returned ${ISSUE_PAGE_LIMIT} entries, which is the page limit`,
    );
  }
  const issues = [];
  for (const entry of parsed) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Number.isSafeInteger(entry.number) ||
      typeof entry.title !== "string" ||
      typeof entry.state !== "string"
    ) {
      throw new Pause("issue-read-failed", "the issue read returned an unreadable value");
    }
    issues.push({
      number: entry.number,
      title: entry.title,
      state: entry.state,
      url: typeof entry.url === "string" ? entry.url : null,
      ...(withBody ? { body: typeof entry.body === "string" ? entry.body : "" } : {}),
    });
  }
  return issues;
}

function pendingMarker(identity) {
  return `Audit-Finding: ${identity}`;
}

/**
 * Reconciles one pending create by its stable marker in the issue body. A write that landed is
 * adopted whatever title a re-audit gives the finding; a write that did not land clears the record.
 */
async function reconcilePendingCreate({ state, gh }) {
  const pending = state.pendingCreate;
  if (pending === null) return state;
  const issues = await readIssueList({ gh, repo: state.repo, withBody: true });
  const marker = pendingMarker(pending.identity);
  const found = issues.find((issue) => issue.body.includes(marker));
  if (found === undefined) {
    return { ...state, pendingCreate: null };
  }
  const entry = {
    identity: pending.identity,
    title: found.title,
    number: found.number,
    url: found.url,
    createdAt: new Date().toISOString(),
  };
  const created = [...(state.created ?? [])];
  if (!created.some((item) => item.identity === pending.identity)) created.push(entry);
  const frozen = Array.isArray(state.issues) ? [...state.issues] : [];
  upsertIssue(frozen, { ...entry, existing: false });
  const existingIssues = Array.isArray(state.existingIssues)
    ? [...state.existingIssues]
    : state.existingIssues;
  if (
    Array.isArray(existingIssues) &&
    !existingIssues.some((issue) => issue.number === found.number)
  ) {
    existingIssues.push({
      number: found.number,
      title: found.title,
      state: found.state,
      url: found.url,
    });
  }
  return {
    ...state,
    pendingCreate: null,
    created,
    issues: frozen,
    existingIssues,
  };
}

function issueNumberFromUrl(stdout) {
  const match = /\/issues\/(\d+)\s*$/.exec(String(stdout ?? "").trim());
  return match ? Number(match[1]) : null;
}

function createdBody({ finding, auditId, revision, identity }) {
  const evidence = finding.evidence === "" ? "" : `\n\nEvidence: ${finding.evidence}`;
  return `${finding.body}${evidence}\n\nAudit-Run: ${auditId}\nAudit-Finding: ${identity}\nAudit-Revision: ${revision}`;
}

function sameTitle(left, right) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Adds an issue to the frozen set, or updates the entry for the same number or identity. */
function upsertIssue(issues, entry) {
  const index = issues.findIndex(
    (issue) =>
      issue.number === entry.number ||
      (entry.identity !== undefined && issue.identity === entry.identity),
  );
  if (index === -1) issues.push(entry);
  else issues[index] = { ...issues[index], ...entry };
}

async function writeState(runsRoot, state) {
  await writeAudit(runsRoot, state);
  return state;
}

/**
 * Starts, resumes, or approves one audit run. Returns `{ exitCode, summary }`. Every store write is
 * a change; a status read and a run with nothing to do write nothing.
 * @param {{ prepared: object, runsRoot: string, gh: Function, signal?: AbortSignal, deps?: object }} options
 */
export async function runAudit({ prepared, runsRoot, gh, signal = null, deps = {} }) {
  const paths = auditPaths(runsRoot);
  const mode = prepared.mode ?? "start";
  const release = await tryStateLock(paths.lock(prepared.id), { label: "Audit", noun: "audit" });
  if (release === null) {
    const state = await readAudit(runsRoot, prepared.id);
    if (state === null) throw usage(`No audit ${prepared.id}.`);
    const paused = {
      ...state,
      status: "paused",
      pauseReason: "audit-locked",
      reason: "another command owns the audit",
    };
    return { exitCode: 1, summary: auditSummary(paused) };
  }

  try {
    let state = await readAudit(runsRoot, prepared.id);
    if (state !== null && state.status === "created") {
      return { exitCode: 0, summary: auditSummary(state) };
    }
    if (mode === "start") {
      if (state !== null) throw usage(`Audit ${prepared.id} already exists.`);
      state = initialState(prepared);
      await writeState(runsRoot, state);
      progress(
        `audit ${state.id} started (${state.reviewers.length} reviewer(s), revision ${state.revision.slice(0, 12)})`,
      );
    } else if (state === null) {
      throw usage(`No audit ${prepared.id}.`);
    }

    if (mode === "approve") {
      const failed = failedIndexes(state);
      if (failed.length > 0) {
        state = {
          ...state,
          approvedPartial: true,
          approvedRevision: state.revision,
          approvedFailed: failed.sort((left, right) => left - right),
          approvedAt: new Date().toISOString(),
        };
        await writeState(runsRoot, state);
      }
    }

    if (state.workTree === null) {
      let workTree;
      try {
        workTree = await (deps.createWorkTree ?? createAuditWorkTree)({
          repo: prepared.repo,
          revision: state.revision,
          workTree: join(prepared.workTreeRoot, "revision"),
        });
      } catch (err) {
        throw new Pause("work-tree-failed", `the audit work tree was not created: ${err.message}`);
      }
      state = { ...state, workTree };
      await writeState(runsRoot, state);
      progress(`audit ${state.id}: revision ${state.revision.slice(0, 12)} checked out`);
    } else {
      const identity = await pathIdentity(state.workTree.path);
      if (identity === null) {
        throw new NeedsOwner("work-tree-missing", "the recorded audit work tree is missing");
      }
      if (!identityEqual(identity, state.workTree)) {
        throw new NeedsOwner("work-tree-changed", "the recorded audit work tree identity changed");
      }
    }

    const runTurn = deps.runTurn ?? defaultRunTurn;
    const readCheckout = deps.readCheckout ?? readAuditCheckout;

    const ensureFrozenCheckout = async () => {
      let checkout = await readCheckout(state.workTree.path);
      if (!checkoutIsFrozen(checkout, state.revision)) {
        state = {
          ...discardSavedFindings(state),
          status: "needs-owner",
          pauseReason: "work-tree-changed",
          reason: "the audit checkout no longer holds the frozen revision",
        };
        await writeState(runsRoot, state);
        throw new NeedsOwner(
          "work-tree-changed",
          "the audit checkout no longer holds the frozen revision",
        );
      }
      if (!savedFindingsAreBound(state)) {
        state = discardSavedFindings(state);
        await writeState(runsRoot, state);
        progress(`audit ${state.id}: discarded saved findings because the checkout changed`);
      }
      return checkout;
    };

    await ensureFrozenCheckout();

    if (state.setupDone !== true && state.settings.setupCmd) {
      const ok = await runSetup({
        command: state.settings.setupCmd,
        workTree: state.workTree.path,
        timeoutSeconds: state.settings.setupTimeout,
        signal,
        deps,
      });
      if (signal?.aborted) throw Object.assign(new Error("interrupted"), { isCanceled: true });
      if (!ok) throw new Pause("setup-failed", "the setup command failed");
      state = { ...state, setupDone: true };
      await writeState(runsRoot, state);
      await ensureFrozenCheckout();
    }

    for (const reviewer of state.reviewers) {
      if (reviewer.status === "succeeded") continue;
      if (approvalMatches(state) && reviewer.status === "failed") continue;
      if (signal?.aborted) throw Object.assign(new Error("interrupted"), { isCanceled: true });
      state = {
        ...state,
        status: "running",
        pauseReason: null,
        reason: null,
        reviewers: state.reviewers.map((entry) =>
          entry.index === reviewer.index ? { ...entry, status: "running", error: null } : entry,
        ),
      };
      await writeState(runsRoot, state);
      const sandboxMode = reviewerSandboxMode(reviewer.kind, state.settings.reviewerSandbox);
      try {
        const response = await runTurn({
          kind: reviewer.kind,
          model: reviewer.model,
          effort: reviewer.effort,
          roleName: "reviewer",
          prompt: reviewerPrompt({
            prompt: auditPrompt({
              revision: state.revision,
              base: state.base,
              kind: reviewer.kind,
            }),
            sandboxMode,
          }),
          cwd: state.workTree.path,
          timeout: state.settings.timeout,
          signal,
          sandboxMode,
        });
        const findings = parseFindings(response);
        if (findings === null) {
          throw new Error("the reviewer returned no valid findings document");
        }
        const after = await readCheckout(state.workTree.path);
        if (!checkoutIsFrozen(after, state.revision)) {
          throw new NeedsOwner(
            "work-tree-changed",
            "the reviewer changed the audited revision or left the work tree dirty",
          );
        }
        state = {
          ...state,
          reviewers: state.reviewers.map((entry) =>
            entry.index === reviewer.index
              ? {
                  ...entry,
                  status: "succeeded",
                  error: null,
                  findings,
                  auditedRevision: state.revision,
                  clean: true,
                }
              : entry,
          ),
        };
        progress(
          `audit ${state.id}: reviewer ${reviewer.kind} succeeded (${findings.length} finding(s))`,
        );
      } catch (err) {
        if (err?.isCanceled || signal?.aborted) throw err;
        state = {
          ...state,
          reviewers: state.reviewers.map((entry) =>
            entry.index === reviewer.index
              ? {
                  ...entry,
                  status: "failed",
                  error: errorText(err),
                  auditedRevision: null,
                  clean: null,
                }
              : entry,
          ),
        };
        await writeState(runsRoot, state);
        if (err?.needsOwner) throw err;
        if (err?.name === "MutationError") {
          throw new NeedsOwner("work-tree-changed", errorText(err));
        }
        if (isFatalTurnError(err)) {
          throw new Pause("snapshot-failed", errorText(err));
        }
        if (err?.pauseReason) throw err;
        progress(`audit ${state.id}: reviewer ${reviewer.kind} failed`);
      }
      await writeState(runsRoot, state);
    }

    await ensureFrozenCheckout();
    state = clearStaleApproval(state);
    await writeState(runsRoot, state);

    const unsuccessful = state.reviewers.filter((reviewer) => reviewer.status !== "succeeded");
    const approvedFailures =
      approvalMatches(state) && unsuccessful.every((reviewer) => reviewer.status === "failed");
    if (unsuccessful.length > 0 && !approvedFailures) {
      const names = unsuccessful.map((reviewer) => reviewer.kind).join(", ");
      state = {
        ...state,
        status: "paused",
        pauseReason: "audit-failed",
        reason: `the audit did not succeed for: ${names}`,
      };
      await writeState(runsRoot, state);
      progress(`audit ${state.id}: paused (${state.pauseReason})`);
      return { exitCode: 1, summary: auditSummary(state) };
    }

    if (state.existingIssues === null) {
      const issues = await readIssueList({ gh, repo: prepared.repo });
      state = { ...state, existingIssues: issues };
      await writeState(runsRoot, state);
    }

    if (state.pendingCreate !== null) {
      state = await reconcilePendingCreate({ state, gh });
      await writeState(runsRoot, state);
    }

    if (state.consolidation.status !== "succeeded") {
      state = {
        ...state,
        status: "running",
        pauseReason: null,
        reason: null,
        consolidation: { ...state.consolidation, status: "running", error: null },
      };
      await writeState(runsRoot, state);
      const successes = state.reviewers.filter((reviewer) => reviewer.status === "succeeded");
      try {
        const response = await runTurn({
          kind: state.settings.worker.kind,
          model: state.settings.worker.model,
          effort: state.settings.worker.effort,
          roleName: "worker",
          prompt: consolidationPrompt({
            auditId: state.id,
            revision: state.revision,
            findings: successes.flatMap((reviewer) =>
              reviewer.findings.map((finding) => ({ reviewer: reviewer.kind, finding })),
            ),
            issues: state.existingIssues,
          }),
          cwd: state.workTree.path,
          timeout: state.settings.timeout,
          signal,
        });
        const parsed = parseFindings(response);
        const consolidated = validateConsolidation(parsed, state.existingIssues);
        if (consolidated === null) {
          throw new Pause(
            "consolidation-invalid",
            "the consolidation returned an invalid issue set",
          );
        }
        state = {
          ...state,
          consolidation: { status: "succeeded", error: null, findings: consolidated },
        };
      } catch (err) {
        if (err?.isCanceled || signal?.aborted) throw err;
        const reason = err?.pauseReason ?? "consolidation-failed";
        state = {
          ...state,
          status: "paused",
          pauseReason: reason,
          reason: errorText(err),
          consolidation: {
            ...state.consolidation,
            status: "failed",
            error: errorText(err),
          },
        };
        await writeState(runsRoot, state);
        return { exitCode: 1, summary: auditSummary(state) };
      }
      await writeState(runsRoot, state);
    }

    state = await createIssues({ state, runsRoot, gh, signal });
    progress(
      `audit ${state.id}: created ${state.issues.length} issue(s), ${state.issues.filter((issue) => issue.existing).length} linked`,
    );
    return { exitCode: state.status === "created" ? 0 : 1, summary: auditSummary(state) };
  } catch (err) {
    const state = await readAudit(runsRoot, prepared.id);
    if (state === null) throw err;
    if (err?.isCanceled || signal?.aborted) {
      const interrupted = {
        ...state,
        status: "interrupted",
        pauseReason: "interrupted",
        reason: "interrupted by SIGINT",
      };
      await writeState(runsRoot, interrupted);
      return { exitCode: 130, summary: auditSummary(interrupted) };
    }
    if (err?.usage) throw err;
    if (err?.needsOwner) {
      const owner = {
        ...discardSavedFindings(state),
        status: "needs-owner",
        pauseReason: err.pauseReason ?? "work-tree-changed",
        reason: errorText(err),
      };
      await writeState(runsRoot, owner);
      return { exitCode: 1, summary: auditSummary(owner) };
    }
    const paused = {
      ...state,
      status: "paused",
      pauseReason: err?.pauseReason ?? "audit-failed",
      reason: errorText(err),
    };
    await writeState(runsRoot, paused);
    return { exitCode: 1, summary: auditSummary(paused) };
  } finally {
    await release();
  }
}

function errorText(err) {
  const message = typeof err?.message === "string" ? err.message : String(err);
  return message === "" ? "the step failed with an empty error message" : message;
}

async function createIssues({ state, runsRoot, gh, signal }) {
  if (state.pendingCreate !== null) {
    state = await reconcilePendingCreate({ state, gh });
    await writeState(runsRoot, state);
  }
  const frozen = state.consolidation.findings;
  const created = [...(state.created ?? [])];
  const issues = Array.isArray(state.issues) ? [...state.issues] : [];

  for (const finding of frozen) {
    if (issues.some((issue) => sameTitle(issue.title, finding.title))) continue;
    const named =
      finding.existingIssue === null
        ? null
        : state.existingIssues.find((issue) => issue.number === finding.existingIssue);
    const existing =
      named ?? state.existingIssues.find((issue) => sameTitle(issue.title, finding.title));
    if (existing) {
      const ownWrite = created.some((entry) => entry.number === existing.number);
      upsertIssue(issues, {
        title: finding.title,
        number: existing.number,
        url: existing.url,
        existing: !ownWrite,
        reviewers: state.reviewers
          .filter((reviewer) => reviewer.status === "succeeded")
          .map((reviewer) => reviewer.kind),
      });
      state = { ...state, issues: [...issues] };
      await writeState(runsRoot, state);
      continue;
    }

    const alreadyCreated = created.find((entry) => sameTitle(entry.title, finding.title));
    if (alreadyCreated) {
      upsertIssue(issues, { ...alreadyCreated, existing: false });
      state = { ...state, issues: [...issues] };
      await writeState(runsRoot, state);
      continue;
    }

    if (signal?.aborted) throw Object.assign(new Error("interrupted"), { isCanceled: true });
    const identity = randomUUID();
    state = { ...state, pendingCreate: { identity, title: finding.title } };
    await writeState(runsRoot, state);
    let reply;
    try {
      reply = await gh(
        [
          "issue",
          "create",
          "--title",
          finding.title,
          "--body",
          createdBody({ finding, auditId: state.id, revision: state.revision, identity }),
        ],
        state.repo,
      );
    } catch (err) {
      throw new Pause("issue-create-failed", `the issue creation failed: ${err.message}`);
    }
    if (reply?.status !== 0) {
      throw new Pause("issue-create-failed", "the issue creation failed");
    }
    const number = issueNumberFromUrl(reply.stdout);
    if (number === null) {
      throw new Pause("issue-create-failed", "the created issue returned no number");
    }
    const entry = {
      identity,
      title: finding.title,
      number,
      url: String(reply.stdout).trim(),
      createdAt: new Date().toISOString(),
    };
    created.push(entry);
    upsertIssue(issues, { ...entry, existing: false });
    state = { ...state, pendingCreate: null, created: [...created], issues: [...issues] };
    await writeState(runsRoot, state);
  }

  state = {
    ...state,
    status: "created",
    pauseReason: null,
    reason: null,
    pendingCreate: null,
    issues,
  };
  await writeState(runsRoot, state);
  return state;
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

// The ADR 0106 decision 13 identity, registration, revision, and cleanliness checks, applied to
// the detached audit work tree. A null return means remove.
async function auditWorkTreeBlocker(state) {
  const workTree = state.workTree;
  if (workTree === null || typeof workTree !== "object" || typeof workTree.path !== "string") {
    return "the recorded work tree is missing";
  }
  if (typeof state.workTreeRoot !== "string") return "the recorded work tree root is missing";
  if (typeof state.repo !== "string") return "the recorded repository is missing";
  const canonical = await canonicalPath(workTree.path);
  if (canonical !== workTree.canonicalPath) return "the work tree identity changed";
  const root = await canonicalPath(state.workTreeRoot);
  if (!isInside(root, canonical)) return "the path is outside the audit work tree root";
  if (canonical === (await canonicalPath(state.repo))) return "the main work tree is never removed";

  const identity = await pathIdentity(workTree.path);
  if (identity === null) return null;
  if (!identityEqual(identity, workTree)) return "the work tree identity changed";

  let entries;
  try {
    entries = await readRegisteredWorkTrees(state.repo);
  } catch (err) {
    return `the work tree list read failed: ${err.message}`;
  }
  const own = [];
  for (const entry of entries) {
    if ((await canonicalPath(entry.path)) === canonical) own.push(entry);
  }
  if (own.length !== 1) return "the path is not the registered audit work tree";
  if (own[0].locked) return "the work tree is locked by a live run";

  const head = await git(["rev-parse", "HEAD"], workTree.path);
  if (head.exitCode !== 0 || head.stdout !== state.revision) {
    return "the recorded revision is not checked out";
  }
  const status = await git(["status", "--porcelain"], workTree.path);
  if (status.exitCode !== 0 || status.stdout !== "") return "the work tree is not clean";
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
 * and no unreconciled write is removable; every other state keeps both. The store goes last, so a
 * failed work-tree removal leaves the record that a retry needs.
 * @returns {Promise<{ exitCode: number, summary: object }>}
 */
export async function removeAudit({ runsRoot, id }) {
  const paths = auditPaths(runsRoot);
  const release = await tryStateLock(paths.lock(id), { label: "Audit", noun: "audit" });
  if (release === null) {
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
    const keep = (reason) => ({
      exitCode: 1,
      summary: {
        auditId: state.id,
        status: state.status ?? null,
        removed: false,
        reason,
        workTree: state.workTree?.path ?? null,
        store: paths.file(state.id),
      },
    });

    const blocker = removalBlocker(state) ?? (await auditWorkTreeBlocker(state));
    if (blocker !== null) return keep(blocker);

    const removal = await removeWorkTree(state.repo, state.workTree.path, {
      dev: state.workTree.dev,
      ino: state.workTree.ino,
    });
    if (!removal.removed) return keep(removal.reason ?? "the work tree removal failed");

    await removeEmptyAuditRoot(state.workTree, state.workTreeRoot);
    await unlink(paths.file(state.id)).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
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
