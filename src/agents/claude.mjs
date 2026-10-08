import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isJsonObject, parseJson } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";
import {
  asSessionId,
  childRan,
  recordResolvedModel,
  failedWithLine,
  flagMissingSession,
  keepFailedSessionId,
  resumeMismatchError,
  setUsageOrDelete,
} from "./shared.mjs";

// Claude Code prints exactly this on stderr, exit 1, when `--resume` names a session it does not have.
const missingSession = (id) => `No conversation found with session ID: ${id}`;

// Claude Code prints exactly this on stderr, exit 1, when `--session-id` names an existing session.
const sessionInUse = (id) => `Error: Session ID ${id} is already in use.`;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_HEAD_BYTES = 256 * 1024;

/**
 * The line appended to the prompt of a first turn. It names the pre-assigned id, a fresh random
 * value that only this run's state records, and the role, so the first user record of the saved
 * session shows that this adapter started the session for this id and role.
 */
const sessionMarker = (id, role) => `[agent-loop session ${id} role ${role ?? ""}]`;

/**
 * True when Claude Code holds a regular session file for `id` whose first user record names `cwd`
 * as the work tree and `id` as the session, and whose prompt carries the marker for `id` and
 * `role`. An unconfirmed pre-assigned id passes this check before it is resumed, because another
 * session can hold the same UUID, even in this work tree, and `resumeMismatchError` cannot catch
 * it: that session reports the same id. Only the marker match reads session content, from the
 * first 256 KiB, and nothing of it is logged.
 * An id that is not a canonical UUID is refused before any path is built. A symlinked project
 * directory or session file is not followed, and only a regular file counts.
 * known-limit: a session store outside `CLAUDE_CONFIG_DIR` or `~/.claude` reads as not owned, and
 * the turn then starts a fresh session.
 */
async function ownsSession(id, cwd, role) {
  if (!CANONICAL_UUID.test(id)) {
    return false;
  }
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const canonical = async (path) => realpath(path).catch(() => resolve(path));
  const wanted = await canonical(cwd ?? process.cwd());
  const wantedMarker = sessionMarker(id, role);
  let dirs;
  try {
    dirs = await readdir(projects);
  } catch {
    return false;
  }
  for (const dir of dirs) {
    const head = await readSessionHead(join(projects, dir), `${id}.jsonl`);
    for (const line of head?.split("\n") ?? []) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === "user") {
        return (
          record.sessionId === id &&
          typeof record.cwd === "string" &&
          (await canonical(record.cwd)) === wanted &&
          JSON.stringify(record.message?.content ?? "").includes(wantedMarker)
        );
      }
    }
  }
  return false;
}

