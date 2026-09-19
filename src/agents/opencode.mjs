import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

export async function runOpenCode(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal } = options;
  const args = ["run", "--format", "json"];

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

  const { stdout } = await exec("opencode", args, { cwd, input: prompt, timeout, signal });
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

  const text = events
    .filter((event) => event.type === "text" && typeof event.part?.text === "string")
    .map((event) => event.part.text)
    .join("");

  if (!text.trim()) {
    throw new Error("opencode did not return response text.");
  }

  return text.trim();
}
