import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import { keepFailedSessionId, setMainLoopUsage } from "./shared.mjs";

// agy warns on stderr, exit 0, and starts a new conversation when `--conversation` names one it
// does not have. The run succeeds, so no error reaches the runtime.
const MISSING_SESSION = /conversation "[^"]*" not found/i;

export async function runAgy(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
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
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await exec("agy", args, { cwd, input: prompt, timeout, signal, role }));
  } catch (err) {
    // A failed turn can print a result object with an empty `conversation_id`. Keep a non-empty one.
    try {
      keepFailedSessionId(state, JSON.parse(err?.stdout ?? "")?.conversation_id);
    } catch {
      // Not JSON: the failure names no conversation.
    }
    throw err;
  }
  const result = parseJson(stdout, "Antigravity CLI");

  if (!result.conversation_id) {
    throw new Error("Antigravity did not return a conversation_id.");
  }

  // known-limit: the new conversation has no role preamble, and the turn already ran, so a rerun
  // would repeat its edits. Warn and adopt the new id; a rerun as a first turn needs a decision on
  // duplicate work.
  if (requestedSessionId && MISSING_SESSION.test(stderr ?? "")) {
    logWarn(
      `agy did not find conversation ${requestedSessionId}; the turn ran in new conversation ${result.conversation_id} without the role preamble`,
    );
  }
  state.sessionId = result.conversation_id;
  setMainLoopUsage(state, result?.usage);

  return String(result.response ?? "").trim();
}
