import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isJsonObject, parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import { isUuid } from "../lib/session-record.mjs";
import {
  asSessionId,
  CAPACITY_STATUS,
  assertResumedSession,
  childRan,
  closingText,
  markCapacityFailure,
  recordResolvedModel,
  keepFailedSessionId,
  readSessionHead,
  requireHeldUnconfirmedSession,
  setMainLoopUsage,
  singleSessionId,
  turnExecOptions,
} from "./shared.mjs";

// Text Copilot returns for a tool call that `--no-ask-user` leaves without an approval (issue #713).
const SHELL_DENIAL_TEXT = "Permission denied because no interactive user response was available";

// Copilot CLI 1.0.106-2 writes the provider HTTP status on the terminal `session.error` event of
// a failed turn. A probe against a local 529 server with a BYOK provider captured that event. A
// provider capacity reply is status 529 (issue #1323).
/**
 * Marks a failed turn whose terminal failure is a provider capacity reply. The terminal failure is
 * the last `session.error` event, so an earlier retried failure followed by another cause is never
 * marked. A truncated tail loses only the line it cut, so an earlier event stays decisive.
 * @param {unknown} error the error `exec` threw
 * @param {unknown[]} events the failed turn's parsed output lines, in order
 */
function flagCapacityFailure(error, events) {
  const terminal = events.filter(isJsonObject).findLast((event) => event.type === "session.error");
  if (terminal?.data?.statusCode === CAPACITY_STATUS) {
    markCapacityFailure(error);
  }
}

/**
 * True when Copilot saved a turn under `id`: `events.jsonl` of the session is a regular file whose
 * first 256 KiB holds a `user.message` event. The session directory must be a real directory, and
 * neither it nor the file is followed through a link, as the Claude ownership check does. A first turn that fails before Copilot records the
 * prompt (a bad model, an unsupported effort, a kill at startup) leaves `workspace.yaml` only, and
 * a resume of that id holds nothing (issue #642).
 * A relative `COPILOT_HOME` resolves against `cwd`, the role cwd that the CLI runs in (issue #678).
 * known-limit: a session store outside `COPILOT_HOME` or `~/.copilot` reads as holding no turn, and
 * the next turn then starts a fresh session.
 */
async function holdsTurn(id, cwd) {
  if (!isUuid(String(id))) {
    return false;
  }
  const home = resolve(
    cwd ?? process.cwd(),
    process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  );
  // A stored non-string that reads as a UUID, such as `[uuid]`, is refused by the native `TypeError` of `join`.
  const head = await readSessionHead(join(home, "session-state", id), "events.jsonl");
  return parseJsonLines(head ?? "").some((event) => event?.type === "user.message");
}

/**
 * Keeps the pre-assigned id of a failed first turn that saved a session, marked
 * `sessionUnconfirmed` because no output reported it. Nothing is kept when the process never
 * started, when the turn kept a reported id, or when no turn was saved. The caller must not call
 * it when the output reported an id, valid or not: an invalid reported id stores nothing.
 */
async function keepSavedPreassignedId(state, sessionId, error, cwd) {
  if (!state.sessionId && childRan(error) && (await holdsTurn(sessionId, cwd))) {
    state.sessionId = sessionId;
    state.sessionUnconfirmed = true;
  }
}

/**
 * Runs one Copilot turn, and a first turn pre-assigns the session id.
 * The role state keeps a reported id or one that a failed turn saved, marked
 * `state.sessionUnconfirmed` (issue #642, ADR 0030).
 * A resume of an unconfirmed id checks for a saved turn, and a missing one reruns the turn as a
 * first turn. A result or a reported id clears the mark.
 * A refused tool call in the assistant text sets `state.shellDenied` (issue #713, ADR 0035).
 * A turn that is not read-only passes `--allow-tool write` (issue #1916, ADR 0141).
 */
