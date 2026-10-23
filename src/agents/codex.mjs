import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { withTurnTmpdir } from "../lib/turn-tmpdir.mjs";
import {
  asSessionId,
  assertResumedSession,
  closingText,
  flagMissingSession,
  keepFailedSessionId,
  setMainLoopUsage,
} from "./shared.mjs";

// Codex prints exactly this on stderr, exit 1, when `exec resume` names a thread it has no rollout for.
const missingSession = (id) =>
  `Error: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)`;

// Codex reports this model capacity reply in an `error` event and a `turn.failed` event (issue #1012).
const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

/**
 * Marks a failed turn that ended on the model capacity reply, so a parent can tell the transient
 * failure from a reviewer fault without reading the error text. A timeout, cancel, or signal ends
 * the turn for another reason, so it is never marked.
 */
function flagCapacityFailure(err, events) {
  if (!err || typeof err !== "object" || err.timedOut || err.isCanceled || err.isTerminated) {
    return;
  }
  const capacity = events.some(
    (event) =>
      (event?.type === "error" && event.message === CAPACITY_MESSAGE) ||
      (event?.type === "turn.failed" && event.error?.message === CAPACITY_MESSAGE),
  );
  if (capacity) {
    err.transient = "capacity";
  }
}

export async function runCodex(state, prompt, options = {}) {
  const { cwd, readOnly, sandbox, timeout, signal, role } = options;
  const configArgs = [];

  // `sandbox` is the reviewer-only mode input (ADR 0038): `none`, `read-only`, or `workspace-write`.
  // `exec` and `exec resume` both accept the `-c sandbox_mode` form, so one form serves every turn.
  // Network access is set off explicitly for `workspace-write`, because the user config can turn it on.
  if (sandbox === "none") {
    configArgs.push("-c", 'sandbox_mode="danger-full-access"');
  } else if (sandbox === "workspace-write") {
    configArgs.push(
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.network_access=false",
    );
  } else if (readOnly) {
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
    // The CLI creates two empty `.tmp*` directories in its temporary directory on every turn, so it
    // gets a private one that the runtime removes (issue #955).
    ({ stdout } = await withTurnTmpdir((env) =>
      exec("codex", args, { cwd, input: prompt, timeout, signal, role, ...(env && { env }) }),
    ));
  } catch (err) {
    // A failed first turn still emits `thread.started` before the failure. Keep that id, then rethrow.
    const failedEvents = parseJsonLines(err?.stdout ?? "");
    const started = failedEvents.find((event) => event?.type === "thread.started");
    keepFailedSessionId(state, started?.thread_id);
    flagCapacityFailure(err, failedEvents);
    flagMissingSession(err, requestedSessionId, missingSession);
    throw err;
  }
  const events = parseJsonLines(stdout);

  const started = events.find((event) => event.type === "thread.started");
  const returnedId = asSessionId(started?.thread_id);

  if (!returnedId) {
    throw new Error("Codex did not return a thread ID.");
  }

  assertResumedSession("Codex", "thread", state.sessionId, returnedId);

  state.sessionId = returnedId;
  setMainLoopUsage(state, events.find((event) => event.type === "turn.completed")?.usage);

  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text)
    .filter(Boolean);

  if (messages.length === 0) {
    throw new Error("Codex did not return an agent message.");
  }

  return closingText(messages);
}
