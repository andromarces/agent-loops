import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

export async function runClaude(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const args = ["-p"];
  const execOptions = { cwd, input: prompt, timeout, signal, role };

  if (state.sessionId) {
    args.push("--resume", state.sessionId);
  }

  if (readOnly) {
    args.push("--permission-mode", "plan");
    // Plan mode is a write guard here, not a planning workflow. Without this variable it
    // delegates research to the built-in Explore and Plan subagents, which inherit the role
    // model (Explore capped at Opus on the Claude API). Requires Claude Code v2.1.198+.
    execOptions.env = { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1" };
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--effort", state.effort);
  }

  args.push("--output-format", "json");

  const { stdout } = await exec("claude", args, execOptions);
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
