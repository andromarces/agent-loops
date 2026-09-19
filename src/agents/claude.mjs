import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

export async function runClaude(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
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

  const { stdout } = await exec("claude", args, { cwd, input: prompt, timeout, signal, role });
  const parsed = parseJson(stdout, "Claude Code");

  let sessionId;
  let resultEvent;

  if (Array.isArray(parsed)) {
    sessionId = parsed.map((event) => event?.session_id).find(Boolean);
    resultEvent = parsed.find((event) => event?.type === "result");
  } else {
    sessionId = parsed.session_id;
    resultEvent = parsed;
  }

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  state.sessionId = sessionId;
  const response = resultEvent?.result;

  // `usage` covers the top-level loop only; `modelUsage` and `total_cost_usd` include subagents.
  const usage = {};
  if (resultEvent?.modelUsage) usage.models = resultEvent.modelUsage;
  if (resultEvent?.usage) usage.mainLoop = resultEvent.usage;
  if (typeof resultEvent?.total_cost_usd === "number") {
    usage.totalCostUsd = resultEvent.total_cost_usd;
  }
  if (Object.keys(usage).length > 0) {
    state.usage = usage;
  } else {
    delete state.usage;
  }

  return String(response ?? "").trim();
}