/** Reads the head of a regular file in a real directory, or returns null for anything else. */
async function readSessionHead(dir, name) {
  const path = join(dir, name);
  try {
    if (!(await lstat(dir)).isDirectory() || !(await lstat(path)).isFile()) {
      return null;
    }
    // O_NOFOLLOW is undefined on Windows, where the lstat checks above are the guard.
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) {
        return null;
      }
      const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/**
 * Runs one Claude turn. A first turn pre-assigns its session id and reports it through
 * `options.onSessionAssigned` before the CLI starts, so a dispatcher can persist the id ahead of a
 * crash. A rejected callback stops the turn before any CLI runs. A later call with `null` withdraws
 * an id that the CLI rejected as in use.
 * `state.sessionUnconfirmed` marks an id that no CLI output has confirmed yet: a pre-assigned id
 * sets it, and a result or a reported id clears it. A resume of an unconfirmed id first checks
 * that the session belongs to `options.cwd` and carries the marker for this id and `options.role`, and an id that fails the check raises a
 * `sessionMissing` error before any CLI starts, so the runtime reruns the turn as a first turn.
 */
export async function runClaude(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role, onSessionAssigned } = options;
  const args = ["-p"];
  const execOptions = { cwd, input: prompt, timeout, signal, role };
  const requestedSessionId = state.sessionId;
  if (
    requestedSessionId &&
    state.sessionUnconfirmed &&
    !(await ownsSession(requestedSessionId, cwd, role))
  ) {
    delete state.sessionUnconfirmed;
    throw Object.assign(
      new Error(
        `Claude Code session ${requestedSessionId} is not verified as owned by this work tree.`,
      ),
      { sessionMissing: true },
    );
  }
  // A first turn pre-assigns its id, so a kill that leaves stdout empty still names the session
  // the CLI saved (issue #395). A resumed turn passes no `--session-id`.
  const preassignedId = requestedSessionId ? null : randomUUID();

  args.push(
    ...(requestedSessionId ? ["--resume", requestedSessionId] : ["--session-id", preassignedId]),
  );

  if (readOnly) {
    args.push("--permission-mode", "plan");
    // Plan mode is a write guard here, not a planning workflow. Without this variable it
    // delegates research to the built-in Explore and Plan subagents, which inherit the role
    // model (Explore capped at Opus on the Claude API). Requires Claude Code v2.1.198+.
    execOptions.env = { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1" };
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--effort", state.effort);
  }

  // `--verbose` makes the `json` output an array of events, so it carries the `init` event that
  // names the main-loop model (issue #566).
  args.push("--output-format", "json", "--verbose");

  if (preassignedId) {
    execOptions.input = `${prompt}\n\n${sessionMarker(preassignedId, role)}`;
    state.sessionUnconfirmed = true;
    try {
      await onSessionAssigned?.(preassignedId);
    } catch (err) {
      delete state.sessionUnconfirmed;
      throw err;
    }
  }

  let stdout;
  try {
    ({ stdout } = await exec("claude", args, execOptions));
  } catch (err) {
    // A non-zero exit can still carry a result event with usage and the session id. Expose
    // both, then rethrow.
    let failed;
    try {
      failed = JSON.parse(err?.stdout ?? "");
    } catch {
      failed = undefined;
    }
    setUsage(state, findResultEvent(failed));
    // The kept session ran on whatever the failed output names for it, or on an unknown model, so
    // the record follows that unless the process never started.
    if (childRan(err)) recordTurnModel(state, failed, requestedSessionId);
    // An id the CLI printed wins. Otherwise the pre-assigned id stays: a kill before the CLI
    // saved a session leaves an id that names none, and the next resume then reaches the
    // missing-session fallback below. An id that the CLI rejects as in use names another
    // session, so it is never kept and the next turn starts with a fresh id.
    if (findSessionId(failed)) {
      delete state.sessionUnconfirmed;
    }
    const collided = preassignedId && failedWithLine(err, sessionInUse(preassignedId));
    keepFailedSessionId(state, findSessionId(failed) ?? (collided ? null : preassignedId));
    if (collided) {
      delete state.sessionUnconfirmed;
      // Drop the id that the dispatcher persisted before the spawn, so a crash after this point
      // leaves no id for `--resume-interrupted` to resume. A failed write leaves the result write
      // to clear it.
      try {
        await onSessionAssigned?.(null);
      } catch (writeError) {
        logWarn(`Claude Code: could not clear the rejected session id: ${writeError?.message}`);
      }
    }
    flagMissingSession(err, requestedSessionId, missingSession);
    throw err;
  }
  let parsed;
  try {
    parsed = parseJson(stdout, "Claude Code");
  } catch (err) {
    recordTurnModel(state, undefined, requestedSessionId);
    throw err;
  }
  const resultEvent = findResultEvent(parsed);
  const sessionId = findSessionId(parsed);
  // Set before the session checks below, so a turn that fails them records unresolved when its
  // output is not the session the role keeps.
  recordTurnModel(state, parsed, requestedSessionId);

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  // A resumed id must come back unchanged, as in the Codex, Copilot, and opencode adapters.
  if (requestedSessionId && sessionId !== requestedSessionId) {
    throw resumeMismatchError("Claude Code", "session", requestedSessionId, sessionId);
  }

  if (preassignedId && sessionId !== preassignedId) {
    logWarn(`Claude Code reported session ${sessionId}, not the pre-assigned ${preassignedId}`);
  }

  state.sessionId = sessionId;
  delete state.sessionUnconfirmed;
  setUsage(state, resultEvent);

  return String(resultEvent?.result ?? "").trim();
}

function findSessionId(parsed) {
  return Array.isArray(parsed)
    ? asSessionId(parsed.map((event) => event?.session_id).find(Boolean))
    : asSessionId(parsed?.session_id);
}

function findResultEvent(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.find((event) => event?.type === "result");
  }
  return parsed && typeof parsed === "object" ? parsed : undefined;
}

