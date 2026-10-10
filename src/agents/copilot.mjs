import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isJsonObject, parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import {
  asSessionId,
  childRan,
  recordResolvedModel,
  keepFailedSessionId,
  lastClosingMessage,
  resumeMismatchError,
  setMainLoopUsage,
} from "./shared.mjs";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_HEAD_BYTES = 256 * 1024;

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
  if (!CANONICAL_UUID.test(id)) {
    return false;
  }
  const home = resolve(
    cwd ?? process.cwd(),
    process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  );
  const dir = join(home, "session-state", id);
  const path = join(dir, "events.jsonl");
  try {
    if (!(await lstat(dir)).isDirectory() || !(await lstat(path)).isFile()) {
      return false;
    }
    // O_NOFOLLOW is undefined on Windows, where the lstat checks above are the guard.
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) {
        return false;
      }
      const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer
        .toString("utf8", 0, bytesRead)
        .split("\n")
        .some((line) => {
          try {
            return JSON.parse(line)?.type === "user.message";
          } catch {
            return false;
          }
        });
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
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
 * Runs one Copilot turn. A first turn pre-assigns the session id. The role state keeps it when the
 * result event reports it, or when the turn fails after Copilot saved a turn under it, marked
 * `state.sessionUnconfirmed` (issue #642, ADR 0030). A failure that saved no turn keeps no id, so
 * the next worker turn carries its preamble. A resume of an unconfirmed id first checks that the
 * session holds a turn, and a missing one raises a `sessionMissing` error before any CLI starts, so
 * the runtime reruns the turn as a first turn. A result or a reported id clears the mark.
 */
export async function runCopilot(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const requestedSessionId = state.sessionId;
  if (
    requestedSessionId &&
    state.sessionUnconfirmed &&
    !(await holdsTurn(requestedSessionId, cwd))
  ) {
    delete state.sessionUnconfirmed;
    throw Object.assign(new Error(`Copilot session ${requestedSessionId} holds no saved turn.`), {
      sessionMissing: true,
    });
  }
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
    // An id the CLI reported wins. Otherwise the pre-assigned id stays only when Copilot saved a
    // turn under it: a failed first turn that ran a tool leaves such a session (issue #641), and
    // one that fails before the prompt is recorded does not, so keeping its id would skip the role
    // preamble for nothing.
    const rawId = failedResult?.sessionId ?? failedResult?.session_id;
    const reportedId = asSessionId(rawId);
    keepFailedSessionId(state, reportedId);
    if (rawId == null) {
      await keepSavedPreassignedId(state, sessionId, error, cwd);
    } else if (reportedId === state.sessionId) {
      // Only the id that the result confirms loses the mark.
      delete state.sessionUnconfirmed;
    }
    throw error;
  }

  const events = parseJsonLines(stdout);
  const resultEvent = findResultEvent(events);
  setMainLoopUsage(state, objectUsage(resultEvent));

  const rawReturnedId = resultEvent?.sessionId ?? resultEvent?.session_id;
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

  // A resumed id must come back unchanged.
  if (requestedSessionId && returnedId !== requestedSessionId) {
    throw resumeMismatchError("Copilot", "session", requestedSessionId, returnedId);
  }

  const messages = events
    .filter((event) => event.type === "assistant.message")
    .map((event) => readAssistantMessage(event))
    .filter(Boolean);

  if (messages.length === 0) {
    throw new Error("Copilot did not return response text.");
  }

  if (returnedId !== sessionId) {
    logWarn(`Copilot reported session ${returnedId}, not the pre-assigned ${sessionId}`);
  }

  return String(lastClosingMessage(messages)).trim();
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
  const ids = new Set();
  for (const event of events) {
    if (!isJsonObject(event)) continue;
    const data = isJsonObject(event.data) ? event.data : {};
    for (const value of [event.sessionId, event.session_id, data.sessionId, data.session_id]) {
      if (value !== undefined) ids.add(asSessionId(value) ?? null);
    }
  }
  const result = findResultEvent(events);
  const resultId = asSessionId(result?.sessionId ?? result?.session_id);
  return ids.size === 1 && resultId && ids.has(resultId) ? resultId : undefined;
}
