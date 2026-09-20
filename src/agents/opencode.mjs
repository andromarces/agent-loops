import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

export async function runOpenCode(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const args = ["run", "--standalone", "--format", "json"];

  if (state.sessionId) {
    args.push("--session", state.sessionId);
  }

  if (readOnly) {
    args.push("--agent", "plan");
  }

  const model =
    state.model && state.effort ? `${state.model}#${state.effort}` : (state.model ?? null);

  if (model) {
    args.push("--model", model);
  }

  const { stdout } = await exec("opencode", args, { cwd, input: prompt, timeout, signal, role });
  const events = parseJsonLines(stdout);

  // A failed turn can still exit 0 and carry a session id. Surface the error event before
  // any other check so the failure names its cause instead of a missing-text or session error.
  const errorEvent = events.find((event) => event.type === "error");

  if (errorEvent) {
    throw new Error(`opencode returned an error event: ${describeError(errorEvent.error)}`);
  }

  const sessionId = events.map((event) => event.sessionID).find(Boolean);

  if (!sessionId) {
    throw new Error("opencode did not return a session ID.");
  }

  if (state.sessionId && state.sessionId !== sessionId) {
    throw new Error(
      [
        `opencode did not resume the expected session.`,
        `Expected: ${state.sessionId}`,
        `Received: ${sessionId}`,
      ].join("\n"),
    );
  }

  state.sessionId = sessionId;

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
