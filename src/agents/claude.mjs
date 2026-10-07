import { isJsonObject, parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import {
  asSessionId,
  childRan,
  flagMissingSession,
  keepFailedSessionId,
  resumeMismatchError,
  setResolvedModel,
  setUsageOrDelete,
} from "./shared.mjs";

// Claude Code prints exactly this on stderr, exit 1, when `--resume` names a session it does not have.
const missingSession = (id) => `No conversation found with session ID: ${id}`;

export async function runClaude(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const args = ["-p"];
  const execOptions = { cwd, input: prompt, timeout, signal, role };
  const requestedSessionId = state.sessionId;

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

  let stdout;
  try {
    ({ stdout } = await exec("claude", args, execOptions));
  } catch (err) {
    // A non-zero exit can still carry a result event with usage and the session id. Expose
    // both, then rethrow.
    let failed;
    try {
      failed = JSON.parse(err?.stdout ?? "");
    } catch {
      failed = undefined;
    }
    setUsage(state, findResultEvent(failed));
    // The session ran on whatever the failed output names, or on an unknown model, so the record
    // follows it unless the process never started.
    if (childRan(err)) setResolvedModel(state, reportedModels(findResultEvent(failed)));
    keepFailedSessionId(state, findSessionId(failed));
    flagMissingSession(err, requestedSessionId, missingSession);
    throw err;
  }
  let parsed;
  try {
    parsed = parseJson(stdout, "Claude Code");
  } catch (err) {
    setResolvedModel(state, []);
    throw err;
  }
  // Set before the session checks below: a turn that fails them still ran on this model.
  const resultEvent = findResultEvent(parsed);
  setResolvedModel(state, reportedModels(resultEvent));

  const sessionId = findSessionId(parsed);

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  // A resumed id must come back unchanged, as in the Codex, Copilot, and opencode adapters.
  if (requestedSessionId && sessionId !== requestedSessionId) {
    throw resumeMismatchError("Claude Code", "session", requestedSessionId, sessionId);
  }

  state.sessionId = sessionId;
  setUsage(state, resultEvent);

  return String(resultEvent?.result ?? "").trim();
}

function findSessionId(parsed) {
  return Array.isArray(parsed)
    ? asSessionId(parsed.map((event) => event?.session_id).find(Boolean))
    : asSessionId(parsed?.session_id);
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
  setUsageOrDelete(state, Object.keys(usage).length > 0 ? usage : undefined);
}

/**
 * Lists the model ids a result names, the keys of `modelUsage`. More than one key means a subagent
 * or helper model ran too, so the role model is unknown (the gap: such a turn is unresolved). A
 * `modelUsage` that is not an object, or an entry that is not an object, is reported as `null`,
 * which is malformed evidence and is unresolved.
 */
function reportedModels(resultEvent) {
  const usage = resultEvent?.modelUsage;
  if (!isJsonObject(usage)) return [];
  return Object.entries(usage).map(([model, entry]) => (isJsonObject(entry) ? model : null));
}
