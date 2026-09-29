import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import {
  flagMissingSession,
  keepFailedSessionId,
  resumeMismatchError,
  setMainLoopUsage,
} from "./shared.mjs";

// Codex prints this on stderr, exit 1, when `exec resume` names a thread it has no rollout for.
const MISSING_SESSION = /no rollout found for thread id/i;

export async function runCodex(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const configArgs = [];

  if (readOnly) {
    configArgs.push("-c", 'sandbox_mode="read-only"');
  }

  const modelArgs = [];
  if (state.model) {
    modelArgs.push("-m", state.model);
  }

  if (state.effort) {
    modelArgs.push("-c", `model_reasoning_effort=${state.effort}`);
  }

  let args;
  if (state.sessionId) {
    args = ["exec", "resume", state.sessionId, ...configArgs, "--json", ...modelArgs, "-"];
  } else {
    args = ["exec", ...configArgs, "--json", ...modelArgs];
  }

  const requestedSessionId = state.sessionId;
  let stdout;
  try {
    ({ stdout } = await exec("codex", args, { cwd, input: prompt, timeout, signal, role }));
  } catch (err) {
    // A failed first turn still emits `thread.started` before the failure. Keep that id, then rethrow.
    const started = parseJsonLines(err?.stdout ?? "").find(
      (event) => event?.type === "thread.started",
    );
    keepFailedSessionId(state, started?.thread_id);
    flagMissingSession(err, requestedSessionId, MISSING_SESSION);
    throw err;
  }
  const events = parseJsonLines(stdout);

  const started = events.find((event) => event.type === "thread.started");
  const returnedId = started?.thread_id;

  if (!returnedId) {
    throw new Error("Codex did not return a thread ID.");
  }

  if (state.sessionId && returnedId !== state.sessionId) {
    throw resumeMismatchError("Codex", "thread", state.sessionId, returnedId);
  }

  state.sessionId = returnedId;
  setMainLoopUsage(state, events.find((event) => event.type === "turn.completed")?.usage);

  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text)
    .filter(Boolean);

  if (messages.length === 0) {
    throw new Error("Codex did not return an agent message.");
  }

  return String(messages.at(-1)).trim();
}
