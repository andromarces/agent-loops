import { isJsonObject, parseJsonLines } from "../lib/json.mjs";
import { readProp } from "../lib/error-message.mjs";
import { exec } from "../lib/exec.mjs";
import { logDebug, logInfo } from "../lib/log.mjs";
import { REPORT_LABEL_NAMES, hasClosingBlockAttempt, parseVerdict } from "../lib/report.mjs";
import {
  asSessionId,
  keepFailedSessionId,
  resumeMismatchError,
  setUsageOrDelete,
} from "./shared.mjs";

// A part that opens a report label. The reviewer `Verdict:` line is excluded: it gates acceptance,
// so a `Verdict:` that sat mid-line before the join stays mid-line and reads as `unknown` rather
// than becoming a verdict the model never wrote on its own line (issue #316).
const LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")}):`, "i");

// Bounds for a failure message, so a long provider message cannot reach the dispatch envelope or
// the state file (issue #326). No part of stdout or stderr is allowed into the message: a stream
// carries model output, and stderr can carry a secret.
const DETAIL_LIMIT = 500;
const NO_DETAIL = "no provider error event in the output";
const UNKNOWN_ERROR = "unknown error";

// The built-in plan agent can launch explore and general subagents through the `subagent`
// action. They inherit the session model, so a read-only turn spends the role model budget
// invisibly. Deny the action for the read-only turn only; see the README.
// A global permissions allow can resolve after the plan agent's `edit` deny and cancel it, so
// deny `edit` here too. Shell stays available for read-only commands such as `git diff`.
const READONLY_CONFIG =
  '{"permissions":[{"action":"subagent","resource":"*","effect":"deny"},{"action":"edit","resource":"*","effect":"deny"}]}';

export async function runOpenCode(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;
  const args = ["run", "--standalone", "--format", "json"];
  const execOptions = { cwd, input: prompt, timeout, signal, role };

  if (state.sessionId) {
    args.push("--session", state.sessionId);
  }

  if (readOnly) {
    args.push("--agent", "plan");
    execOptions.env = { OPENCODE_CONFIG_CONTENT: READONLY_CONFIG };
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
      "opencode model: OpenCode selects its CLI default; the OpenCode session metadata records the model that ran.",
    );
  }

  let stdout;
  try {
    ({ stdout } = await exec("opencode", args, execOptions));
  } catch (err) {
    const events = parseJsonLines(err?.stdout ?? "");
    // A non-zero exit, a timeout, or a cancel can still carry completed-step usage and the session
    // id. Expose both, then rethrow.
    setUsage(state, events);
    keepFailedSessionId(state, events.map((event) => event?.sessionID).find(Boolean));
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

  // Select the first truthy id, so an empty id is skipped, then require it to be a non-empty
  // string: a later valid id never rescues a truthy invalid or mismatched first one.
  const sessionId = asSessionId(events.map((event) => event.sessionID).find(Boolean));

  if (!sessionId) {
    throw new Error("opencode did not return a session ID.");
  }

  if (state.sessionId && state.sessionId !== sessionId) {
    throw resumeMismatchError("opencode", "session", state.sessionId, sessionId);
  }

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

  return text.trim();
}

/**
 * Concatenates the text parts of a turn. The stream splits one response across parts at token
 * boundaries, so a part glues to the one before it. A part that opens a report label starts its
 * own line instead, because parseReportBlock (src/lib/report.mjs) matches each label plain at
 * column 0 and otherwise reads the whole block as `raw` (issue #316). Within a message, every other
 * part, including one that opens the reviewer's `Verdict:` line, keeps the text before it, so a
 * mid-line `Verdict:` never becomes a verdict the model did not write on its own line.
 * A different assistant message also starts its own line, so a late message cannot join the last
 * line of the closing block (issue #458). Parts are first grouped into messages by `part.messageID`
 * across the whole stream: a valid, non-empty string id names one message, so its parts rejoin it
 * even when another message came between (A/B/A). Every part without a valid id joins one
 * unidentified message for the whole stream, even when identified parts come between them, so it
 * never joins an identified message. A stream with no valid id is one message. Messages keep the order of their first part, and the parts of one message join
 * in stream order at that position. No break precedes a message that holds no text.
 * The last closing block governs, and it governs alone (issue #467). Each message holds its parts at
 * stream positions, and a message holds a closing block attempt (hasClosingBlockAttempt) when its
 * whole text does. When the position spans of two attempt-holding messages overlap, the stream order
 * of the blocks is ambiguous, so the join throws and the turn fails closed. Otherwise the spans are
 * disjoint, the last attempt-holding message governs, and the join drops every earlier one. A late
 * message that opens with a report label or `Verdict:` therefore never combines with the fields of
 * the earlier block. Messages without an attempt stay: narration before the block and plain prose
 * after it. This is the Codex and Copilot selection (lastClosingMessage, src/agents/shared.mjs) plus
 * those kept messages.
 * @throws {Error} when two messages that hold a closing block attempt interleave in the stream, or
 * when the governing message is the unidentified one, joins to an accept verdict, and the label
 * lines of its closing block (`Conclusion:` through `Verdict:`) come from more than one part,
 * however the lines or the labels are split. Parts without an id cannot be told apart from one
 * another, so a `Verdict:` part cannot be trusted to belong to the `Checks` line before it. A block
 * whole in one part never throws, whatever earlier parts mention (issue #509). The turn
 * then ends as an error, never as a report, so no accept can come from it. The first line of
 * the message names the cause, and the lines after it hold every message joined as above with
 * nothing dropped, so the envelope carries what the model wrote (issue #493).
 * @param {{ part?: { text?: string, messageID?: string } }[]} events
 * @returns {string}
 */
