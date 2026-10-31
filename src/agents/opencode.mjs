import { isJsonObject, parseJsonLines } from "../lib/json.mjs";
import { redactEnvSecrets } from "../lib/redact.mjs";
import { exec, execFailureCause } from "../lib/exec.mjs";
import { logDebug, logInfo } from "../lib/log.mjs";
import {
  asSessionId,
  assertResumedSession,
  childRan,
  keepFailedSessionId,
  recordResolvedModel,
  setResolvedModel,
  setUsageOrDelete,
  throwIfCanceled,
  turnExecOptions,
} from "./shared.mjs";
import { isNonEmptyString, joinTextParts } from "./opencode-text.mjs";

// Bounds for a failure message, so a long provider message cannot reach the dispatch envelope or
// the state file (issue #326). No part of stdout or stderr is allowed into the message: a stream
// carries model output, and stderr can carry a secret.
const DETAIL_LIMIT = 500;
const NO_DETAIL = "no provider error event in the output";
const UNKNOWN_ERROR = "unknown error";

// The built-in plan agent can launch explore and general subagents through the `subagent`
// action. They inherit the session model, so a read-only turn spends the role model budget
// invisibly. Deny the action for the read-only turn only; see docs/reference/reviewer-safety.md.
// A global permissions allow can resolve after the plan agent's `edit` deny and cancel it, so
// deny `edit` here too. Shell stays available for read-only commands such as `git diff`.
const READONLY_CONFIG =
  '{"permissions":[{"action":"subagent","resource":"*","effect":"deny"},{"action":"edit","resource":"*","effect":"deny"}]}';

/**
 * Runs one opencode turn and returns the response text. Logs the effective model, or a line that
 * OpenCode selects its default when `state.model` is unset. A successful turn whose stream names
 * one session, the requested one on a resume, starts a second process, `opencode session export <id>`,
 * to read the model that ran (`exportedModels`). Throws for a missing session id, an error event,
 * or no response text, and with the cancel error when `options.signal` aborts.
 */
export async function runOpenCode(state, prompt, options = {}) {
  const { readOnly, timeout, signal, role, env } = options;
  const args = ["run", "--standalone", "--format", "json"];
  const execOptions = turnExecOptions(options, prompt);

  if (state.sessionId) {
    args.push("--session", state.sessionId);
  }

  if (readOnly) {
    args.push("--agent", "plan");
    execOptions.env = { ...env, OPENCODE_CONFIG_CONTENT: READONLY_CONFIG };
  }

  // Argument validation rejects an effort without a model; this guards a direct adapter call.
  if (state.effort && !state.model) {
    throw new Error(`opencode effort requires ${role ? `--${role}-model` : "an explicit model"}.`);
  }

  // state holds the requested model and effort, so null means the caller named nothing.
  if (state.model) {
    const resolved = state.effort ? `${state.model}#${state.effort}` : state.model;
    logInfo(`opencode effective model: ${resolved}`);
    args.push("--model", resolved);
  } else {
    // No --model: OpenCode selects its own default, which the JSON stream does not name.
    logInfo(
      "opencode model: OpenCode selects its CLI default; the session export records the model that ran.",
    );
  }

  const requestedSessionId = state.sessionId;
  const startedAt = Date.now();
  let stdout;
  try {
    ({ stdout } = await exec("opencode", args, execOptions));
  } catch (err) {
    const events = parseJsonLines(err?.stdout ?? "");
    // The failed stream names no model and the export is not read after a failure, so a turn that
    // ran is unresolved (ADR 0026).
    if (childRan(err)) setResolvedModel(state, []);
    // A non-zero exit, a timeout, or a cancel can still carry completed-step usage and the session
    // id. Expose both, then rethrow.
    setUsage(state, events);
    keepFailedSessionId(state, firstSessionId(events));
    // The stream carries model output and stderr can carry a secret, and `logDebug` writes to
    // stdout in the loop CLI, where a caller can persist it. The debug line therefore carries the
    // exit code and the byte counts only, and the full text stays on the error for a caller that
    // asks for it (issue #326).
    logDebug(
      `opencode exited with code ${err?.exitCode ?? "none"}: ${byteLength(err?.stdout)} stdout bytes, ${byteLength(err?.stderr)} stderr bytes`,
    );

    const failure = err instanceof Error ? err : new Error(String(err));
    failure.message = failureMessage(err, events, timeout);
    throw failure;
  }

  // Every read below names a field of the event, so a line that parsed to another JSON value, such
  // as the `null` of a diagnostic line, is dropped first: reading it would throw a TypeError that
  // replaces the adapter error (issue #335).
  const events = parseJsonLines(stdout).filter(isJsonObject);

  // Once the child has exited, an aborted signal at any point before this function returns ends the
  // turn as a cancel that landed while the child ran: the same fixed cancel error, the session id and
  // usage kept, and the model unresolved. One check covers every return path below, the early and the
  // validation throws and the export, and the error of a failed path never replaces the cancel.
  try {
    const text = await settleTurn(state, events, { requestedSessionId, execOptions, startedAt });
    if (!signal?.aborted) return text;
  } catch (err) {
    if (!signal?.aborted) throw err;
  }
  setResolvedModel(state, []);
  setUsage(state, events);
  keepFailedSessionId(state, firstSessionId(events));
  throwIfCanceled(signal, "opencode");
}

