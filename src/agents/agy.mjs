import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import { asSessionId, keepFailedSessionId, setMainLoopUsage } from "./shared.mjs";

// In the probe (agy 1.2.13), agy warned on stderr with this text, exited 0, and started a new
// conversation when `--conversation` named one it does not have. The run succeeds, so no error
// reaches the runtime. The pattern matches any quoted conversation name, not only the requested id.
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
    // A failed turn can print a result object with an empty `conversation_id`. Keep a non-empty one on a
    // first turn; keepFailedSessionId never replaces an id already on the state.
    try {
      keepFailedSessionId(state, JSON.parse(err?.stdout ?? "")?.conversation_id);
    } catch {
      // Not JSON: the failure names no conversation.
    }
    throw err;
  }
  const result = parseJson(stdout, "Antigravity CLI");

  const conversationId = asSessionId(result.conversation_id);
  if (!conversationId) {
    throw new Error("Antigravity did not return a conversation_id.");
  }

  // known-limit: there is no mismatch check, so any valid id the result carries replaces the
  // resumed one. A resumed turn carries no preamble, so a new conversation lacks it, and the turn
  // already ran, so a rerun would repeat its edits. The warning is logged only when stderr matches
  // MISSING_SESSION; a different id without that text is adopted silently.
  if (requestedSessionId && MISSING_SESSION.test(stderr ?? "")) {
    logWarn(
      `agy did not find conversation ${requestedSessionId}; the turn ran in new conversation ${conversationId} without the role preamble`,
    );
  }
  state.sessionId = conversationId;
  setMainLoopUsage(state, result?.usage);

  return String(result.response ?? "").trim();
}
