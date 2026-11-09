// One loop report in a batch summary (adr/0115-batch-loop-final-report.md). It is built from the
// loop transcript once at the loop end, then stored in the loop checkpoint. `batch status` reads it
// from the checkpoint and never reads the transcript again.
import { readFile } from "node:fs/promises";
import { boundedWarnings } from "../lib/run-warnings.mjs";
import { isJsonObject } from "../lib/json.mjs";
import { redactAndClean } from "../lib/redact.mjs";
import { parseVerdict } from "../lib/report.mjs";

const BASE_SUMMARY_KEYS = ["changed", "verified", "deferred", "notDone", "open"];
// A finish records exit 0, or exit 4 for an unresolved PR-head compare.
const FINISH_EXIT_CODES = new Set([0, 4]);

/** The report of a loop that ran no attempt and wrote no transcript. */
export function emptyLoopReport() {
  return {
    state: "no-attempt",
    summary: null,
    error: null,
    failedTurnTest: null,
    warnings: [],
    warningsOverflow: 0,
    transcriptRead: { ok: true },
  };
}

/** The report of a stored loop whose checkpoint holds no report, such as a pre-change record. */
export function missingLoopReport() {
  return {
    state: "missing",
    summary: null,
    error: null,
    failedTurnTest: null,
    warnings: null,
    warningsOverflow: null,
    transcriptRead: { ok: false, reason: "the checkpoint holds no report" },
  };
}

function unreadReport(reason) {
  return {
    state: "unread",
    summary: null,
    error: null,
    failedTurnTest: null,
    warnings: null,
    warningsOverflow: null,
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
  if (data.warnings === undefined) return { warnings: [], warningsOverflow: 0 };
  if (!Array.isArray(data.warnings) || data.warnings.some((item) => typeof item !== "string")) {
    return null;
  }
  const bounded = boundedWarnings(data.warnings);
  const stored =
    Number.isInteger(data.warningsOverflow) && data.warningsOverflow > 0
      ? data.warningsOverflow
      : 0;
  return {
    warnings: bounded.warnings,
    warningsOverflow: bounded.warningsOverflow + stored,
  };
}

/** The verdict and findings of the last reviewer result in one transcript segment. */
function reviewerOutcome(events) {
  let found = null;
  for (const event of events) {
    if (event.type !== "result" || event.role !== "reviewer") continue;
    const result = event.result;
    if (!isJsonObject(result) || result.status !== "ok") continue;
    const report = isJsonObject(result.report) ? result.report : null;
    const response = typeof result.response === "string" ? result.response : "";
    const stated = report?.verdict ?? result.verdict;
    const verdict = ["accept", "reject", "unknown"].includes(stated)
      ? stated
      : parseVerdict(response);
    const raw = [
      report?.findings,
      result.findings,
      report?.blockers,
      report?.notes,
      report?.deferred,
    ].filter(
      (value) =>
        (typeof value === "string" &&
          value.trim() !== "" &&
          value.trim().toLowerCase() !== "none") ||
        (Array.isArray(value) && value.length > 0),
    );
    const findings =
      raw.length === 0
        ? null
        : raw.length === 1
          ? typeof raw[0] === "string"
            ? redactAndClean(raw[0])
            : redactValue(raw[0])
          : raw
              .map((value) =>
                typeof value === "string" ? redactAndClean(value) : redactValue(value),
              )
              .flat();
    found = { verdict, findings };
  }
  return found;
}

/**
 * Builds the report of one parsed transcript. `attempts` is the loop attempt count, so a transcript
 * that does not cover the last attempt fails closed. `reviewOnly` adds the reviewer verdict and
 * findings. Every copied text is redacted here, at the reporting boundary, and an unread record
 * carries no field that reads as "none".
 * @param {unknown} data the parsed transcript
 * @param {{ attempts?: number, reviewOnly?: boolean }} [options]
 */
export function buildLoopReport(data, { attempts = 0, reviewOnly = false } = {}) {
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
  const bounded = warningsOf(data);
  if (bounded === null) return unreadReport("the transcript holds a malformed warning list");

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
  const reviewer = reviewOnly ? reviewerOutcome(lastEvents) : null;

  return {
    state: "read",
    summary,
    error,
    failedTurnTest: failedTurnTest(lastEvents),
    warnings: bounded.warnings,
    warningsOverflow: bounded.warningsOverflow,
    transcriptRead: { ok: true },
    ...(reviewOnly
      ? { verdict: reviewer?.verdict ?? "unknown", findings: reviewer?.findings ?? null }
      : {}),
  };
}

/**
 * Reads one loop transcript and builds its report. A missing transcript of a loop with no attempt
 * is an empty report. Every other read or parse failure fails closed.
 * @param {string} file
 * @param {{ attempts?: number }} [options]
 */
export async function readLoopReport(file, { attempts = 0, reviewOnly = false } = {}) {
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
  return buildLoopReport(data, { attempts, reviewOnly });
}
