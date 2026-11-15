// Owner decisions of one batch (adr/0110-release-batch-slots-on-owner-decisions.md decisions 1
// to 4). A decision records the reason, the evidence, the options, and the recommendation. An
// answer is an exclusive file bound to one decision, so two answers cannot both win. Every
// malformed record fails closed.
import { randomUUID } from "node:crypto";
import { isJsonObject } from "../lib/json.mjs";
import { sha256 } from "../lib/hash.mjs";
import { logInfo, logWarn } from "../lib/log.mjs";
import { ownerAlive } from "../lib/process-identity.mjs";
import {
  batchPaths,
  createExclusive,
  readLoop,
  readManifest,
  readStoreText,
  releaseClaim,
  updateLoop,
} from "./store.mjs";

/** The fixed options of a decision that recovery can resume. `resume` is the recommendation. */
export const DECISION_OPTIONS = [
  { key: "resume", label: "Resume the loop after the owner resolves the state" },
  { key: "abandon", label: "Stop the loop as failed and keep its work tree" },
];
/** The options of a loop whose step count cannot be proven, so no resume option relaunches. */
export const UNVERIFIED_STEPS_OPTIONS = [
  { key: "abandon", label: "Stop the loop as failed and keep its work tree", recommended: true },
  { key: "skip", label: "Stop the loop as skipped and keep its work tree" },
];
const RECOMMENDED_OPTION = "resume";
/** The failure reason of a loop that the owner abandons. */
export const ABANDON_REASON = "owner-abandoned";
/** The skip reason of a loop that the owner stops as skipped. */
export const SKIP_REASON = "owner-skipped";

const OPERATION_KEYS = new Set(["resume", "abandon", "skip"]);

/** The options of a decision for `reason`. An unprovable step count offers no resume option. */
export function optionsForReason(reason) {
  return reason === "unverified-steps" ? UNVERIFIED_STEPS_OPTIONS : DECISION_OPTIONS;
}

/** The recommended key of an option list. */
export function recommendedOf(options) {
  return options.find((option) => option.recommended)?.key ?? options[0]?.key ?? null;
}

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const ITEM_KEY = /^(?:pr|task)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isItemKey = (value) => (Number.isInteger(value) && value >= 1) || ITEM_KEY.test(value);

/**
 * The id of one decision state. The batch, issue, attempt, and a short reason hash keep it unique
 * across batches and stable across a resume of the same state.
 */
export function newDecisionId(batchId, issue, attempt, reason) {
  const prefix = typeof issue === "number" ? "issue" : "item";
  return `${batchId}-${prefix}-${issue}-${attempt}-${sha256(String(reason)).slice(0, 8)}`;
}

function decisionProblem(value, id, batchId) {
  if (!isJsonObject(value)) return "the decision is not a JSON object";
  if (value.id !== id) return "the decision id does not match its file";
  if (value.batchId !== batchId) return "the decision names another batch";
  if (!isItemKey(value.issue)) return "the decision has no issue";
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

function answerProblem(value, decisionId, batchId, options = null, issue = null) {
  if (!isJsonObject(value)) return "the answer is not a JSON object";
  if (value.decisionId !== decisionId) return "the answer names another decision";
  if (value.batchId !== batchId) return "the answer names another batch";
  if (!isItemKey(value.issue)) return "the answer has no issue";
  if (issue !== null && value.issue !== issue) return "the answer names another issue";
  if (!nonEmpty(value.option)) return "the answer names no option";
  if (options !== null && !options.includes(value.option)) {
    return `the answer names an unlisted option: ${value.option}`;
  }
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

/**
 * Reads one answer. Returns null when it is missing and a refusal object when it is malformed.
 * `options` and `issue` bind the answer to the decision that lists it.
 */
export async function readAnswer(runsRoot, batchId, decisionId, options = null, issue = null) {
  const file = batchPaths(runsRoot).answer(batchId, decisionId);
  const text = await readStoreText(file);
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: `the answer is not valid JSON: ${file}` };
  }
  const problem = answerProblem(value, decisionId, batchId, options, issue);
  return problem === null ? { ok: true, answer: value } : { ok: false, reason: problem };
}

