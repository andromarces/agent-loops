import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logInfo } from "../lib/log.mjs";

// Pinned default for a turn that names neither a model nor an effort. The model lives on the
// OpenCode Go provider, so it needs an OpenCode Go subscription; see the README.
const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";
const DEFAULT_EFFORT = "high";

export async function runOpenCode(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const args = ["run", "--standalone", "--format", "json"];

  if (state.sessionId) {
    args.push("--session", state.sessionId);
  }

  if (readOnly) {
    args.push("--agent", "plan");
  }

  // state holds the requested model and effort, so null means the caller named nothing.
  const defaulted = !state.model;
  const model = state.model ?? DEFAULT_MODEL;
  const effort = state.effort ?? (state.model ? null : DEFAULT_EFFORT);
  const resolved = effort ? `${model}#${effort}` : model;

  logInfo(`opencode effective model: ${resolved}`);
  args.push("--model", resolved);

  let stdout;
  try {
    ({ stdout } = await exec("opencode", args, { cwd, input: prompt, timeout, signal, role }));
  } catch (err) {
    // Only a defaulted turn points at the default; an explicit model failure stays as recorded.
    if (defaulted && err instanceof Error) {
      const roleFlag = role ? `--${role}-model` : "--<role>-model";
      err.message = [
        err.message,
        `The opencode default model ${DEFAULT_MODEL} needs an OpenCode Go subscription. Override it with ${roleFlag}.`,
      ].join("\n\n");
    }
    throw err;
  }

  const events = parseJsonLines(stdout);

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
