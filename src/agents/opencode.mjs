import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logInfo } from "../lib/log.mjs";
import { resumeMismatchError } from "./shared.mjs";

// The built-in plan agent can launch explore and general subagents through the `subagent`
// action. They inherit the session model, so a read-only turn spends the role model budget
// invisibly. Deny the action for the read-only turn only; see the README.
// A global permissions allow can resolve after the plan agent's `edit` deny and cancel it, so
// deny `edit` here too. Shell stays available for read-only commands such as `git diff`.
const READONLY_CONFIG =
  '{"permissions":[{"action":"subagent","resource":"*","effect":"deny"},{"action":"edit","resource":"*","effect":"deny"}]}';

export async function runOpenCode(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const args = ["run", "--standalone", "--format", "json"];
  const execOptions = { cwd, input: prompt, timeout, signal, role };

  if (state.sessionId) {
    args.push("--session", state.sessionId);
  }

  if (readOnly) {
    args.push("--agent", "plan");
    execOptions.env = { OPENCODE_CONFIG_CONTENT: READONLY_CONFIG };
  }

  // Argument validation rejects an effort without a model; this guards a direct adapter call.
  if (state.effort && !state.model) {
    throw new Error(`opencode effort requires ${role ? `--${role}-model` : "an explicit model"}.`);
  }

  // state holds the requested model and effort, so null means the caller named nothing.
  if (state.model) {
    const resolved = state.effort ? `${state.model}#${state.effort}` : state.model;
    logInfo(`opencode effective model: ${resolved}`);
    args.push("--model", resolved);
  } else {
    // No --model: OpenCode selects its own default, which the JSON stream does not name.
    logInfo(
      "opencode model: OpenCode selects its CLI default; the OpenCode session metadata records the model that ran.",
    );
  }

  let stdout;
  try {
    ({ stdout } = await exec("opencode", args, execOptions));
  } catch (err) {
    // A non-zero exit can still carry completed-step usage. Expose it, then rethrow.
    setUsage(state, parseJsonLines(err?.stdout ?? ""));
    throw err;
  }

  const events = parseJsonLines(stdout);

  const sessionId = events.map((event) => event.sessionID).find(Boolean);

  if (!sessionId) {
    throw new Error("opencode did not return a session ID.");
  }

  if (state.sessionId && state.sessionId !== sessionId) {
    throw resumeMismatchError("opencode", "session", state.sessionId, sessionId);
  }

  state.sessionId = sessionId;

  // Record usage before the error check so a turn that failed after completing steps still reports
  // what it spent, matching the Claude adapter and the runtime's error invocation event.
  setUsage(state, events);

  // Defense-in-depth: if the CLI ever exits 0 with an error event, surface its detail instead of
  // falling through to the missing-text error. The session is recorded first, as it is on any turn.
  const errorEvent = events.find((event) => event.type === "error");

  if (errorEvent) {
    throw new Error(`opencode returned an error event: ${describeError(errorEvent.error)}`);
  }

  const text = events
    .filter((event) => event.type === "text" && typeof event.part?.text === "string")
    .map((event) => event.part.text)
    .join("");

  if (!text.trim()) {
    throw new Error("opencode did not return response text.");
  }

  return text.trim();
}

/**
 * Sets `state.usage` from the `step_finish` parts of the stream, or removes it when the stream
 * carries none. Each completed step emits one `step_finish` part with `tokens` and `cost`, so
 * both fields sum across steps. No event names the model, so `models` is omitted.
 */
function setUsage(state, events) {
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let cost = 0;
  let hasTokens = false;
  let hasCost = false;

  for (const event of events) {
    if (event.type !== "step_finish") {
      continue;
    }

    const part = event.part ?? {};

    if (part.tokens && typeof part.tokens === "object") {
      hasTokens = true;
      tokens.input += part.tokens.input ?? 0;
      tokens.output += part.tokens.output ?? 0;
      tokens.reasoning += part.tokens.reasoning ?? 0;
      tokens.cache.read += part.tokens.cache?.read ?? 0;
      tokens.cache.write += part.tokens.cache?.write ?? 0;
    }

    if (typeof part.cost === "number") {
      hasCost = true;
      cost += part.cost;
    }
  }

  const usage = {};
  if (hasTokens) usage.mainLoop = tokens;
  if (hasCost) usage.totalCostUsd = cost;

  if (Object.keys(usage).length > 0) {
    state.usage = usage;
  } else {
    delete state.usage;
  }
}

/**
 * Formats an OpenCode error event payload for the thrown message.
 * The payload carries `{ type, message, status }`; any field can be absent.
 */
function describeError(error) {
  if (!error || typeof error !== "object") {
    return "unknown error";
  }

  const detail = [error.type, error.message].filter(Boolean).join(": ") || "unknown error";
  return error.status == null ? detail : `${detail} (status ${error.status})`;
}