/**
 * Sets `state.usage` from a result event, or removes it when the event carries no usage.
 * `usage` covers the top-level loop only; `modelUsage` and `total_cost_usd` include subagents.
 */
function setUsage(state, resultEvent) {
  const usage = {};
  if (resultEvent?.modelUsage) usage.models = resultEvent.modelUsage;
  if (resultEvent?.usage) usage.mainLoop = resultEvent.usage;
  if (typeof resultEvent?.total_cost_usd === "number") {
    usage.totalCostUsd = resultEvent.total_cost_usd;
  }
  setUsageOrDelete(state, Object.keys(usage).length > 0 ? usage : undefined);
}

/**
 * Lists the model ids one result event names, the keys of `modelUsage`. More than one key means a
 * subagent or helper model ran too, so the role model is unknown (the gap: such a turn is
 * unresolved). A `modelUsage` that is missing, empty, or not an object, or an entry that is not an
 * object, is reported as `null`, which is malformed evidence and is unresolved.
 */
function reportedModels(resultEvent) {
  const usage = resultEvent?.modelUsage;
  if (!isJsonObject(usage) || Object.keys(usage).length === 0) return [null];
  return Object.entries(usage).map(([model, entry]) => (isJsonObject(entry) ? model : null));
}

/**
 * True for a `system` `init` event. It names the main-loop model, whatever subagent or helper model
 * ran later, so its model takes the place of `modelUsage`. An `init` event without a model reports
 * `undefined`, which is malformed evidence and is unresolved.
 */
const isInitEvent = (event) =>
  isJsonObject(event) && event.type === "system" && event.subtype === "init";

/**
 * Records the resolved model of a turn that ran, from one consistent source. The model is the one
 * the `init` event names, or the one key of `modelUsage` when the output has no `init` event. The
 * session and the model come from the same events: the output must name exactly one valid session across all its
 * events, and every result event that carries model evidence must name that session itself. An
 * array of events that names more than one session, a malformed session, or a result event with no
 * session cannot tie the model to the session the role keeps, so the turn is unresolved. Every
 * place this adapter reads a session id (`findSessionId`, for the id the role adopts or checks)
 * or a model (`reportedModels`) is covered: `recordResolvedModel` then requires that session to be
 * the one the role keeps.
 * @param {object} state role state; mutated
 * @param {unknown} parsed the parsed output: one result object, an array of events, or nothing
 * @param {string | null} requestedSessionId the session id the turn asked the CLI to resume
 */
function recordTurnModel(state, parsed, requestedSessionId) {
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const named = events.filter((event) => isJsonObject(event) && event.session_id !== undefined);
  const ids = new Set(named.map((event) => asSessionId(event.session_id) ?? null));
  const session = ids.size === 1 ? [...ids][0] : null;
  const results = (
    Array.isArray(parsed) ? events.filter((e) => e?.type === "result") : events
  ).filter(isJsonObject);
  const inits = events.filter(isInitEvent);
  const sourced =
    session &&
    results.length > 0 &&
    results.every((e) => asSessionId(e.session_id) === session) &&
    inits.every((e) => asSessionId(e.session_id) === session);
  recordResolvedModel(
    state,
    sourced ? (inits.length > 0 ? inits.map((e) => e.model) : results.flatMap(reportedModels)) : [],
    requestedSessionId,
    sourced ? session : null,
  );
}
