import { randomUUID } from "node:crypto";
import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import { keepFailedSessionId, resumeMismatchError, setMainLoopUsage } from "./shared.mjs";

export async function runCopilot(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  // A new session id reaches the role state only after Copilot reports it: on success, or in the
  // result event of a failed first turn. A failure with no reported id leaves `state.sessionId`
  // null and the next worker turn keeps its preamble.
  const requestedSessionId = state.sessionId;
  const sessionId = requestedSessionId ?? randomUUID();

  const args = ["--session-id", sessionId, "-s", "--no-ask-user", "--output-format", "json"];

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
    const failedResult = findResultEvent(parseJsonLines(error?.stdout ?? ""));
    setMainLoopUsage(state, objectUsage(failedResult));
    // Keep only an id the CLI reported. A failed turn that reports no id does not show that a
    // session holding the turn's content exists, and keeping the pre-assigned id would skip the
    // role preamble on the next turn. In a Copilot CLI 1.0.90-4 probe, a later call with the
    // pre-assigned id of a failed first turn completed and echoed it. Whether it resumed a prior
    // session or started a new one is not verified.
    keepFailedSessionId(state, failedResult?.sessionId ?? failedResult?.session_id);
    throw error;
  }

  const events = parseJsonLines(stdout);
  const resultEvent = findResultEvent(events);
  setMainLoopUsage(state, objectUsage(resultEvent));

  const returnedId = resultEvent?.sessionId ?? resultEvent?.session_id;
  if (!returnedId) {
    throw new Error("Copilot did not return a session ID.");
  }

  // A resumed id must come back unchanged.
  if (requestedSessionId && returnedId !== requestedSessionId) {
    throw resumeMismatchError("Copilot", "session", requestedSessionId, returnedId);
  }

  const message = events
    .filter((event) => event.type === "assistant.message")
    .map((event) => readAssistantMessage(event))
    .filter(Boolean)
    .at(-1);

  if (!message) {
    throw new Error("Copilot did not return response text.");
  }

  // Every check that can fail the turn has passed, so the id is safe to keep. The repository
  // holds no recorded Copilot output showing that a pre-assigned id is echoed, so a first turn
  // stores the id Copilot reports, which is the session the next turn can resume.
  if (returnedId !== sessionId) {
    logWarn(`Copilot reported session ${returnedId}, not the pre-assigned ${sessionId}`);
  }
  state.sessionId = returnedId;

  return String(message).trim();
}

function findResultEvent(events) {
  return events.filter((event) => event?.type === "result").at(-1);
}

function readAssistantMessage(event) {
  const content = event?.data?.content;
  return typeof content === "string" ? content : "";
}

/** Copilot reports usage as an object; any other shape counts as absent. */
function objectUsage(resultEvent) {
  const usage = resultEvent?.usage;
  return usage && typeof usage === "object" ? usage : undefined;
}