/** Returns the first truthy `sessionID` of the events, which may hold non-object entries. */
function firstSessionId(events) {
  return events.map((event) => event?.sessionID).find(Boolean);
}

/** Validates the stream of a turn whose child exited 0, records its session, usage, and model, and returns its text. */
async function settleTurn(state, events, { requestedSessionId, execOptions, startedAt }) {
  // Select the first truthy id, so an empty id is skipped, then require it to be a non-empty
  // string: a later valid id never rescues a truthy invalid or mismatched first one.
  const sessionId = asSessionId(firstSessionId(events));

  // Unresolved until the turn has passed every check below, so a turn that fails one records `null`
  // and never reads the export.
  setResolvedModel(state, []);

  if (!sessionId) {
    throw new Error("opencode did not return a session ID.");
  }

  assertResumedSession("opencode", "session", requestedSessionId, sessionId);

  state.sessionId = sessionId;

  // Record usage before the error check so a turn that failed after completing steps still reports
  // what it spent, matching the Claude adapter and the runtime's error invocation event.
  setUsage(state, events);

  // Defense-in-depth: if the CLI ever exits 0 with an error event, surface its detail instead of
  // falling through to the missing-text error. The session is recorded first, as it is on any turn.
  // The detail is the last well-formed one, described and capped as on the non-zero path, so a long
  // provider message cannot reach the envelope here either (issue #335).
  const errorDetail = lastErrorDetail(events);

  if (errorDetail || events.some((event) => event.type === "error")) {
    throw new Error(`opencode returned an error event: ${errorDetail || UNKNOWN_ERROR}`);
  }

  const text = joinTextParts(
    events.filter((event) => event.type === "text" && typeof event.part?.text === "string"),
  );

  if (!text.trim()) {
    throw new Error("opencode did not return response text.");
  }

  // The export reads only the session that every stream event confirms and the role keeps.
  const confirmedId = streamSession(events);
  const kept = confirmedId && (!requestedSessionId || confirmedId === requestedSessionId);
  const models = kept ? await exportedModels(confirmedId, events, execOptions, startedAt) : [];
  recordResolvedModel(state, models, requestedSessionId, confirmedId);

  return text.trim();
}

/**
 * Returns the one session id that every stream event names, or undefined. Each event must carry a
 * valid `sessionID`, and a part that carries one must name the same id, so a partial or mixed
 * stream never ties the export to a guessed session.
 */
function streamSession(events) {
  const ids = new Set();
  for (const event of events) {
    ids.add(asSessionId(event.sessionID) ?? null);
    const part = event.part?.sessionID;
    if (part !== undefined) ids.add(asSessionId(part) ?? null);
  }
  const [id] = ids;
  return ids.size === 1 ? id || undefined : undefined;
}

/**
 * Lists the `provider/model` of each assistant message that the turn streamed, read from
 * `opencode session export <id>`, because no stream event names the model. The export holds the
 * whole session, so only the messages whose id the stream names count. A streamed message that the
 * export lacks, or whose model is malformed or holds a secret environment value (ADR 0017),
 * contributes `undefined`, which makes the turn unresolved. An empty list, a failed or timed-out
 * export, a spent timeout, or output that is not JSON also makes it unresolved. So does a stream
 * part with no valid message id, and an export with a message that has no valid id or a repeated
 * id, because neither side then proves which assistant message belongs to the turn.
 * The export runs under the cancel signal and the time that the invocation has left. No failure of
 * it reaches the caller, because the text of the failed call can hold session content, and only the
 * model field leaves this function. `runOpenCode` ends the turn as canceled when the signal is
 * aborted, whatever this function returned.
 * known-limit: the export prints the whole session, so a long session enlarges the buffered output.
 * @param {number} startedAt `Date.now()` at the start of the invocation
 */
async function exportedModels(sessionId, events, { cwd, timeout, signal, role }, startedAt) {
  const ids = new Set();
  for (const { part } of events) {
    if (part === undefined) continue;
    if (!isJsonObject(part) || !isNonEmptyString(part.messageID)) return [];
    ids.add(part.messageID);
  }
  if (ids.size === 0) return [];
  if (signal?.aborted) return [];
  const bounded = typeof timeout === "number" && timeout > 0;
  const remaining = bounded ? timeout - (Date.now() - startedAt) / 1000 : undefined;
  if (bounded && remaining <= 0) return [];
  let messages;
  try {
    const { stdout } = await exec("opencode", ["session", "export", sessionId], {
      cwd,
      timeout: remaining,
      signal,
      role,
    });
    messages = JSON.parse(stdout)?.messages;
  } catch {
    return [];
  }
  if (!Array.isArray(messages)) return [];
  const byId = new Map();
  for (const message of messages) {
    if (!isJsonObject(message) || !isNonEmptyString(message.id) || byId.has(message.id)) return [];
    byId.set(message.id, message);
  }
  return [...ids].map((id) => {
    const message = byId.get(id);
    const model = message?.type === "assistant" ? message.model : undefined;
    if (
      !isJsonObject(model) ||
      !isNonEmptyString(model.providerID) ||
      !isNonEmptyString(model.id)
    ) {
      return undefined;
    }
    const value = `${model.providerID}/${model.id}`;
    return redactEnvSecrets(value) === value ? value : undefined;
  });
}