function joinTextParts(events) {
  const groups = new Map();
  events.forEach(({ part }, position) => {
    const key = isMessageId(part.messageID) ? part.messageID : null;
    const group = groups.get(key) ?? { first: position, parts: [] };
    group.last = position;
    group.parts.push(part.text);
    group.unidentified = key === null;
    groups.set(key, group);
  });
  const messages = [...groups.values()];

  const attempts = messages.filter((group) => hasClosingBlockAttempt(group.parts.join("")));
  if (attempts.some((a) => attempts.some((b) => a !== b && a.first < b.last && b.first < a.last))) {
    throw new Error(`${INTERLEAVED_MESSAGE}\n${joinMessages(messages)}`);
  }
  const governing = attempts.at(-1);
  if (
    governing?.unidentified &&
    parseVerdict(joinMessages([governing])) === "accept" &&
    labelLinePartCount(governing.parts) > 1
  ) {
    throw new Error(`${UNIDENTIFIED_MESSAGE}\n${joinMessages(messages)}`);
  }

  return joinMessages(messages.filter((group) => group === governing || !attempts.includes(group)));
}

const INTERLEAVED_MESSAGE = "opencode returned closing block attempts from interleaved messages.";
const UNIDENTIFIED_MESSAGE = "opencode returned a closing block that spans unidentified parts.";

function joinMessages(messages) {
  return messages.reduce((text, { parts }) => {
    const opening = parts.join("");
    const breaks = text && opening && !text.endsWith("\n");
    return parts.reduce(joinPart, breaks ? `${text}\n` : text);
  }, "");
}

const BLOCK_START = /^Conclusion:\s*/i;
const BLOCK_LABEL_LINE = new RegExp(`^(?:${[...REPORT_LABEL_NAMES, "Verdict"].join("|")}):`, "i");

/**
 * Counts the parts that a label line of the closing block touches, in the join of `parts`. The
 * block starts at the last `Conclusion:` line, as parseReportBlock reads it. A label line touches
 * every part that holds one of its characters, so a label cut across parts counts both. Text before
 * the block and plain prose after it touch no label line.
 */
function labelLinePartCount(parts) {
  const spans = [];
  const text = parts.reduce((joined, part) => {
    const next = joinPart(joined, part);
    spans.push([next.length - part.length, next.length]);
    return next;
  }, "");

  let offset = 0;
  const lines = text.split("\n").map((line) => {
    const span = [offset, offset + line.length];
    offset += line.length + 1;
    return { line, span };
  });
  const start = lines.findLastIndex(({ line }) => BLOCK_START.test(line));
  const touched = new Set();
  for (const { line, span } of lines.slice(Math.max(start, 0))) {
    if (start === -1 || !BLOCK_LABEL_LINE.test(line)) continue;
    spans.forEach(([from, to], index) => {
      if (from < span[1] && span[0] < to) touched.add(index);
    });
  }
  return touched.size;
}

function joinPart(text, part) {
  return LABEL_LINE.test(part) && !text.endsWith("\n") ? `${text}\n${part}` : `${text}${part}`;
}

const isMessageId = (value) => typeof value === "string" && value !== "";

/**
 * Sets `state.usage` from the `step_finish` parts of the stream, or removes it when the stream
 * carries none. Each completed step emits one `step_finish` part with `tokens` and `cost`, so
 * both fields sum across steps. No event names the model, so `models` is omitted. The read runs
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
  const cause = failureCause(err, timeout);

  if (cause) {
    return cause;
  }

  return `opencode exited with code ${err.exitCode}: ${lastErrorDetail(events) || NO_DETAIL}`;
}

/**
 * Returns the cause `exec` names for a timeout, a cancel, a signal, or a spawn failure, or an empty
 * string for an ordinary non-zero exit. The wording matches the message `exec` itself builds, so a
 * caller reads the same cause as it read before the adapter took the message over.
 */
function failureCause(err, timeout) {
  if (readProp(err, "timedOut")) {
    return typeof timeout === "number"
      ? `opencode timed out after ${timeout} seconds.`
      : "opencode timed out.";
  }

  if (err?.isCanceled) {
    return "opencode was canceled.";
  }

  if (err?.isTerminated) {
    return `opencode was killed by ${err.signal ?? "a signal"}.`;
  }

  if (err?.exitCode == null) {
    return "opencode failed to start.";
  }

  return "";
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
 * `describeError`, so it cannot throw on the payload, and a field of any other type is a malformed
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

  return boundedLine(describeError({ type, message, status }), DETAIL_LIMIT);
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

/**
 * Formats an OpenCode error event payload for the thrown message.
 * The payload carries `{ type, message, status }`; any field can be absent.
 */
function describeError(error) {
  if (!error || typeof error !== "object") {
    return "unknown error";
  }

  const detail = [error.type, error.message].filter(Boolean).join(": ") || "unknown error";
  return error.status == null ? detail : `${detail} (status ${error.status})`;
}
