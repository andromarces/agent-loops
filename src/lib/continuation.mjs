import { readFile } from "node:fs/promises";
import { normalizeAgent } from "../agents/index.mjs";
import { ROLE_KINDS } from "./args.mjs";

/**
 * Reads the earlier headless run from its `--transcript` file, the only record
 * that holds the final role session ids (#362). Rejects a file that is
 * unreadable, not JSON, or missing a role with a string `kind` and a string or
 * null `sessionId`.
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
 * session can resume: the role kind and model must equal the earlier run's, and
 * so must the work tree, because a provider keeps a session per project
 * directory. Effort is not compared, because it changes no session. Changes no
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
    if ((before.model ?? null) !== (now.model ?? null)) {
      throw new Error(
        `--continue-from: ${role} model was ${describeModel(before.model)} in the earlier run, not ${describeModel(now.model)}.`,
      );
    }
  }
  for (const role of ROLE_KINDS) {
    roles[role].sessionId = earlier.roles[role].sessionId;
  }
}

function describeModel(model) {
  return model ? JSON.stringify(model) : "(default)";
}
