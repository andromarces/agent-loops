// Step accounting of one batch loop across attempts (ADR 0106 decision 10).
import { readFile } from "node:fs/promises";
import { isJsonObject } from "../lib/json.mjs";

const DISPATCH_ACTIONS = new Set(["run_worker", "run_reviewer"]);

/**
 * Counts the charged steps of a loop transcript, whose segments split at each `continued` event.
 * Each segment contributes its highest `result` event's `stepsUsed`; a trailing dispatch action
 * with no later result adds one, because the runtime charges a step before the child starts. The
 * checkpoint count is a cross-check, and the larger value wins.
 * @param {string} text the transcript JSON
 * @returns {{ ok: true, steps: number, segments: number } | { ok: false, reason: string }}
 */
export function countSteps(text, { checkpointSteps = 0 } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the transcript is not valid JSON" };
  }
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
 * Reads `file` and counts its steps. A missing file is a proven zero only for a loop with no
 * attempt; any other missing or malformed record cannot establish a budget.
 */
export async function readStepsUsed(file, { checkpointSteps = 0, attempts = 0 } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" && attempts === 0) return { ok: true, steps: checkpointSteps };
    return { ok: false, reason: "the transcript is missing" };
  }
  const counted = countSteps(text, { checkpointSteps });
  if (!counted.ok) return counted;
  if (attempts > 0 && counted.segments < attempts) {
    return {
      ok: false,
      reason: `the transcript holds ${counted.segments} segment(s) for ${attempts} attempt(s)`,
    };
  }
  return counted;
}

/**
 * Reads the recorded exit code of a transcript. `ok` is false for a missing or malformed record,
 * which proves nothing about the last attempt. `proven` is true when the run ended with its `gate`
 * event, or when a nonzero exit carries an error text, so the default `exitCode: 1` of a transcript
 * written before the first turn is never read as a finished run.
 * @returns {Promise<{ ok: true, exitCode: number | null, proven: boolean } | { ok: false, reason: string }>}
 */
export async function readTranscriptExit(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: err?.code === "ENOENT" ? "the transcript is missing" : err.message,
    };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the transcript is not valid JSON" };
  }
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
