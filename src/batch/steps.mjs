// Step accounting of one batch loop across attempts (ADR 0106 decision 10).
import { readFile } from "node:fs/promises";
import { isJsonObject } from "../lib/json.mjs";

const DISPATCH_ACTIONS = new Set(["run_worker", "run_reviewer"]);

/**
 * Counts the charged steps of one parsed loop transcript. Its segments split at each `continued`
 * event. Each segment contributes its highest `result` event's `stepsUsed`. A trailing dispatch
 * action with no later result adds one, because the runtime charges a step before the child starts.
 * The checkpoint count is a cross-check, and the larger value wins.
 * @param {unknown} data the parsed transcript
 * @returns {{ ok: true, steps: number, segments: number } | { ok: false, reason: string }}
 */
function countStepsFromData(data, { checkpointSteps = 0 } = {}) {
  if (!isJsonObject(data) || !Array.isArray(data.events)) {
    return { ok: false, reason: "the transcript holds no event list" };
  }
  const segments = [[]];
  for (const event of data.events) {
    if (!isJsonObject(event))
      return { ok: false, reason: "the transcript holds a malformed event" };
    if (event.type === "continued") segments.push([]);
    else segments.at(-1).push(event);
  }
  let total = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const events = segments[index];
    let highest = null;
    let lastResult = -1;
    for (let cursor = 0; cursor < events.length; cursor += 1) {
      const event = events[cursor];
      if (event.type !== "result") continue;
      if (!Number.isInteger(event.stepsUsed) || event.stepsUsed < 0) {
        return { ok: false, reason: "a result event holds no step count" };
      }
      highest = Math.max(highest ?? 0, event.stepsUsed);
      lastResult = cursor;
    }
    total += highest ?? 0;
    const trailing = events
      .slice(lastResult + 1)
      .some((event) => event.type === "action" && DISPATCH_ACTIONS.has(event.action?.action));
    if (trailing) total += 1;
  }
  return {
    ok: true,
    steps: Math.max(total, Number.isInteger(checkpointSteps) ? checkpointSteps : 0),
    segments: segments.length,
  };
}

/**
 * Counts the steps of an already-parsed transcript. A transcript with fewer segments than attempts
 * cannot prove its count.
 * @returns {{ ok: true, steps: number } | { ok: false, reason: string }}
 */
export function stepsUsedFromData(data, { checkpointSteps = 0, attempts = 0 } = {}) {
  const counted = countStepsFromData(data, { checkpointSteps });
  if (!counted.ok) return counted;
  if (attempts > 0 && counted.segments < attempts) {
    return {
      ok: false,
      reason: `the transcript holds ${counted.segments} segment(s) for ${attempts} attempt(s)`,
    };
  }
  return counted;
}

/** The step count from one transcript read, with the refusal text of a direct read. */
export function stepsFromRead(read, { checkpointSteps = 0, attempts = 0 } = {}) {
  if (read.ok) return stepsUsedFromData(read.data, { checkpointSteps, attempts });
  if (read.missing === true && attempts === 0) return { ok: true, steps: checkpointSteps };
  return {
    ok: false,
    reason:
      read.invalid === true ? "the transcript is not valid JSON" : "the transcript is missing",
  };
}

/**
 * Reads one transcript once. The result is `{ ok: true, data }`, or a refusal that names the cause.
 * `readText` is injectable so a caller can replace the file read.
 */
export async function readTranscript(file, readText = (path) => readFile(path, "utf8")) {
  let text;
  try {
    text = await readText(file);
  } catch (err) {
    return {
      ok: false,
      missing: err?.code === "ENOENT",
      reason: err?.code === "ENOENT" ? "the transcript is missing" : "the transcript is unreadable",
    };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, invalid: true, reason: "the transcript is not valid JSON" };
  }
}

/**
 * Reads the orchestrator abort that ended a run. An `abort` action stops the loop at exit 1, and the
 * CLI records only a `gate` event after it. The last action before that gate names the decision. A
 * later action, result, or continuation proves the run went past the abort.
 * @param {unknown} data the parsed transcript
 * @param {number | null} exitCode the recorded exit code
 * @returns {{ reason: string } | null} the first line of the abort reason, or `null`
 */
export function transcriptAbortFromData(data, exitCode) {
  if (exitCode !== 1 || !isJsonObject(data) || !Array.isArray(data.events)) return null;
  let index = data.events.length - 1;
  while (index >= 0 && isJsonObject(data.events[index]) && data.events[index].type === "gate") {
    index -= 1;
  }
  const last = index < 0 ? null : data.events[index];
  if (!isJsonObject(last) || last.type !== "action" || last.action?.action !== "abort") {
    return null;
  }
  const text = typeof last.action.reason === "string" ? last.action.reason : "";
  return { reason: text.split("\n")[0].trim() };
}

/**
 * Reads the recorded exit code of a parsed transcript. `ok` is false for a malformed record, which
 * proves nothing about the last attempt. `proven` is true when the run ended with its `gate` event,
 * or when a nonzero exit carries an error text. The default `exitCode: 1` of a transcript written
 * before the first turn is never read as a finished run.
 * @returns {{ ok: true, exitCode: number | null, proven: boolean } | { ok: false, reason: string }}
 */
export function transcriptExitFromData(data) {
  if (!isJsonObject(data) || !("exitCode" in data)) {
    return { ok: false, reason: "the transcript holds no exit code" };
  }
  if (data.exitCode !== null && !Number.isInteger(data.exitCode)) {
    return { ok: false, reason: "the transcript holds an unreadable exit code" };
  }
  const last = Array.isArray(data.events) ? data.events.at(-1) : null;
  const errorText = typeof data.error === "string" ? data.error.trim() : "";
  const proven =
    last?.type === "gate" || (data.exitCode !== 0 && data.exitCode !== null && errorText !== "");
  return { ok: true, exitCode: data.exitCode, proven };
}
