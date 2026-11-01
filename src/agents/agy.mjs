import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import {
  asSessionId,
  keepFailedSessionId,
  markCapacityFailure,
  setMainLoopUsage,
  turnExecOptions,
} from "./shared.mjs";

// agy 1.4.12 writes one machine line to stderr for a failed turn: `AGY_ERROR: {...}`. Its
// `short_error` field opens with the provider status and code, for example
// `UNAVAILABLE (code 529): ...`, which a probe against a local 529 server captured. A provider
// capacity reply carries code 529 (issue #1323).
const AGY_ERROR_PREFIX = "AGY_ERROR: ";
const CAPACITY_SHORT_ERROR = /^(?:[A-Z_]+ )?\(code 529\): /;

/**
 * Marks a failed turn whose terminal failure is a provider capacity reply. The terminal failure is
 * the last complete `AGY_ERROR` line, so an earlier failure followed by another cause is never
 * marked. A truncated or malformed line is dropped, so an earlier line stays decisive.
 * @param {unknown} err the error `exec` threw
 */
function flagCapacityFailure(err) {
  const payloads = String(err?.stderr ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(AGY_ERROR_PREFIX))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(AGY_ERROR_PREFIX.length))];
      } catch {
        return [];
      }
    });
  const shortError = payloads.at(-1)?.short_error;
  if (typeof shortError === "string" && CAPACITY_SHORT_ERROR.test(shortError)) {
    markCapacityFailure(err);
  }
}

export async function runAgy(state, prompt, options = {}) {
  const { readOnly } = options;
  // --input-format text reads the prompt from stdin; -p is omitted because it consumes the next arg as the prompt value.
  const args = ["--input-format", "text", "--output-format", "json"];

  if (readOnly) {
    args.push("--mode", "plan");
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--effort", state.effort);
  }

  if (state.sessionId) {
    args.push("--conversation", state.sessionId);
  }

  const requestedSessionId = state.sessionId;
  delete state.conversationReplaced;
  let stdout;
  try {
    ({ stdout } = await exec("agy", args, turnExecOptions(options, prompt)));
  } catch (err) {
    // A failed turn can print a result object with an empty `conversation_id`. Keep a non-empty one on a
    // first turn; keepFailedSessionId never replaces an id already on the state.
    try {
      keepFailedSessionId(state, JSON.parse(err?.stdout ?? "")?.conversation_id);
    } catch {
      // Not JSON: the failure names no conversation.
    }
    flagCapacityFailure(err);
    throw err;
  }
  const result = parseJson(stdout, "Antigravity CLI");

  const conversationId = asSessionId(result.conversation_id);
  if (!conversationId) {
    throw new Error("Antigravity did not return a conversation_id.");
  }

  // In the probe (agy 1.2.13), a resumed id that agy does not have printed a not-found warning on
  // stderr, exited 0, and ran the turn in a new conversation. The turn already ran, so a rerun would
  // repeat its edits. The new id is adopted, and `conversationReplaced` tells the runtime that the
  // conversation never received the role preamble. The stderr text is not matched: any different id
  // means a new conversation.
  if (requestedSessionId && conversationId !== requestedSessionId) {
    logWarn(
      `agy did not resume conversation ${requestedSessionId}; the turn ran in new conversation ${conversationId} without the role preamble`,
    );
    state.conversationReplaced = true;
  }
  state.sessionId = conversationId;
  setMainLoopUsage(state, result?.usage);

  return String(result.response ?? "").trim();
}
