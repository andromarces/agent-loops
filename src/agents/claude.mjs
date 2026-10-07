import { randomUUID } from "node:crypto";
import { parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import {
  asSessionId,
  failedWithLine,
  flagMissingSession,
  keepFailedSessionId,
  resumeMismatchError,
  setUsageOrDelete,
} from "./shared.mjs";

// Claude Code prints exactly this on stderr, exit 1, when `--resume` names a session it does not have.
const missingSession = (id) => `No conversation found with session ID: ${id}`;

// Claude Code prints exactly this on stderr, exit 1, when `--session-id` names an existing session.
const sessionInUse = (id) => `Error: Session ID ${id} is already in use.`;

/**
 * Runs one Claude turn. A first turn pre-assigns its session id and reports it through
 * `options.onSessionAssigned` before the CLI starts, so a dispatcher can persist the id ahead of a
 * crash. A rejected callback stops the turn before any CLI runs. A later call with `null` withdraws
 * an id that the CLI rejected as in use.
 */
export async function runClaude(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role, onSessionAssigned } = options;
  const args = ["-p"];
  const execOptions = { cwd, input: prompt, timeout, signal, role };
  const requestedSessionId = state.sessionId;
  // A first turn pre-assigns its id, so a kill that leaves stdout empty still names the session
  // the CLI saved (issue #395). A resumed turn passes no `--session-id`.
  const preassignedId = requestedSessionId ? null : randomUUID();

  args.push(
    ...(requestedSessionId ? ["--resume", requestedSessionId] : ["--session-id", preassignedId]),
  );

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

  if (preassignedId) {
    await onSessionAssigned?.(preassignedId);
  }

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
    // An id the CLI printed wins. Otherwise the pre-assigned id stays: a kill before the CLI
    // saved a session leaves an id that names none, and the next resume then reaches the
    // missing-session fallback below. An id that the CLI rejects as in use names another
    // session, so it is never kept and the next turn starts with a fresh id.
    const collided = preassignedId && failedWithLine(err, sessionInUse(preassignedId));
    keepFailedSessionId(state, findSessionId(failed) ?? (collided ? null : preassignedId));
    if (collided) {
      // Drop the id that the dispatcher persisted before the spawn, so a crash after this point
      // leaves no id for `--resume-interrupted` to resume. A failed write leaves the result write
      // to clear it.
      try {
        await onSessionAssigned?.(null);
      } catch (writeError) {
        logWarn(`Claude Code: could not clear the rejected session id: ${writeError?.message}`);
      }
    }
    flagMissingSession(err, requestedSessionId, missingSession);
    throw err;
  }
  const parsed = parseJson(stdout, "Claude Code");

  const sessionId = findSessionId(parsed);

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  // A resumed id must come back unchanged, as in the Codex, Copilot, and opencode adapters.
  if (requestedSessionId && sessionId !== requestedSessionId) {
    throw resumeMismatchError("Claude Code", "session", requestedSessionId, sessionId);
  }

  if (preassignedId && sessionId !== preassignedId) {
    logWarn(`Claude Code reported session ${sessionId}, not the pre-assigned ${preassignedId}`);
  }

  state.sessionId = sessionId;
  const resultEvent = findResultEvent(parsed);
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