export async function runCopilot(state, prompt, options = {}) {
  const { cwd, readOnly } = options;
  const requestedSessionId = state.sessionId;
  // A missing saved turn raises `sessionMissing` before any CLI starts, so the turn reruns as a
  // first turn.
  await requireHeldUnconfirmedSession(
    state,
    requestedSessionId,
    (id) => holdsTurn(id, cwd),
    `Copilot session ${requestedSessionId} holds no saved turn.`,
  );
  const sessionId = requestedSessionId ?? randomUUID();

  const args = ["--session-id", sessionId, "-s", "--no-ask-user", "--output-format", "json"];

  if (readOnly) {
    args.push("--deny-tool", "write");
  } else {
    // A non-interactive Copilot turn denies a write request that no allow rule approves, and a
    // worker needs file edits (issue #1916, ADR 0141).
    // A worker created a file with this rule (issue #1916, ADR 0141). A file modification and a
    // shell call under the rule are not verified.
    args.push("--allow-tool", "write");
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--reasoning-effort", state.effort);
  }

  let stdout;
  try {
    ({ stdout } = await exec("copilot", args, turnExecOptions(options, prompt)));
  } catch (error) {
    const failedEvents = parseJsonLines(error?.stdout ?? "");
    const failedResult = findResultEvent(failedEvents);
    // The kept session ran on whatever the failed output names for it, or on an unknown model, so
    // the record follows that unless the process never started.
    if (childRan(error)) {
      recordResolvedModel(
        state,
        reportedModels(failedEvents),
        requestedSessionId,
        streamSession(failedEvents),
      );
    }
    setMainLoopUsage(state, objectUsage(failedResult));
    flagCapacityFailure(error, failedEvents);
    // An id the CLI reported wins. Otherwise the pre-assigned id stays only when Copilot saved a
    // turn under it: a failed first turn that ran a tool leaves such a session (issue #641), and
    // one that fails before the prompt is recorded does not, so keeping its id would skip the role
    // preamble for nothing.
    const rawId = resultSessionId(failedResult);
    const reportedId = asSessionId(rawId);
    keepFailedSessionId(state, reportedId);
    if (rawId == null) {
      // A failure that saved no turn keeps no id, so the next worker turn carries its preamble.
      await keepSavedPreassignedId(state, sessionId, error, cwd);
    } else if (reportedId === state.sessionId) {
      // Only the id that the result confirms loses the mark.
      delete state.sessionUnconfirmed;
    }
    throw error;
  }

  const events = parseJsonLines(stdout).filter(isJsonObject);
  const resultEvent = findResultEvent(events);
  setMainLoopUsage(state, objectUsage(resultEvent));

  const rawReturnedId = resultSessionId(resultEvent);
  const returnedId = asSessionId(rawReturnedId);
  // Set before the checks below, so a turn that fails them records unresolved when its output is
  // not the session the role keeps.
  recordResolvedModel(state, reportedModels(events), requestedSessionId, streamSession(events));
  if (!returnedId) {
    if (rawReturnedId == null) {
      await keepSavedPreassignedId(state, sessionId, null, cwd);
    }
    throw new Error("Copilot did not return a session ID.");
  }

  // A first turn keeps the reported id before any later check can fail the turn, so the next
  // turn resumes that session (issue #360). A resumed turn keeps its id, and the check below
  // refuses a changed one.
  keepFailedSessionId(state, returnedId);
  if (state.sessionId === returnedId) {
    delete state.sessionUnconfirmed;
  }

  assertResumedSession("Copilot", "session", requestedSessionId, returnedId);

  const messages = events
    .filter((event) => event.type === "assistant.message")
    .map((event) => readAssistantMessage(event))
    .filter(Boolean);

  if (messages.length === 0) {
    throw new Error("Copilot did not return response text.");
  }

  if (messages.some((message) => message.includes(SHELL_DENIAL_TEXT))) {
    // The runtime reports this flag on the result. A denial that the text does not repeat is not
    // flagged.
    state.shellDenied = true;
    logWarn("Copilot refused a tool call for lack of an interactive approval");
  }

  if (returnedId !== sessionId) {
    logWarn(`Copilot reported session ${returnedId}, not the pre-assigned ${sessionId}`);
  }

  return closingText(messages);
}

function findResultEvent(events) {
  return events.findLast((event) => event?.type === "result");
}

/** The session id that a Copilot event reports under either spelling. */
function resultSessionId(result) {
  return result?.sessionId ?? result?.session_id;
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

/**
 * Lists the `model` of every assistant message that has the field, malformed values included. Messages
 * that name different models, or a malformed value, are unresolved (the gap: a turn that used a second
 * model).
 */
function reportedModels(events) {
  return events
    .filter((event) => event?.type === "assistant.message" && isJsonObject(event.data))
    .filter((event) => Object.hasOwn(event.data, "model"))
    .map((event) => event.data.model);
}

/**
 * Returns the one session id the whole stream names, or undefined. The assistant messages that carry
 * the model name no session, so their model is tied to a session only through the stream: every
 * event that carries a session id (`sessionId` or `session_id`, at the top level or in `data`) must
 * name the same valid one, and the last `result` event, from which the adapter reads the session it
 * keeps, must name it. A stream that names two sessions, a malformed one, or none cannot tie the
 * model to the session the role keeps.
 */
function streamSession(events) {
  const values = [];
  for (const event of events) {
    if (!isJsonObject(event)) continue;
    const data = isJsonObject(event.data) ? event.data : {};
    for (const value of [event.sessionId, event.session_id, data.sessionId, data.session_id]) {
      if (value !== undefined) values.push(value);
    }
  }
  const session = singleSessionId(values);
  const resultId = asSessionId(resultSessionId(findResultEvent(events)));
  return session && resultId === session ? session : undefined;
}
