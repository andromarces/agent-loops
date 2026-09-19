import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

export async function runClaude(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal } = options;
  const args = ["-p"];

  if (state.sessionId) {
    args.push("--resume", state.sessionId);
  }

  if (readOnly) {
    args.push("--permission-mode", "plan");
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--effort", state.effort);
  }

  args.push("--output-format", "json");

  const { stdout } = await exec("claude", args, { cwd, input: prompt, timeout, signal });
  const parsed = parseJson(stdout, "Claude Code");

  let sessionId;
  let response;

  if (Array.isArray(parsed)) {
    sessionId = parsed.map((event) => event?.session_id).find(Boolean);
    response = parsed.find((event) => event?.type === "result")?.result;
  } else {
    sessionId = parsed.session_id;
    response = parsed.result;
  }

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  state.sessionId = sessionId;

  return String(response ?? "").trim();
}
