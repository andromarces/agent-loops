// Step accounting of one batch loop across attempts (ADR 0106 decision 10).
import { readFile } from "node:fs/promises";
import { isJsonObject } from "../lib/json.mjs";

const DISPATCH_ACTIONS = new Set(["run_worker", "run_reviewer"]);

/**
 * Counts the charged steps of a loop transcript, whose segments split at each `continued` event.
 * Each segment contributes its highest `result` event's `stepsUsed`; a trailing dispatch action in
 * the last segment with no later result adds one, because the runtime charges a step before the
 * child starts. The checkpoint count is a cross-check, and the larger value wins.
 * @param {string} text the transcript JSON
 * @returns {{ ok: true, steps: number } | { ok: false, reason: string }}
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
    if (index === segments.length - 1) {
      const trailing = events
        .slice(lastResult + 1)
        .some((event) => event.type === "action" && DISPATCH_ACTIONS.has(event.action?.action));
      if (trailing) total += 1;
    }
  }
  return {
    ok: true,
    steps: Math.max(total, Number.isInteger(checkpointSteps) ? checkpointSteps : 0),
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
  return countSteps(text, { checkpointSteps });
}
