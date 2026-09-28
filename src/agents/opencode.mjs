import { parseJsonLines } from "../lib/json.mjs";
import { exec } from "../lib/exec.mjs";
import { logDebug, logInfo } from "../lib/log.mjs";
import { REPORT_LABEL_NAMES } from "../lib/report.mjs";
import { resumeMismatchError } from "./shared.mjs";

// A part that opens a report label. The reviewer `Verdict:` line is excluded: it gates acceptance,
// so a `Verdict:` that sat mid-line before the join stays mid-line and reads as `unknown` rather
// than becoming a verdict the model never wrote on its own line (issue #316).
const LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")}):`, "i");

// Bounds for a non-zero-exit message, so no part of a stream or a stderr dump can reach the
// dispatch envelope or the state file (issue #326).
const DETAIL_LIMIT = 300;
const STDERR_LIMIT = 200;

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
    // A non-zero exit can still carry completed-step usage. Expose it, then rethrow.
    setUsage(state, events);
    logDebug(`opencode stream on non-zero exit: ${err?.stdout ?? ""}`);

    // exec builds its message from the whole stream, so the adapter always replaces it with one
    // bounded line. The stream stays on the error for debug and stays out of the envelope and the
    // state file, which a turn can otherwise make hundreds of kilobytes (issue #326).
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.message = failureMessage(err, lastErrorDetail(events));
    throw failure;
  }

  const events = parseJsonLines(stdout);

  const sessionId = events.map((event) => event.sessionID).find(Boolean);

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
  const errorEvent = events.find((event) => event.type === "error");

  if (errorEvent) {
    throw new Error(`opencode returned an error event: ${describeError(errorEvent.error)}`);
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
 * column 0 and otherwise reads the whole block as `raw` (issue #316). Every other part, including
 * one that opens the reviewer's `Verdict:` line, keeps the text before it, so the join adds a line
 * break only before a report label.
 * @param {{ part?: { text?: string } }[]} events
 * @returns {string}
 */
function joinTextParts(events) {
  return events.reduce((text, event) => {
    const part = event.part.text;
    return LABEL_LINE.test(part) && !text.endsWith("\n") ? `${text}\n${part}` : `${text}${part}`;
  }, "");
}

/**
 * Sets `state.usage` from the `step_finish` parts of the stream, or removes it when the stream
 * carries none. Each completed step emits one `step_finish` part with `tokens` and `cost`, so
 * both fields sum across steps. No event names the model, so `models` is omitted.
 */
function setUsage(state, events) {
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let cost = 0;
  let hasTokens = false;
  let hasCost = false;

  for (const event of events) {
    if (event.type !== "step_finish") {
      continue;
    }

    const part = event.part ?? {};

    if (part.tokens && typeof part.tokens === "object") {
      hasTokens = true;
      tokens.input += part.tokens.input ?? 0;
      tokens.output += part.tokens.output ?? 0;
      tokens.reasoning += part.tokens.reasoning ?? 0;
      tokens.cache.read += part.tokens.cache?.read ?? 0;
      tokens.cache.write += part.tokens.cache?.write ?? 0;
    }

    if (typeof part.cost === "number") {
      hasCost = true;
      cost += part.cost;
    }
  }

  const usage = {};
  if (hasTokens) usage.mainLoop = tokens;
  if (hasCost) usage.totalCostUsd = cost;

  if (Object.keys(usage).length > 0) {
    state.usage = usage;
  } else {
    delete state.usage;
  }
}

/**
 * Builds the message for a non-zero exit: the child exit code, the described detail of the last
 * well-formed error event when the stream names one, then a bounded stderr tail. No part of the
 * stream reaches the message, so the dispatch envelope and the state file stay readable (#326).
 */
function failureMessage(err, detail) {
  const status =
    err?.exitCode == null
      ? "opencode exited without an exit code"
      : `opencode exited with code ${err.exitCode}`;

  return [status, detail, boundedLine(err?.stderr, STDERR_LIMIT, "tail")]
    .filter(Boolean)
    .join(": ");
}

/**
 * Returns the described detail of the last well-formed `error` event, or an empty string when the
 * stream names none. `describeError` reports `unknown error` for a payload it cannot read, so a
 * malformed event contributes no detail and the message falls back to the stderr tail.
 */
function lastErrorDetail(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type !== "error") {
      continue;
    }

    const detail = describeError(event.error);

    if (detail !== "unknown error") {
      return boundedLine(detail, DETAIL_LIMIT);
    }
  }

  return "";
}

/**
 * Flattens `text` to one line and keeps `limit` characters of it, the head by default and the tail
 * when `keep` is `tail`. The bound is what stops a long stream line from reaching the envelope.
 */
function boundedLine(text, limit, keep = "head") {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length <= limit) {
    return flat;
  }

  return keep === "tail" ? `...${flat.slice(-limit)}` : `${flat.slice(0, limit)}...`;
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
