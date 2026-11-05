import { readFile } from "node:fs/promises";
import { agentHas, normalizeAgent } from "./agent-kinds.mjs";
import { logInfo, logWarn } from "./log.mjs";
import { readableErrorText } from "./error-message.mjs";
import { isFatalTurnError } from "./snapshot.mjs";
import { ROLE_KINDS, recordedReviewerSandbox } from "./args.mjs";
import { sha256 } from "./hash.mjs";
import { readSessionRecord } from "./session-record.mjs";

/**
 * Reads the earlier headless run from its `--transcript` file, the only record
 * that holds the final role session ids (#362). A session record that a crashed run left outside the
 * work tree can add the id of one claude first turn (ADR 0027). Rejects a file that is
 * unreadable, not JSON, has `events` that are not a list, or is missing a role
 * with a string `kind`, a string or null `sessionId`, and no `sessionUnconfirmed` or `conversationReplaced`, or a boolean one.
 * @param {string} path
 * @returns {Promise<{ cwd: string, roles: object, events?: object[] }>}
 */
export async function readContinuation(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(`--continue-from cannot read ${path}: ${readableErrorText(err)}`);
  }
  let transcript;
  try {
    transcript = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`--continue-from ${path} is not valid JSON.`);
  }
  if (!transcript?.roles || typeof transcript.roles !== "object") {
    throw new Error(`--continue-from ${path} has no roles, so it is not an agent-loop transcript.`);
  }
  if (transcript.events !== undefined && !Array.isArray(transcript.events)) {
    throw new Error(`--continue-from ${path} has events that are not a list.`);
  }
  for (const role of ROLE_KINDS) {
    const earlier = transcript.roles[role];
    if (
      typeof earlier?.kind !== "string" ||
      (earlier.sessionId !== null && typeof earlier.sessionId !== "string") ||
      (earlier.sessionUnconfirmed !== undefined &&
        typeof earlier.sessionUnconfirmed !== "boolean") ||
      (earlier.conversationReplaced !== undefined &&
        typeof earlier.conversationReplaced !== "boolean") ||
      (earlier.taskSentTo !== undefined && typeof earlier.taskSentTo !== "string")
    ) {
      throw new Error(`--continue-from ${path} has an invalid ${role} role.`);
    }
  }
  await applySessionRecord(path, bytes, transcript);
  return transcript;
}

/**
 * The reviewer sandbox mode that the earlier run recorded in the transcript `options`. A transcript
 * from before ADR 0038 has none: it gets `workspace-write` when it holds the legacy
 * `reviewerWorkspaceWrite: true` and `read-only` otherwise, never `none`.
 * @param {{ options?: object }} transcript
 * @param {string} path the transcript path, for the refusal text
 * @returns {"none" | "read-only" | "workspace-write"}
 */
export function earlierReviewerSandbox(transcript, path) {
  const mode = recordedReviewerSandbox(
    transcript.options?.reviewerSandbox,
    transcript.options?.reviewerWorkspaceWrite,
  );
  if (mode === null) {
    throw new Error(`--continue-from ${path} has an invalid reviewerSandbox option.`);
  }
  return mode;
}

/**
 * Gives a claude role the pre-assigned id that a crashed run saved outside the work tree. The
 * record is untrusted: it applies only when it binds to this transcript state, work tree, and run, the
 * role is a claude role with no id, and the id stays unconfirmed, so the ownership check of the
 * adapter always runs before the id resumes (ADR 0027).
 */
async function applySessionRecord(path, bytes, transcript) {
  const record = await readSessionRecord(path, {
    digest: sha256(bytes),
    cwd: transcript.cwd,
    runNonce: transcript.runNonce,
  });
  const earlier = record && transcript.roles[record.role];
  if (earlier?.kind === "claude" && earlier.sessionId === null) {
    transcript.roles[record.role] = {
      ...earlier,
      sessionId: record.sessionId,
      sessionUnconfirmed: true,
    };
  }
}

/**
 * Copies the earlier session ids onto the new roles after checking that each session can resume.
 * The role kind, recorded model, recorded effort, and work tree must equal the earlier run's.
 * A session id is valid only for the CLI that created it, and a provider keeps a session per
 * project directory. Model and effort compare exactly, so an omitted value matches only an omitted
 * value. The resolved model and its source carry over, and `verifyResolvedModels` compares the
 * model with the current default. A role that never ran keeps a null id and starts a new session,
 * and a throw changes no role.
 * @param {object} roles new run roles keyed by role name; mutated on success
 * @param {{ cwd: string, roles: object }} earlier
 * @param {string} cwd
 */
