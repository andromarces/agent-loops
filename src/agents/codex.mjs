import { isJsonObject, parseJsonLines } from "../lib/json.mjs";
import { exec, execFailureCause } from "../lib/exec.mjs";
import { withTurnTmpdir } from "../lib/turn-tmpdir.mjs";
import {
  asSessionId,
  assertResumedSession,
  closingText,
  flagMissingSession,
  keepFailedSessionId,
  markCapacityFailure,
  setMainLoopUsage,
  turnExecOptions,
} from "./shared.mjs";

// Codex prints exactly this on stderr, exit 1, when `exec resume` names a thread it has no rollout for.
const missingSession = (id) =>
  `Error: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)`;

// Codex reports this model capacity reply in an `error` event and a `turn.failed` event (issue #1012).
const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

// A failed Codex turn reports the exit cause and the last failure message only. It never reports
// the stream, so command output cannot reach the envelope or the state file (issue #1353). The
// detail is bounded to 500 characters including the ellipsis, and the whole message stays under 700.
const DETAIL_LIMIT = 500;
const NO_DETAIL = "no Codex error event in the output";

/**
 * Returns the message of the last `error` or `turn.failed` event, or an empty string. That event
 * decides the capacity mark and the reported detail, so both read it here.
 */
function terminalFailureMessage(events) {
  const terminal = events.findLast(
    (event) => event?.type === "error" || event?.type === "turn.failed",
  );
  const message = terminal?.type === "error" ? terminal.message : terminal?.error?.message;
  return typeof message === "string" ? message : "";
}

/**
 * Marks a failed turn whose terminal failure is the model capacity reply, so a parent can tell the
 * transient failure from a reviewer fault without reading the error text. The terminal failure is
 * the last `error` or `turn.failed` event of the stream, so an earlier capacity event followed by
 * another cause is never marked. A timeout, cancel, or signal ends the turn for another reason, so
 * it is never marked either.
 */
function flagCapacityFailure(err, events) {
  if (terminalFailureMessage(events) === CAPACITY_MESSAGE) {
    markCapacityFailure(err);
  }
}

/**
 * Builds the message for a failed turn. A killed, timed-out, or cut turn reports the cause alone,
 * because a stream it left behind names a failure that is not why it died. An ordinary non-zero
 * exit reports the last failure message and the stream byte counts, both bounded.
 */
function failureMessage(err, events, timeout) {
  const cause = execFailureCause("codex", err, timeout);
  if (cause) {
    return cause;
  }

  const detail = boundedDetail(terminalFailureMessage(events));
  const stdoutBytes = Buffer.byteLength(err?.stdout ?? "");
  const stderrBytes = Buffer.byteLength(err?.stderr ?? "");
  return `codex exited with code ${err?.exitCode}: ${detail || NO_DETAIL} (${stdoutBytes} stdout bytes, ${stderrBytes} stderr bytes)`;
}

/** Flattens `text` to one line and keeps at most `DETAIL_LIMIT` characters, including the ellipsis. */
function boundedDetail(text) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT - 3)}...` : flat;
}

/**
 * Runs one Codex turn in a private temporary directory when creation succeeds. A failed creation
 * warns and the turn uses the inherited temporary directory. The runtime removes the private
 * directory after the turn. A failed, refused, or timed-out removal only warns.
 * A failed `ExecError` gets a bounded `message`: the exit cause, or the exit code and last
 * failure event. Any other error reaches the caller unchanged.
 */
export async function runCodex(state, prompt, options = {}) {
  const { readOnly, sandbox, onTurnTmpdir } = options;
  const configArgs = [];

  // `sandbox` is the reviewer-only mode input (ADR 0038): `none`, `read-only`, or `workspace-write`.
  // `exec` and `exec resume` both accept the `-c sandbox_mode` form, so one form serves every turn.
  // Network access is set off explicitly for `workspace-write`, because the user config can turn it on.
  // With no sandbox, a GitHub app connector write runs without approval, so the app connectors are
  // turned off (issue #496). The sandboxed modes refuse that write already.
  if (sandbox === "none") {
    configArgs.push("-c", 'sandbox_mode="danger-full-access"', "-c", "features.apps=false");
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
    ({ stdout } = await withTurnTmpdir(
      // A command of the turn can leave the group of the child. A parent signal walks the child's
      // descendants by pid (ADR 0071).
      (env) =>
        exec("codex", args, {
          ...turnExecOptions({ ...options, env }, prompt),
          treeEnd: true,
        }),
      { onCreated: onTurnTmpdir },
    ));
  } catch (err) {
    // A failed first turn still emits `thread.started` before the failure. Keep that id, then rethrow.
    const failedEvents = parseJsonLines(err?.stdout ?? "");
    const started = failedEvents.find((event) => event?.type === "thread.started");
    keepFailedSessionId(state, started?.thread_id);
    if (!(err instanceof Error)) {
      throw err;
    }
    flagCapacityFailure(err, failedEvents);
    flagMissingSession(err, requestedSessionId, missingSession);
    // Only an `exec` failure carries the message that this adapter bounds. Any other error, such
    // as a failed turn-directory callback, reaches the caller unchanged (issue #1353).
    if (err.name === "ExecError") {
      err.message = failureMessage(err, failedEvents, options.timeout);
    }
    throw err;
  }
  const events = parseJsonLines(stdout).filter(isJsonObject);

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
