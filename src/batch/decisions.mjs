// Owner decisions of one batch (ADR 0109 decisions 1 to 4). A decision records the reason, the
// evidence, the options, and the recommendation. An answer is an exclusive file bound to one
// decision, so two answers cannot both win. Every malformed record fails closed.
import { isJsonObject } from "../lib/json.mjs";
import { sha256 } from "../lib/hash.mjs";
import { logInfo, logWarn } from "../lib/log.mjs";
import {
  batchPaths,
  createExclusive,
  readLoop,
  readManifest,
  readStoreText,
  releaseClaim,
  updateLoop,
} from "./store.mjs";

/** The fixed options of every decision. `resume` is the recommendation. */
export const DECISION_OPTIONS = [
  { key: "resume", label: "Resume the loop after the owner resolves the state" },
  { key: "abandon", label: "Stop the loop as failed and keep its work tree" },
];
export const RECOMMENDED_OPTION = "resume";
/** The failure reason of a loop that the owner abandons. */
export const ABANDON_REASON = "owner-abandoned";

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The id of one decision state. The batch, issue, attempt, and a short reason hash keep it unique
 * across batches and stable across a resume of the same state.
 */
export function newDecisionId(batchId, issue, attempt, reason) {
  return `${batchId}-issue-${issue}-${attempt}-${sha256(String(reason)).slice(0, 8)}`;
}

function decisionProblem(value, id, batchId) {
  if (!isJsonObject(value)) return "the decision is not a JSON object";
  if (value.id !== id) return "the decision id does not match its file";
  if (value.batchId !== batchId) return "the decision names another batch";
  if (!Number.isInteger(value.issue) || value.issue < 1) return "the decision has no issue";
  if (!Number.isInteger(value.attempt) || value.attempt < 0) {
    return "the decision has no attempt";
  }
  if (!nonEmpty(value.reason)) return "the decision has no reason";
  if (value.evidence !== null && typeof value.evidence !== "string") {
    return "the decision has unreadable evidence";
  }
  if (!Array.isArray(value.options) || value.options.length < 2) {
    return "the decision lists fewer than two options";
  }
  const keys = new Set();
  for (const option of value.options) {
    if (!isJsonObject(option) || !nonEmpty(option.key) || !nonEmpty(option.label)) {
      return "the decision holds a malformed option";
    }
    if (keys.has(option.key)) return "the decision repeats an option key";
    keys.add(option.key);
  }
  if (!keys.has(value.recommended)) return "the decision names no listed recommendation";
  return null;
}

function answerProblem(value, decisionId, batchId) {
  if (!isJsonObject(value)) return "the answer is not a JSON object";
  if (value.decisionId !== decisionId) return "the answer names another decision";
  if (value.batchId !== batchId) return "the answer names another batch";
  if (!nonEmpty(value.option)) return "the answer names no option";
  return null;
}

/** Reads one decision. Returns null when it is missing and a refusal object when it is malformed. */
export async function readDecision(runsRoot, batchId, decisionId) {
  const file = batchPaths(runsRoot).decision(batchId, decisionId);
  const text = await readStoreText(file);
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: `the decision is not valid JSON: ${file}` };
  }
  const problem = decisionProblem(value, decisionId, batchId);
  return problem === null ? { ok: true, decision: value } : { ok: false, reason: problem };
}

/** Reads one answer. Returns null when it is missing and a refusal object when it is malformed. */
export async function readAnswer(runsRoot, batchId, decisionId) {
  const file = batchPaths(runsRoot).answer(batchId, decisionId);
  const text = await readStoreText(file);
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: `the answer is not valid JSON: ${file}` };
  }
  const problem = answerProblem(value, decisionId, batchId);
  return problem === null ? { ok: true, answer: value } : { ok: false, reason: problem };
}

/**
 * Creates one pending decision with an exclusive create and no overwrite. A repeated create of the
 * same id returns the existing record and writes nothing. Returns `{ created, decision }`.
 */
