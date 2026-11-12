// Reviewer audits and consolidated issue creation (ADR 0109). One foreground command runs two or
// more read-only reviewer turns on one frozen revision, one consolidation turn after every requested
// audit succeeds, and one runtime-owned issue write per consolidated finding. No child creates,
// edits, comments on, or labels an issue.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultAgents } from "../agents/index.mjs";
import { invoke } from "../child-turn.mjs";
import { DEFAULT_READ_TIMEOUT_MS } from "../lib/checks/gh-api.mjs";
import { boundedRunner } from "../lib/checks/bounded-call.mjs";
import { logError, logInfo } from "../lib/log.mjs";
import { isFatalTurnError, withMutationCheck } from "../lib/snapshot.mjs";
import { tryStateLock } from "../lib/state-lock.mjs";
import { reviewerPrompt } from "../prompts/reviewer.mjs";
import { usage } from "./args.mjs";
import {
  auditPaths,
  auditSummary,
  checkoutIsFrozen,
  createAuditWorkTree,
  readAudit,
  readAuditCheckout,
  writeAudit,
} from "./audit-store.mjs";
import {
  auditPrompt,
  consolidationPrompt,
  parseFindings,
  validateConsolidation,
} from "./audit-prompts.mjs";
import { readGhJson } from "./gh-read.mjs";
import { identityEqual, pathIdentity } from "./git.mjs";
import { progress } from "./loop-records.mjs";
import { runSetup } from "./worker.mjs";

const ISSUE_PAGE_LIMIT = 1000;

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

function initialState(prepared) {
  return {
    id: prepared.id,
    repo: prepared.repo,
    repoKey: prepared.repoKey,
    createdAt: new Date().toISOString(),
    base: prepared.base,
    revision: prepared.revision,
    focus: prepared.focus ?? null,
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
  let parsed;
  try {
    parsed = await readGhJson(
      gh,
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
    if (err?.kind === "json") {
      throw new Pause("issue-read-failed", "the issue read returned an unreadable value");
    }
    if (err?.kind === "empty" || err?.kind === "timeout" || err?.kind === "status") {
      throw new Pause("issue-read-failed", "the issue read failed");
    }
    throw new Pause("issue-read-failed", `the issue read failed: ${err.message}`);
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
  const callGh = boundedRunner(gh, deps.ghTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS, signal);
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
      if (failed.length > 0 && !approvalMatches(state)) {
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
      const checkout = await readCheckout(state.workTree.path);
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
              focus: state.focus ?? null,
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
      const issues = await readIssueList({ gh: callGh, repo: prepared.repo });
      state = { ...state, existingIssues: issues };
      await writeState(runsRoot, state);
    }

    if (state.pendingCreate !== null) {
      state = await reconcilePendingCreate({ state, gh: callGh });
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
            focus: state.focus ?? null,
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

    state = await createIssues({ state, runsRoot, gh: callGh, signal });
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
    logInfo(`audit ${state.id}: creating issue ${JSON.stringify(finding.title)}`);
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
      logError(`audit ${state.id}: issue creation failed: ${err.message}`);
      throw new Pause("issue-create-failed", `the issue creation failed: ${err.message}`);
    }
    if (reply?.status !== 0) {
      logError(`audit ${state.id}: issue creation failed: gh exited ${reply?.status ?? "unknown"}`);
      throw new Pause("issue-create-failed", "the issue creation failed");
    }
    const number = issueNumberFromUrl(reply.stdout);
    if (number === null) {
      logError(`audit ${state.id}: issue creation failed: the reply held no issue number`);
      throw new Pause("issue-create-failed", "the created issue returned no number");
    }
    logInfo(`audit ${state.id}: created issue #${number}`);
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