/**
 * Sets `state.usage` from the `step_finish` parts of the stream, or removes it when the stream
 * carries none. Each completed step emits one `step_finish` part with `tokens` and `cost`, so
 * both fields sum across steps. No stream event names the model, so `models` is omitted. The read runs
 * before the failure message on the non-zero path, so it drops any value that is not a count
 * rather than letting a malformed one throw and cost the caller its exit code (issue #326).
 */
function setUsage(state, events) {
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let cost = 0;
  let hasTokens = false;
  let hasCost = false;

  for (const event of events) {
    // A line can parse to a non-event value, such as the `null` of a diagnostic line, so the type
    // read must survive it (issue #326).
    if (event?.type !== "step_finish") {
      continue;
    }

    const part = event.part ?? {};

    if (part.tokens && typeof part.tokens === "object") {
      hasTokens = true;
      tokens.input += usageNumber(part.tokens.input);
      tokens.output += usageNumber(part.tokens.output);
      tokens.reasoning += usageNumber(part.tokens.reasoning);
      tokens.cache.read += usageNumber(part.tokens.cache?.read);
      tokens.cache.write += usageNumber(part.tokens.cache?.write);
    }

    if (isUsageNumber(part.cost)) {
      hasCost = true;
      cost += part.cost;
    }
  }

  // Two large finite values can sum to Infinity, which is not a count, so each total is dropped the
  // same way a malformed input value is (issue #326).
  if (hasTokens) {
    tokens.input = usageNumber(tokens.input);
    tokens.output = usageNumber(tokens.output);
    tokens.reasoning = usageNumber(tokens.reasoning);
    tokens.cache.read = usageNumber(tokens.cache.read);
    tokens.cache.write = usageNumber(tokens.cache.write);
  }

  const usage = {};
  if (hasTokens) usage.mainLoop = tokens;
  if (hasCost && isUsageNumber(cost)) usage.totalCostUsd = cost;

  setUsageOrDelete(state, Object.keys(usage).length > 0 ? usage : undefined);
}

/**
 * Builds the message for a failed turn. Only an ordinary non-zero exit reads the stream: a signal,
 * a timeout, and a spawn failure are reported as themselves, because the output a killed process
 * left behind names a provider error that is not why the turn died (#326).
 */
function failureMessage(err, events, timeout) {
  const cause = execFailureCause("opencode", err, timeout);

  if (cause) {
    return cause;
  }

  return `opencode exited with code ${err.exitCode}: ${lastErrorDetail(events) || NO_DETAIL}`;
}

/** Returns whether a stream value is a token count or a cost: a finite, non-negative number. */
function isUsageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Returns a stream usage value, or 0 for anything that is not a count, so a sum stays a number. */
function usageNumber(value) {
  return isUsageNumber(value) ? value : 0;
}

/**
 * Returns the described detail of the last well-formed `error` event, or an empty string when the
 * stream names none. A payload this adapter cannot read contributes no detail, and a non-object
 * line is not an event at all, so neither reaches the message.
 */
function lastErrorDetail(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type === "error") {
      const detail = providerDetail(event.error);

      if (detail) {
        return detail;
      }
    }
  }

  return "";
}

/**
 * Returns the described detail of a provider error object, or an empty string when the object is
 * not one this adapter can read. Only the string fields and a string or number status reach
 * the format, so it cannot throw on the payload, and a field of any other type is a malformed
 * detail rather than a coerced one (issue #326).
 */
function providerDetail(error) {
  if (!isJsonObject(error)) {
    return "";
  }

  const type = typeof error.type === "string" ? error.type : "";
  const message = typeof error.message === "string" ? error.message : "";
  const status =
    typeof error.status === "number" || typeof error.status === "string" ? error.status : undefined;

  if (!type && !message) {
    return "";
  }

  const detail = [type, message].filter(Boolean).join(": ");
  return boundedLine(status === undefined ? detail : `${detail} (status ${status})`, DETAIL_LIMIT);
}

/** Returns the byte count of a stream, for a debug line that carries size and not content. */
function byteLength(text) {
  return Buffer.byteLength(text ?? "");
}

/**
 * Flattens `text` to one line and keeps at most `limit` characters of it. The bound is what stops a
 * long provider message from reaching the envelope.
 */
function boundedLine(text, limit) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}
