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

  let stdout;
  try {
    ({ stdout } = await exec("claude", args, { cwd, input: prompt, timeout, signal, role }));
  } catch (err) {
    // A non-zero exit can still carry a result event with usage. Expose it, then rethrow.
    let failed;
    try {
      failed = JSON.parse(err?.stdout ?? "");
    } catch {
      failed = undefined;
    }
    setUsage(state, findResultEvent(failed));
    throw err;
  }
  const parsed = parseJson(stdout, "Claude Code");

  const sessionId = Array.isArray(parsed)
    ? parsed.map((event) => event?.session_id).find(Boolean)
    : parsed.session_id;

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  state.sessionId = sessionId;
  const resultEvent = findResultEvent(parsed);
  setUsage(state, resultEvent);

  return String(resultEvent?.result ?? "").trim();
}

function findResultEvent(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.find((event) => event?.type === "result");
  }
  return parsed && typeof parsed === "object" ? parsed : undefined;
}

/**
 * Sets `state.usage` from a result event, or removes it when the event carries no usage.
 * `usage` covers the top-level loop only; `modelUsage` and `total_cost_usd` include subagents.
 */
function setUsage(state, resultEvent) {
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
}