/**
 * Creates one pending decision with an exclusive create and no overwrite. A repeated create of the
 * same id returns the existing record and writes nothing, not even a temporary file. Returns
 * `{ created, decision }`, or `{ created: false, decision: null, error }` for an unreadable file.
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
  const existing = await readDecision(runsRoot, batchId, id);
  if (existing !== null && existing.ok) return { created: false, decision: existing.decision };
  if (existing !== null && !existing.ok) {
    return { created: false, decision: null, error: existing.reason };
  }
  const file = batchPaths(runsRoot).decision(batchId, id);
  const created = await createExclusive(file, `${JSON.stringify(record, null, 2)}\n`);
  if (created) return { created: true, decision: record };
  const raced = await readDecision(runsRoot, batchId, id);
  if (raced !== null && raced.ok) return { created: false, decision: raced.decision };
  return {
    created: false,
    decision: null,
    error: raced?.reason ?? `the decision record is missing: ${file}`,
  };
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
  const keys = read.decision.options.map((entry) => entry.key);
  if (!keys.includes(option) || !OPERATION_KEYS.has(option)) {
    return {
      ok: false,
      usage: true,
      reason: `Option ${option} is not one of: ${keys.join(", ")}.`,
    };
  }
  const existing = await readAnswer(runsRoot, batchId, decisionId, keys, read.decision.issue);
  if (existing !== null && !existing.ok) return { ok: false, reason: existing.reason };
  if (existing !== null) {
    return { ok: false, usage: true, reason: `Decision ${decisionId} is already answered.` };
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

  const live =
    typeof loop.pid === "number" &&
    (await ownerAlive({ pid: loop.pid, startTime: loop.startTime }));
  if (live) {
    logInfo(`decision ${decisionId}: answered with ${option}, applied after the process ends`);
    return { ok: true, answer };
  }

  try {
    await updateLoop(runsRoot, batchId, read.decision.issue, (current) => {
      if (current.decision !== decisionId || current.status !== "needs-owner") return undefined;
      if (option === "abandon") {
        return { ...current, status: "failed", reason: ABANDON_REASON, decisionAnswer: option };
      }
      if (option === "skip") {
        return {
          ...current,
          status: "skipped",
          skipReason: SKIP_REASON,
          reason: "the owner stopped the loop",
          decisionAnswer: option,
        };
      }
      return {
        ...current,
        status: "queued",
        reason: null,
        skipReason: null,
        decisionAnswer: option,
      };
    });
    if (option === "abandon" || option === "skip") {
      await releaseClaim(runsRoot, manifest.repoKey, read.decision.issue, { batchId });
    }
  } catch (err) {
    logWarn(
      `decision ${decisionId}: the answer is recorded. The loop update follows on resume: ${err?.message ?? err}`,
    );
  }
  logInfo(`decision ${decisionId}: answered with ${option}`);
  return { ok: true, answer };
}

/** The comma-joined option keys of a decision, or of the default options when it is unreadable. */
function optionKeysOf(decision) {
  return (decision?.options ?? DECISION_OPTIONS).map((option) => option.key).join(", ");
}

const decisionOptions = (decision) => decision.options.map((option) => option.key);

/**
 * The owner-decision lifecycle of one batch: a stop creates or reuses the pending decision, and an
 * answer applies to its loop. Every dependency is explicit, so the lifecycle holds no supervisor
 * closure. `changeLoop` writes one loop checkpoint, `notify` sends one event, and `loopOf` reads the
 * in-memory loop that `changeLoop` stored.
 */
