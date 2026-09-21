import { randomUUID } from "node:crypto";
import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";

export async function runCopilot(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const requestedSessionId = state.sessionId;

  if (!state.sessionId) {
    state.sessionId = randomUUID();
  }

  const args = ["--session-id", state.sessionId, "-s", "--no-ask-user", "--output-format", "json"];

  if (readOnly) {
    args.push("--deny-tool", "write");
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--reasoning-effort", state.effort);
  }

  let stdout;
  try {
    ({ stdout } = await exec("copilot", args, { cwd, input: prompt, timeout, signal, role }));
  } catch (error) {
    const failed = parseJsonLines(error?.stdout ?? "");
    setUsage(state, findResultEvent(failed));
    throw error;
  }

  const events = parseJsonLines(stdout);
  const resultEvent = findResultEvent(events);
  setUsage(state, resultEvent);

  const returnedId = resultEvent?.sessionId ?? resultEvent?.session_id;
  if (!returnedId) {
    throw new Error("Copilot did not return a session ID.");
  }

  if (requestedSessionId && requestedSessionId !== returnedId) {
    throw new Error(
      [
        "Copilot did not resume the expected session.",
        `Expected: ${requestedSessionId}`,
        `Received: ${returnedId}`,
      ].join("\n"),
    );
  }

  state.sessionId = returnedId;

  const message = events
    .filter((event) => event.type === "assistant.message")
    .map((event) => readAssistantMessage(event))
    .filter(Boolean)
    .at(-1);

  if (!message) {
    throw new Error("Copilot did not return response text.");
  }

  return String(message).trim();
}

function findResultEvent(events) {
  return events.filter((event) => event?.type === "result").at(-1);
}

function readAssistantMessage(event) {
  const content = event?.data?.content;
  return typeof content === "string" ? content : "";
}

function setUsage(state, resultEvent) {
  if (resultEvent && resultEvent.usage && typeof resultEvent.usage === "object") {
    state.usage = { mainLoop: resultEvent.usage };
    return;
  }

  delete state.usage;
}
