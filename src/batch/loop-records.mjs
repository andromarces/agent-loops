// The batch identity, the progress line, and the loop record shapes shared by the batch start,
// the audit store, and the status read. These helpers keep no run state.
import { randomUUID } from "node:crypto";
import { redactEnvSecrets } from "../lib/redact.mjs";
import { defaultMode } from "./items.mjs";
import { missingLoopReport } from "./report.mjs";

/** Generates a batch id that is safe as a directory and a branch segment. */
export function newBatchId(now = new Date()) {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** A progress line on stderr, because stdout carries one JSON summary. Secret-named environment values are redacted (ADR 0017). */
export function progress(message) {
  process.stderr.write(`[agent-loop] batch: ${redactEnvSecrets(message)}\n`);
}

export function queuedLoop(paths, id, item, maxSteps) {
  const key = item.key;
  return {
    issue: key,
    key,
    kind: item.kind,
    number: item.number ?? null,
    text: item.text ?? null,
    mode: item.mode ?? defaultMode(item.kind),
    head: item.head ?? null,
    headRefName: item.headRefName ?? null,
    foreign: item.foreign === true,
    prTitle: item.title ?? null,
    taskOverride: item.task ?? null,
    status: "queued",
    skipReason: null,
    reason: null,
    attempts: 0,
    branch: item.kind === "pr" ? (item.headRefName ?? `pr-${item.number}`) : `batch/${id}/${key}`,
    workTree: null,
    transcript: paths.transcript(id, key),
    log: null,
    pid: null,
    startTime: null,
    stepsUsed: 0,
    remainingSteps: maxSteps,
    pr: item.kind === "pr" ? item.number : null,
    prUndeclared: null,
    cleanup: null,
    decision: null,
    decisionAnswer: null,
    blockingIssues: [],
    report: null,
  };
}

/**
 * Whether a loop record names an issue item. A record written before item kinds carries no kind and
 * is an issue item, as the batch entry reads it.
 */
export function isIssueLoop(loop) {
  return loop?.kind === undefined || loop.kind === "issue";
}

/**
 * The reasons a succeeded loop reads as partial, or an empty list. A finish summary that reports
 * the item not done names one reason. An issue item also names one reason when it holds no pull
 * request, its pull request does not close the issue, or the closing evidence cannot be read
 * (adr/0178-mark-a-succeeded-loop-that-does-not-deliver-its-item.md).
 * @returns {string[]}
 */
function partialReasons(loop) {
  if (loop?.status !== "succeeded") return [];
  const reasons = [];
  const notDone = loop.report?.summary?.notDone;
  if (
    typeof notDone === "string" &&
    notDone.trim() !== "" &&
    notDone.trim().toLowerCase() !== "none"
  ) {
    reasons.push("not-done");
  }
  if (isIssueLoop(loop)) {
    if ((loop.pr ?? loop.prUndeclared ?? null) === null) reasons.push("no-pull-request");
    else if (loop.pullRequestClosesIssue === false) {
      reasons.push("pull-request-does-not-close-issue");
    } else if (loop.pullRequestClosesIssue !== true) {
      reasons.push("closing-reference-unread");
    }
  }
  return reasons;
}

export function loopEntry(loop) {
  const partial = partialReasons(loop);
  return {
    issue: loop.issue,
    ...(loop.kind !== undefined && loop.kind !== "issue"
      ? { kind: loop.kind, mode: loop.mode, number: loop.number ?? null }
      : {}),
    status: loop.status,
    skipReason: loop.skipReason,
    reason: loop.reason,
    workTree: loop.workTree?.path ?? null,
    branch: loop.branch,
    pr: loop.pr,
    prUndeclared: loop.prUndeclared ?? null,
    attempts: loop.attempts,
    stepsUsed: loop.stepsUsed,
    remainingSteps: loop.remainingSteps,
    log: loop.log,
    transcript: loop.transcript,
    cleanup: loop.cleanup,
    decision: loop.decision ?? null,
    blockingIssues: loop.blockingIssues ?? [],
    report: loop.report ?? missingLoopReport(),
    ...(partial.length === 0 ? {} : { partial: true, partialReasons: partial }),
  };
}
