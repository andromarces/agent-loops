import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

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

  const { stdout } = await exec("agy", args, { cwd, input: prompt, timeout, signal, role });
  const result = parseJson(stdout, "Antigravity CLI");

  if (!result.conversation_id) {
    throw new Error("Antigravity did not return a conversation_id.");
  }

  state.sessionId = result.conversation_id;

  return String(result.response ?? "").trim();
}
