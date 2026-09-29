import { readFile } from "node:fs/promises";
import { normalizeAgent } from "../agents/index.mjs";
import { ROLE_KINDS } from "./args.mjs";

/**
 * Reads the earlier headless run from its `--transcript` file, the only record
 * that holds the final role session ids (#362). Rejects a file that is
 * unreadable, not JSON, has `events` that are not a list, or is missing a role
 * with a string `kind` and a string or null `sessionId`.
 * @param {string} path
 * @returns {Promise<{ cwd: string, roles: object }>}
 */
export async function readContinuation(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--continue-from cannot read ${path}: ${err.message}`);
  }
  let transcript;
  try {
    transcript = JSON.parse(text);
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
      (earlier.sessionId !== null && typeof earlier.sessionId !== "string")
    ) {
      throw new Error(`--continue-from ${path} has an invalid ${role} role.`);
    }
  }
  return transcript;
}

/**
 * Copies the earlier session ids onto the new roles after checking that each
 * session can resume: the role kind, the effective model (see `effectiveModel`),
 * and the work tree must equal the earlier run's, because a session id is valid
 * only for the CLI that created it and a provider keeps a session per project
 * directory. Effort counts only inside an OpenCode effective model. Changes no
 * role when it throws. A role that never ran keeps a null id and starts a new
 * session.
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
    const was = effectiveModel(before);
    const is = effectiveModel(now);
    if (normalizeAgent(now.kind) === "opencode" && is === null) {
      throw new Error(
        `--continue-from: ${role} uses opencode with no --${role}-model, so its effective model is the OpenCode default, which the transcript does not record and which can change between runs. Pass the same explicit --${role}-model in the earlier run and this one.`,
      );
    }
    if (was !== is) {
      throw new Error(
        `--continue-from: ${role} model was ${describeModel(was)} in the earlier run, not ${describeModel(is)}.`,
      );
    }
  }
  for (const role of ROLE_KINDS) {
    roles[role].sessionId = earlier.roles[role].sessionId;
  }
}

/**
 * The model a role's adapter passes to its CLI, or null when it passes none. The
 * OpenCode adapter joins effort to the model as `<model>#<effort>` and passes no
 * `--model` without one, so effort changes that model and a missing model is the
 * CLI default. The other adapters pass the model alone and effort as a separate flag.
 * @param {{ kind: string, model?: string | null, effort?: string | null }} role
 * @returns {string | null}
 */
export function effectiveModel({ kind, model, effort }) {
  if (!model) return null;
  return normalizeAgent(kind) === "opencode" && effort ? `${model}#${effort}` : model;
}

function describeModel(model) {
  return model ? JSON.stringify(model) : "(default)";
}