export function createOwnerDecisions({
  runsRoot,
  batchId,
  repoKey,
  pending,
  changeLoop,
  notify,
  loopOf,
}) {
  /**
   * Moves one loop to `needs-owner` with its pending decision and releases its slot. A later stop
   * with the same reason and attempt reuses an unanswered decision; an applied answer creates a new
   * id. A malformed decision file keeps the loop pending with the refusal as its reason. Returns
   * whether this call created the decision.
   */
  const markNeedsOwner = async (issue, reason, { evidence = null, extra = {} } = {}) => {
    const current = await readLoop(runsRoot, batchId, issue);
    const attempt = Number.isInteger(current?.attempts) ? current.attempts : 0;
    let decisionId = null;
    let created = false;
    const options = optionsForReason(reason);
    const recommended = recommendedOf(options);

    if (typeof current?.decision === "string") {
      const existing = await readDecision(runsRoot, batchId, current.decision);
      if (
        existing !== null &&
        existing.ok &&
        existing.decision.reason === reason &&
        existing.decision.attempt === attempt
      ) {
        const answer = await readAnswer(
          runsRoot,
          batchId,
          current.decision,
          decisionOptions(existing.decision),
          issue,
        );
        const applied = current.decisionAnswer != null;
        if (answer === null || !applied) decisionId = current.decision;
      }
    }
    if (decisionId === null) {
      let idForState = newDecisionId(batchId, issue, attempt, reason);
      const existingAtId = await readDecision(runsRoot, batchId, idForState);
      if (existingAtId !== null && !existingAtId.ok) {
        const refusal = `the decision file is unreadable: ${existingAtId.reason}`;
        logWarn(`issue ${issue}: ${refusal}`);
        await changeLoop(issue, {
          status: "needs-owner",
          reason: refusal,
          skipReason: null,
          decision: idForState,
          ...extra,
        });
        pending.add(issue);
        return false;
      }
      if (existingAtId !== null && existingAtId.ok) {
        const sameState =
          existingAtId.decision.reason === reason && existingAtId.decision.attempt === attempt;
        const answer = await readAnswer(
          runsRoot,
          batchId,
          idForState,
          decisionOptions(existingAtId.decision),
          issue,
        );
        if (sameState && answer === null) {
          decisionId = idForState;
        } else {
          idForState = `${idForState}-${randomUUID().slice(0, 8)}`;
        }
      }
      if (decisionId === null) {
        const result = await createDecision({
          runsRoot,
          batchId,
          id: idForState,
          issue,
          attempt,
          reason,
          evidence,
          options,
          recommended,
        });
        if (result.decision === null) {
          const refusal = `the decision file is unreadable: ${result.error ?? idForState}`;
          logWarn(`issue ${issue}: ${refusal}`);
          await changeLoop(issue, {
            status: "needs-owner",
            reason: refusal,
            skipReason: null,
            decision: idForState,
            ...extra,
          });
          pending.add(issue);
          return false;
        }
        decisionId = result.decision.id;
        created = result.created;
      }
    }
    // A recorded live process keeps its pid and stamp, so a later resume re-checks it first.
    await changeLoop(issue, {
      status: "needs-owner",
      reason,
      skipReason: null,
      decision: decisionId,
      ...(created ? { decisionAnswer: null } : {}),
      ...extra,
    });
    pending.add(issue);
    if (created) {
      logInfo(`issue ${issue}: decision ${decisionId} created (${reason})`);
      const read = await readDecision(runsRoot, batchId, decisionId);
      const decision = read?.ok ? read.decision : null;
      await notify({
        kind: "decision",
        title: "Batch decision needed",
        text: `Batch ${batchId} issue ${issue} needs a decision: ${reason}. Options: ${optionKeysOf(decision)}. Recommended: ${recommendedOf(decision?.options ?? options)}. Answer: agent-loop batch answer --batch ${batchId} --decision ${decisionId} --option <key>`,
      });
    }
    return created;
  };

  /**
   * Applies the recorded answer of one pending decision. `resume` queues the loop and `abandon` or
   * `skip` ends it as terminal and releases its claim. A live loop, a missing or malformed record,
   * and an unknown option leave the loop pending.
   */
  const applyDecisionAnswer = async (issue, current) => {
    if (
      current.pid != null &&
      (await ownerAlive({ pid: current.pid, startTime: current.startTime }))
    ) {
      return { kind: "pending" };
    }
    if (typeof current.decision !== "string") {
      await markNeedsOwner(issue, current.reason ?? "needs-owner", {
        evidence: current.reason ?? null,
        extra: { prUndeclared: current.prUndeclared ?? null },
      });
      return { kind: "pending" };
    }
    const decision = await readDecision(runsRoot, batchId, current.decision);
    if (decision === null || !decision.ok) {
      logWarn(`issue ${issue}: decision ${current.decision} is unreadable. The loop stays pending`);
      return { kind: "malformed" };
    }
    const answer = await readAnswer(
      runsRoot,
      batchId,
      current.decision,
      decisionOptions(decision.decision),
      current.issue,
    );
    if (answer !== null && !answer.ok) {
      logWarn(`issue ${issue}: answer ${current.decision} is unreadable. The loop stays pending`);
      return { kind: "malformed" };
    }
    if (answer === null) return { kind: "pending" };
    const option = answer.answer.option;
    if (option === "resume") {
      await changeLoop(issue, {
        status: "queued",
        reason: null,
        skipReason: null,
        decisionAnswer: option,
      });
      return { kind: "resume", loop: loopOf(issue) };
    }
    if (option === "abandon" || option === "skip") {
      const patch =
        option === "abandon"
          ? { status: "failed", reason: ABANDON_REASON, skipReason: null }
          : { status: "skipped", skipReason: SKIP_REASON, reason: "the owner stopped the loop" };
      await changeLoop(issue, { ...patch, decisionAnswer: option });
      await releaseClaim(runsRoot, repoKey, issue, { batchId });
      return { kind: "terminal" };
    }
    logWarn(`issue ${issue}: decision ${current.decision} names an unknown option`);
    return { kind: "malformed" };
  };

  return { markNeedsOwner, applyDecisionAnswer };
}
