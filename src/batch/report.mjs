// One loop report in a batch summary (adr/0115-batch-loop-final-report.md). It is built from the
// loop transcript once at the loop end, then stored in the loop checkpoint. `batch status` reads it
// from the checkpoint and never reads the transcript again.
import { readFile } from "node:fs/promises";
import { reportedEntryNames } from "../lib/entry-report.mjs";
import { isJsonObject } from "../lib/json.mjs";
import { redactAndClean } from "../lib/redact.mjs";

const BASE_SUMMARY_KEYS = ["changed", "verified", "deferred", "notDone", "open"];
// A finish records exit 0, or exit 4 for an unresolved PR-head compare.
const FINISH_EXIT_CODES = new Set([0, 4]);

/** The report of a loop that ran no attempt and wrote no transcript. */
export function emptyLoopReport() {
  return {
    summary: null,
    error: null,
    failedTurnTest: null,
    warnings: [],
    transcriptRead: { ok: true },
  };
}

function unreadReport(reason) {
  return {
    summary: null,
    error: null,
    failedTurnTest: null,
    warnings: null,
    transcriptRead: { ok: false, reason },
  };
}

function redactValue(value) {
  if (typeof value === "string") return redactAndClean(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map(redactValue);
    return items;
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

function readSummary(raw) {
  for (const key of BASE_SUMMARY_KEYS) {
    if (typeof raw[key] !== "string") return null;
  }
  const notes = raw.notes;
  if (notes !== undefined && notes !== null && typeof notes !== "string") return null;
  const summary = {};
  for (const key of BASE_SUMMARY_KEYS) summary[key] = redactAndClean(raw[key]);
  summary.notes = typeof notes === "string" && notes.trim() !== "" ? redactAndClean(notes) : null;
  return summary;
}

function lastAttemptEvents(events) {
  let start = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === "continued") start = index + 1;
  }
  return events.slice(start);
}

function finishSummary(events) {
  let found = null;
  for (const event of events) {
    if (
      event.type === "action" &&
      event.action?.action === "finish" &&
      isJsonObject(event.action.summary)
    ) {
      found = event.action.summary;
    }
  }
  return found;
}

function failedTurnTest(events) {
  let found = null;
  for (const event of events) {
    if (event.type === "test-run" && event.fatal === true && isJsonObject(event.testRun)) {
      found = event.testRun;
    }
  }
  return found === null ? null : redactValue(found);
}

function warningsOf(data) {
  if (data.warnings === undefined) return [];
  if (!Array.isArray(data.warnings) || data.warnings.some((item) => typeof item !== "string")) {
    return null;
  }
  return reportedEntryNames(data.warnings);
}

/**
 * Builds the report of one parsed transcript. `attempts` is the loop attempt count, so a transcript
 * that does not cover the last attempt fails closed. Every copied text is redacted here, at the
 * reporting boundary, and an unread record carries no field that reads as "none".
 * @param {unknown} data the parsed transcript
 * @param {{ attempts?: number }} [options]
 */
export function buildLoopReport(data, { attempts = 0 } = {}) {
  if (!isJsonObject(data)) return unreadReport("the transcript holds no record");
  if (!Array.isArray(data.events)) return unreadReport("the transcript holds no event list");
  for (const event of data.events) {
    if (!isJsonObject(event)) return unreadReport("the transcript holds a malformed event");
  }
  const segments = 1 + data.events.filter((event) => event.type === "continued").length;
  if (attempts > segments) {
    return unreadReport(`the transcript holds ${segments} segment(s) for ${attempts} attempt(s)`);
  }
  if (data.exitCode !== null && data.exitCode !== undefined && !Number.isInteger(data.exitCode)) {
    return unreadReport("the transcript holds an unreadable exit code");
  }
  if (data.error !== null && data.error !== undefined && typeof data.error !== "string") {
    return unreadReport("the transcript holds an unreadable error");
  }
  const warnings = warningsOf(data);
  if (warnings === null) return unreadReport("the transcript holds a malformed warning list");

  const lastEvents = lastAttemptEvents(data.events);
  let summary = null;
  if (FINISH_EXIT_CODES.has(data.exitCode)) {
    const raw = finishSummary(lastEvents);
    if (raw !== null) {
      summary = readSummary(raw);
      if (summary === null) return unreadReport("the transcript holds a malformed finish summary");
    }
  }
  const error =
    typeof data.error === "string" && data.error.trim() !== "" ? redactAndClean(data.error) : null;

  return {
    summary,
    error,
    failedTurnTest: failedTurnTest(lastEvents),
    warnings,
    transcriptRead: { ok: true },
  };
}

/**
 * Reads one loop transcript and builds its report. A missing transcript of a loop with no attempt
 * is an empty report. Every other read or parse failure fails closed.
 * @param {string} file
 * @param {{ attempts?: number }} [options]
 */
export async function readLoopReport(file, { attempts = 0 } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" && attempts === 0) return emptyLoopReport();
    return unreadReport(
      err?.code === "ENOENT" ? "the transcript is missing" : "the transcript is unreadable",
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return unreadReport("the transcript is not valid JSON");
  }
  return buildLoopReport(data, { attempts });
}
