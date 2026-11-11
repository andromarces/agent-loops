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
function emptyLoopReport() {
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

// A copied array keeps its first 20 entries. A count beside it names the rest.
const MAX_LIST_ITEMS = 20;
// A source list can name its own total under a different key.
const LIST_TOTAL_KEYS = { changedPaths: "changedCount", lateChangedPaths: "lateChangedCount" };

/**
 * Returns the dropped count of one array. A valid source total wins over the local cap count.
 * @returns {number}
 */
function listOverflow(source, key, entry) {
  const total = source[LIST_TOTAL_KEYS[key] ?? `${key}Count`];
  if (!Number.isInteger(total) || total < 0) return entry.overflow;
  return Math.max(0, total - entry.value.length);
}

/**
 * Redacts one copied value. An array keeps its first 20 entries and returns the dropped count.
 * @returns {{ value: unknown, overflow: number }}
 */
function redactEntry(value) {
  if (typeof value === "string") return { value: redactAndClean(value), overflow: 0 };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_LIST_ITEMS).map((item) => redactEntry(item).value);
    return { value: items, overflow: Math.max(0, value.length - MAX_LIST_ITEMS) };
  }
  if (isJsonObject(value)) {
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      const entry = redactEntry(item);
      redacted[key] = entry.value;
      if (Array.isArray(item)) redacted[`${key}Overflow`] = listOverflow(value, key, entry);
    }
    return { value: redacted, overflow: 0 };
  }
  return { value, overflow: 0 };
}

function redactValue(value) {
  return redactEntry(value).value;
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

/**
 * The Deferred, Notes, and Blockers of the last child result in one transcript segment, beside the
 * role of that turn. A segment without a result, or a result without a parsed report, reads null
 * items and a reason, so no absent value reads as "none".
 * @param {Array<object>} events
 */
function lastTurnItems(events) {
  let found = null;
  for (const event of events) {
    if (event.type === "result") found = event;
  }
  const role = typeof found?.role === "string" ? found.role : null;
  const items = { role, deferred: null, notes: null, blockers: null };
  if (found === null) {
    return { ...items, reason: "the last attempt holds no child result" };
  }
  if (!isJsonObject(found.result?.report)) {
    return { ...items, reason: "the last child turn has no parsed report" };
  }
  const report = found.result.report;
  const item = (value) => (typeof value === "string" ? redactAndClean(value) : null);
  return {
    ...items,
    deferred: item(report.deferred),
    notes: item(report.notes),
    blockers: item(report.blockers),
    reason: null,
  };
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

/** Whether a reviewer value holds a message: a non-blank string other than "none", or an array. */
function isReviewerValue(value) {
  return (
    (typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "none") ||
    (Array.isArray(value) && value.length > 0)
  );
}

/** Redacts one present reviewer value, or returns null when it is absent or reads "none". */
function reviewerEntry(value) {
  return isReviewerValue(value) ? redactEntry(value) : null;
}

/** The separate reviewer fields of a review-only report, with a count beside each capped array. */
function reviewerFields(reviewer) {
  const fields = { verdict: reviewer?.verdict ?? "unknown" };
  const entries = [
    ["reviewerFindings", reviewer?.findings],
    ["reviewerBlockers", reviewer?.blockers],
    ["reviewerNotes", reviewer?.notes],
    ["reviewerDeferred", reviewer?.deferred],
  ];
  for (const [name, entry] of entries) {
    fields[name] = entry?.value ?? null;
    if (Array.isArray(entry?.value)) fields[`${name}Overflow`] = entry.overflow;
  }
  return fields;
}

/** The verdict, findings, blockers, notes, and deferred values of the last reviewer result. */
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
    const rawFindings = [report?.findings, result.findings].filter(isReviewerValue);
    const findings =
      rawFindings.length === 0
        ? null
        : reviewerEntry(rawFindings.length === 1 ? rawFindings[0] : rawFindings.flat());
    found = {
      verdict,
      findings,
      blockers: reviewerEntry(report?.blockers),
      notes: reviewerEntry(report?.notes),
      deferred: reviewerEntry(report?.deferred),
    };
  }
  return found;
}

/**
 * Builds the report of one parsed transcript. `attempts` is the loop attempt count, so a transcript
 * that does not cover the last attempt fails closed. `reviewOnly` adds the reviewer verdict and the
 * separate findings, blockers, notes, and deferred fields. Every copied text is redacted here, at
 * the reporting boundary, and an unread record carries no field that reads as "none".
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
    ...(summary === null ? { lastTurnItems: lastTurnItems(lastEvents) } : {}),
    ...(reviewOnly ? reviewerFields(reviewer) : {}),
  };
}

/**
 * Builds one loop report from an already-read transcript. `read` holds `{ ok: true, data }` or
 * `{ ok: false, missing, reason }`. A missing transcript of a loop with no attempt is an empty report.
 */
export function loopReportFromRead(read, { attempts = 0, reviewOnly = false } = {}) {
  if (read.ok) return buildLoopReport(read.data, { attempts, reviewOnly });
  if (read.missing === true && attempts === 0) return emptyLoopReport();
  return unreadReport(read.reason);
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
    return loopReportFromRead(
      {
        ok: false,
        missing: err?.code === "ENOENT",
        reason:
          err?.code === "ENOENT" ? "the transcript is missing" : "the transcript is unreadable",
      },
      { attempts, reviewOnly },
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return loopReportFromRead(
      { ok: false, reason: "the transcript is not valid JSON" },
      { attempts, reviewOnly },
    );
  }
  return loopReportFromRead({ ok: true, data }, { attempts, reviewOnly });
}