export function restoreSessions(roles, earlier, cwd) {
  if (earlier.cwd !== cwd) {
    throw new Error(
      `--continue-from: the earlier run used --cwd ${earlier.cwd}, not ${cwd}. A session resumes only in the work tree that created it.`,
    );
  }
  for (const role of ROLE_KINDS) {
    const before = earlier.roles[role];
    const now = roles[role];
    if (normalizeAgent(before.kind) !== normalizeAgent(now.kind)) {
      throw new Error(
        `--continue-from: ${role} was ${before.kind} in the earlier run, not ${now.kind}. A session id is valid only for the CLI that created it.`,
      );
    }
    for (const field of ["model", "effort"]) {
      if ((before[field] ?? null) !== (now[field] ?? null)) {
        throw new Error(
          `--continue-from: ${role} ${field} was ${describe(before[field])} in the earlier run, not ${describe(now[field])}.`,
        );
      }
    }
  }
  for (const role of ROLE_KINDS) {
    roles[role].sessionId = earlier.roles[role].sessionId;
    // An id that no CLI output confirmed keeps its mark, so the adapter verifies its owner (#395).
    if (earlier.roles[role].sessionUnconfirmed === true && roles[role].sessionId !== null) {
      roles[role].sessionUnconfirmed = true;
    }
    // A canceled turn left a replaced conversation without its preamble, so the new worker turn sends it.
    if (earlier.roles[role].conversationReplaced === true && roles[role].sessionId !== null) {
      roles[role].conversationReplaced = true;
    }
    // The task record names a conversation, so it carries over only with the session id it names.
    if (
      roles[role].sessionId !== null &&
      earlier.roles[role].taskSentTo === roles[role].sessionId
    ) {
      roles[role].taskSentTo = roles[role].sessionId;
    }
    // A model id or null (unresolved) carries over; an absent or malformed value is "not reported".
    const resolved = earlier.roles[role].resolvedModel;
    if (resolved === null || (typeof resolved === "string" && resolved)) {
      roles[role].resolvedModel = resolved;
      if (typeof resolved === "string") {
        const before = earlier.roles[role];
        if (Object.hasOwn(before, "resolvedModelSource")) {
          roles[role].resolvedModelSource = before.resolvedModelSource ?? null;
        }
      }
    }
  }
}

/**
 * Refuses a continuation when the model a CLI resolves now differs from the one the earlier run
 * recorded in `resolvedModel` (#394, ADR 0026). A recorded model id gets one probe turn in a new
 * session, and the probe sets `resolvedModel` and `initModel` on the state it receives. A Claude
 * worker record compares with the probe's `init` model when it exists, and with `resolvedModel`
 * otherwise. A Claude reviewer or orchestrator record compares with the probe's `resolvedModel`,
 * because that turn runs in plan mode. An old record with no source is accepted when the recorded
 * model equals the probe's `init` model, and any present source compares strictly. A probe that
 * names no model, or a recorded `null`, skips the comparison with a warning.
 * @param {object} roles new run roles after `restoreSessions`; not mutated
 * @param {{ probe: (state: object, role: string) => Promise<void> }} options
 */
// known-limit: each probe is a real model call.
export async function verifyResolvedModels(roles, { probe }) {
  for (const role of ROLE_KINDS) {
    const {
      kind,
      model,
      effort,
      resolvedModel: recorded,
      resolvedModelSource: source,
    } = roles[role];
    if (recorded === null) {
      logWarn(
        `--continue-from: the default-model check did not run for ${role} (${kind}), because the latest turn of the earlier run did not name one model.`,
      );
      continue;
    }
    if (typeof recorded !== "string" || !recorded) {
      if (agentHas(normalizeAgent(kind), "reportsResolvedModel")) {
        logWarn(
          `--continue-from: the default-model check did not run for ${role} (${kind}), because the earlier record has no resolved model.`,
        );
      } else {
        logInfo(
          `--continue-from: ${role} (${kind}) reports no resolved model, so a changed default model is not detected.`,
        );
      }
      continue;
    }
    const state = { kind, model, effort, sessionId: null };
    logInfo(`--continue-from: probing the model that ${role} (${kind}) resolves now`);
    try {
      await probe(state, role);
    } catch (err) {
      if (isFatalTurnError(err)) {
        throw err;
      }
      throw new Error(`--continue-from: ${role} model probe failed: ${readableErrorText(err)}`);
    }
    const workerInit = normalizeAgent(kind) === "claude" && role === "worker";
    const probeModel =
      workerInit && typeof state.initModel === "string" && state.initModel
        ? state.initModel
        : state.resolvedModel;
    if (typeof state.resolvedModel !== "string" || !state.resolvedModel) {
      logWarn(
        `--continue-from: the default-model check did not run for ${role} (${kind}), because the probe did not name one model.`,
      );
    } else if (probeModel !== recorded) {
      const compatible = role !== "worker" && source === undefined && state.initModel === recorded;
      if (!compatible) {
        throw new Error(
          `--continue-from: ${role} resolved to ${JSON.stringify(recorded)} in the earlier run, not ${JSON.stringify(probeModel)}. The CLI default or alias changed, and a session continues under the model that created it. The model flags must equal the earlier run's, so a new --${role}-model value is refused too. Restore the earlier default in the CLI, or start a new run without --continue-from.`,
        );
      }
      logWarn(
        `--continue-from: ${role} (${kind}) recorded ${JSON.stringify(recorded)} from the init event, and the probe answered on ${JSON.stringify(state.resolvedModel)}. The comparison used the init model.`,
      );
    }
  }
}

function describe(value) {
  return value ? JSON.stringify(value) : "(omitted)";
}

/**
 * Appends the earlier run's events to `events`, then one `continued` event that
 * keeps the earlier outcome a same-path transcript rewrite replaces. A loop, not
 * an argument spread: a spread over a long event list throws RangeError, and the
 * list has no bound.
 * @param {object[]} events destination; mutated
 * @param {{ events?: object[], exitCode?: number, error?: string | null, options?: { maxSteps?: number } }} earlier
 */
export function carryEarlierEvents(events, earlier) {
  for (const event of earlier.events ?? []) {
    events.push(event);
  }
  events.push({
    type: "continued",
    earlier: {
      exitCode: earlier.exitCode ?? null,
      error: earlier.error ?? null,
      maxSteps: earlier.options?.maxSteps ?? null,
    },
    at: new Date().toISOString(),
  });
}
