import { isJsonObject, parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import {
  asSessionId,
  childRan,
  recordResolvedModel,
  flagMissingSession,
  keepFailedSessionId,
  resumeMismatchError,
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
    // The kept session ran on whatever the failed output names for it, or on an unknown model, so
    // the record follows that unless the process never started.
    if (childRan(err)) recordTurnModel(state, failed, requestedSessionId);
    keepFailedSessionId(state, findSessionId(failed));
    flagMissingSession(err, requestedSessionId, missingSession);
    throw err;
  }
  let parsed;
  try {
    parsed = parseJson(stdout, "Claude Code");
  } catch (err) {
    recordTurnModel(state, undefined, requestedSessionId);
    throw err;
  }
  const resultEvent = findResultEvent(parsed);
  const sessionId = findSessionId(parsed);
  // Set before the session checks below, so a turn that fails them records unresolved when its
  // output is not the session the role keeps.
  recordTurnModel(state, parsed, requestedSessionId);

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
 * Lists the model ids one result event names, the keys of `modelUsage`. More than one key means a
 * subagent or helper model ran too, so the role model is unknown (the gap: such a turn is
 * unresolved). A `modelUsage` that is missing, empty, or not an object, or an entry that is not an
 * object, is reported as `null`, which is malformed evidence and is unresolved.
 */
function reportedModels(resultEvent) {
  const usage = resultEvent?.modelUsage;
  if (!isJsonObject(usage) || Object.keys(usage).length === 0) return [null];
  return Object.entries(usage).map(([model, entry]) => (isJsonObject(entry) ? model : null));
}

/**
 * Records the resolved model of a turn that ran, from one consistent source. The session and the
 * model come from the same events: the output must name exactly one valid session across all its
 * events, and every result event that carries model evidence must name that session itself. An
 * array of events that names more than one session, a malformed session, or a result event with no
 * session cannot tie the model to the session the role keeps, so the turn is unresolved. Every
 * place this adapter reads a session id (`findSessionId`, for the id the role adopts or checks)
 * or a model (`reportedModels`) is covered: `recordResolvedModel` then requires that session to be
 * the one the role keeps.
 * @param {object} state role state; mutated
 * @param {unknown} parsed the parsed output: one result object, an array of events, or nothing
 * @param {string | null} requestedSessionId the session id the turn asked the CLI to resume
 */
function recordTurnModel(state, parsed, requestedSessionId) {
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const named = events.filter((event) => isJsonObject(event) && event.session_id !== undefined);
  const ids = new Set(named.map((event) => asSessionId(event.session_id) ?? null));
  const session = ids.size === 1 ? [...ids][0] : null;
  const results = (
    Array.isArray(parsed) ? events.filter((e) => e?.type === "result") : events
  ).filter(isJsonObject);
  const sourced =
    session && results.length > 0 && results.every((e) => asSessionId(e.session_id) === session);
  recordResolvedModel(
    state,
    sourced ? results.flatMap(reportedModels) : [],
    requestedSessionId,
    sourced ? session : null,
  );
}