export async function createDecision({
  runsRoot,
  batchId,
  id,
  issue,
  attempt,
  reason,
  evidence = null,
  options = DECISION_OPTIONS,
  recommended = RECOMMENDED_OPTION,
}) {
  const record = {
    id,
    batchId,
    issue,
    attempt,
    reason,
    evidence,
    options,
    recommended,
    createdAt: new Date().toISOString(),
  };
  const problem = decisionProblem(record, id, batchId);
  if (problem !== null) throw new Error(problem);
  const file = batchPaths(runsRoot).decision(batchId, id);
  const created = await createExclusive(file, `${JSON.stringify(record, null, 2)}\n`);
  if (created) return { created: true, decision: record };
  const existing = await readDecision(runsRoot, batchId, id);
  if (existing === null || !existing.ok) {
    throw new Error(existing?.reason ?? `the decision record is missing: ${file}`);
  }
  return { created: false, decision: existing.decision };
}

/**
 * Answers one decision with one listed option. The answer file is created exclusively, so exactly
 * one contender wins. A refusal writes nothing. The loop checkpoint update is best effort, and a
 * resume applies a recorded answer that the checkpoint does not show.
 * @returns {Promise<{ ok: true, answer: object } | { ok: false, usage?: boolean, reason: string }>}
 */
export async function answerDecision({ runsRoot, batchId, decisionId, option }) {
  const manifest = await readManifest(runsRoot, batchId);
  if (manifest === null) {
    return { ok: false, usage: true, reason: `No batch ${batchId}.` };
  }
  const read = await readDecision(runsRoot, batchId, decisionId);
  if (read === null) {
    return { ok: false, usage: true, reason: `No decision ${decisionId} in batch ${batchId}.` };
  }
  if (!read.ok) return { ok: false, reason: read.reason };
  const existing = await readAnswer(runsRoot, batchId, decisionId);
  if (existing !== null && !existing.ok) return { ok: false, reason: existing.reason };
  if (existing !== null) {
    return { ok: false, usage: true, reason: `Decision ${decisionId} is already answered.` };
  }
  const keys = read.decision.options.map((entry) => entry.key);
  if (!keys.includes(option)) {
    return {
      ok: false,
      usage: true,
      reason: `Option ${option} is not one of: ${keys.join(", ")}.`,
    };
  }
  const loop = await readLoop(runsRoot, batchId, read.decision.issue);
  if (loop === null) {
    return { ok: false, reason: `The loop of decision ${decisionId} has no checkpoint.` };
  }
  if (loop.decision !== decisionId || loop.status !== "needs-owner") {
    return { ok: false, usage: true, reason: `Decision ${decisionId} is already answered.` };
  }

  const answer = {
    decisionId,
    batchId,
    issue: read.decision.issue,
    option,
    createdAt: new Date().toISOString(),
  };
  const created = await createExclusive(
    batchPaths(runsRoot).answer(batchId, decisionId),
    `${JSON.stringify(answer, null, 2)}\n`,
  );
  if (!created) {
    return { ok: false, usage: true, reason: `Decision ${decisionId} is already answered.` };
  }

  try {
    await updateLoop(runsRoot, batchId, read.decision.issue, (current) => {
      if (current.decision !== decisionId || current.status !== "needs-owner") return undefined;
      return option === "abandon"
        ? {
            ...current,
            status: "failed",
            reason: ABANDON_REASON,
            decisionAnswer: option,
            pid: null,
            startTime: null,
          }
        : {
            ...current,
            status: "queued",
            reason: null,
            skipReason: null,
            decisionAnswer: option,
            pid: null,
            startTime: null,
          };
    });
    if (option === "abandon") {
      await releaseClaim(runsRoot, manifest.repoKey, read.decision.issue, { batchId });
    }
  } catch (err) {
    logWarn(
      `decision ${decisionId}: the answer is recorded; the loop update follows on resume: ${err?.message ?? err}`,
    );
  }
  logInfo(`decision ${decisionId}: answered with ${option}`);
  return { ok: true, answer };
}
