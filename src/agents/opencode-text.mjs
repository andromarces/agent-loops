import { redactEnvSecrets } from "../lib/redact.mjs";
import {
  REPORT_LABEL_NAMES,
  guardVerdict,
  hasClosingBlockAttempt,
  leadingRequiredLabelStart,
  reportHeadingName,
} from "../lib/report.mjs";
import { isNonEmptyString } from "./shared.mjs";

// A part that opens a report label with a colon. The reviewer `Verdict:` line is excluded: it gates
// acceptance, so a `Verdict:` that sat mid-line before the join stays mid-line and reads as
// `unknown` rather than becoming a verdict the model never wrote on its own line.
const COLON_LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")}):`, "i");
const COLON_BLOCK_LABEL_LINE = new RegExp(
  `^(?:(?:${REPORT_LABEL_NAMES.join("|")}):|Verdict:)`,
  "i",
);
const COLON_BLOCK_START = /^Conclusion:/i;

// A column-0 `**Label**` heading span of the assembled message text. A colon after the closing
// marks keeps the marks, because `**Label**:` is no heading.
const BOLD_HEADING_SPAN = new RegExp(`\\*\\*(${REPORT_LABEL_NAMES.join("|")})\\*\\*(?!:)`, "gi");

// A line that opens a report label, with a colon or as a lone heading. `reportHeadingName` reads
// both heading forms, so a plain and a bold heading split and join alike.
function opensLabelLine(line) {
  return COLON_LABEL_LINE.test(line) || reportHeadingName(line) !== null;
}

// A line that opens a report label inside the block, or the reviewer `Verdict:` line.
function opensBlockLabelLine(line) {
  return COLON_BLOCK_LABEL_LINE.test(line) || reportHeadingName(line) !== null;
}

// True when the line starts the closing block, a `Conclusion:` line or a Conclusion heading.
function opensBlockStart(line) {
  return COLON_BLOCK_START.test(line) || reportHeadingName(line)?.toLowerCase() === "conclusion";
}

const INTERLEAVED_MESSAGE = "opencode returned closing block attempts from interleaved messages.";
const UNIDENTIFIED_MESSAGE = "opencode returned a closing block that spans unidentified parts.";

// Upper bound, in UTF-16 code units, on the joined text of a stream error.
const ERROR_TEXT_LIMIT = 4000;

/**
 * Joins the text parts of a turn into one response. Parts group into messages by `part.messageID`
 * (parts without a valid id form one unidentified message). A part glues to the one before it,
 * except that a part opening a report label starts its own line, and a bold heading starts its
 * own line only when its plain line holds the heading alone. A new message starts its own line.
 * The last message that holds a closing block attempt governs alone: earlier attempt-holding
 * messages drop, messages without an attempt stay.
 * The error text is redacted (ADR 0017) and bounded to its last 4000 code units. A later
 * redaction pass with a different environment can grow it past that bound.
 * @throws {Error} when two attempt-holding messages interleave in the stream, or when the
 * governing message is the unidentified one, joins to an accept verdict, and its closing block
 * label lines come from more than one part.
 * @param {{ part?: { text?: string, messageID?: string } }[]} events
 * @returns {string}
 */
export function joinTextParts(events) {
  const groups = new Map();
  events.forEach(({ part }, position) => {
    const key = isNonEmptyString(part.messageID) ? part.messageID : null;
    const group = groups.get(key) ?? { first: position, parts: [] };
    group.last = position;
    group.parts.push(part.text);
    group.unidentified = key === null;
    groups.set(key, group);
  });
  // A Map keeps insertion order, which is the order of each message's first part.
  const messages = [...groups.values()];

  // Sorted by `first`, two spans overlap exactly when one starts before the previous one ends.
  const attempts = messages.filter((group) => hasClosingBlockAttempt(group.parts.join("")));
  for (let i = 1; i < attempts.length; i += 1) {
    if (attempts[i].first < attempts[i - 1].last) {
      throw boundedError(INTERLEAVED_MESSAGE, messages);
    }
  }
  const governing = attempts.at(-1);
  if (
    governing?.unidentified &&
    guardVerdict(joinMessages([governing])) === "accept" &&
    labelLinePartCount(governing.parts) > 1
  ) {
    throw boundedError(UNIDENTIFIED_MESSAGE, messages);
  }

  const dropped = new Set(attempts);
  dropped.delete(governing);
  return joinMessages(messages.filter((group) => !dropped.has(group)));
}

/**
 * Builds a stream error: the cause, then the joined text. The text is redacted first, because a
 * cut inside a secret value leaves a suffix that exact-value redaction no longer matches. A longer
 * text keeps its last ERROR_TEXT_LIMIT code units, cut on a code point boundary, after a line that
 * states the cut.
 */
function boundedError(cause, messages) {
  const text = redactEnvSecrets(joinMessages(messages));
  if (text.length <= ERROR_TEXT_LIMIT) return new Error(`${cause}\n${text}`);
  let tail = text.slice(-ERROR_TEXT_LIMIT);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  const note = `[text cut: the last ${tail.length} of ${text.length} characters follow]`;
  return new Error(`${cause}\n${note}\n${tail}`);
}

function joinMessages(messages) {
  return messages.reduce((text, { parts }) => {
    const opening = parts.join("");
    const breaks = text && opening && !text.endsWith("\n");
    return joinParts(breaks ? `${text}\n` : text, parts).text;
  }, "");
}

/**
 * Joins the parts of one message onto `text`. A part opens a line of its own when a plain part at
 * that point opens a report label line, which is main's rule. A bold heading breaks only when its
 * plain line holds the heading alone, so a line with text on either side of the marks stays inline
 * as main leaves the bold stream. Returns the joined text and, for the closing-block guard, the
 * plain joined text with the span of each part in it.
 * @param {string} text the joined text before this message
 * @param {string[]} parts the text parts of the message
 * @returns {{ text: string, plainText: string, plainSpans: number[][] }}
 */
function joinParts(text, parts) {
  const origin = parts.join("");
  const removed = new Set();
  const headings = [];
  for (const match of origin.matchAll(BOLD_HEADING_SPAN)) {
    const start = match.index;
    const end = start + match[0].length;
    removed.add(start);
    removed.add(start + 1);
    removed.add(end - 2);
    removed.add(end - 1);
    headings.push([start + 2, start]);
  }
  const keptBefore = Array.from({ length: origin.length + 1 }, () => 0);
  const plainOrigins = [];
  const plainByOrigin = Array.from({ length: origin.length }, () => -1);
  for (let index = 0; index < origin.length; index++) {
    const kept = !removed.has(index);
    keptBefore[index + 1] = keptBefore[index] + (kept ? 1 : 0);
    if (kept) {
      plainByOrigin[index] = plainOrigins.length;
      plainOrigins.push(index);
    }
  }
  const plain = plainOrigins.map((index) => origin[index]).join("");
  // The name's first plain position maps to the original index of its opening marks, so a heading
  // line breaks before the marks. Closing marks before another label never move it.
  const openingByPlain = new Map(
    headings.map(([nameStart, opening]) => [plainByOrigin[nameStart], opening]),
  );
  const bounds = [];
  let bound = 0;
  for (const part of parts) {
    bounds.push([bound, bound + part.length]);
    bound += part.length;
  }
  const plainBreaks = [];
  let endsWithNewline = text.endsWith("\n");
  for (const [from, to] of bounds) {
    const plainPart = plain.slice(keptBefore[from], keptBefore[to]);
    if (!endsWithNewline && opensLabelLine(plainPart)) {
      plainBreaks.push(keptBefore[from]);
    }
    if (plainPart.length > 0) {
      endsWithNewline = plainPart.endsWith("\n");
    }
  }
  // The plain line from a break, cut at the next newline or the next inserted break.
  const lineEnd = (at) => {
    const nextBreak = plainBreaks.find((position) => position > at) ?? plain.length;
    const newline = plain.indexOf("\n", at);
    return newline === -1 || newline > nextBreak ? nextBreak : newline;
  };
  const breaks = new Set();
  for (const at of plainBreaks) {
    const opening = openingByPlain.get(at);
    if (opening === undefined) {
      breaks.add(plainOrigins[at]);
    } else if (isLoneHeading(plain.slice(at, lineEnd(at)))) {
      // A bold heading with text on either side in its line is no heading, and main keeps it inline.
      breaks.add(opening);
    }
  }
  const inserted = [...breaks].sort((left, right) => left - right);
  return {
    text: `${text}${insertBreaks(origin, inserted)}`,
    plainText: insertBreaks(plain, plainBreaks),
    plainSpans: bounds.map(([from, to]) => spanOf(keptBefore[from], keptBefore[to], plainBreaks)),
  };
}

/** True when `text` trimmed is one of the six report label names. */
function isLoneHeading(text) {
  const name = text.trim().toLowerCase();
  return REPORT_LABEL_NAMES.some((label) => label.toLowerCase() === name);
}

/** `value` with a newline at each ascending position. */
function insertBreaks(value, positions) {
  let out = "";
  let cursor = 0;
  for (const at of positions) {
    out += `${value.slice(cursor, at)}\n`;
    cursor = at;
  }
  return out + value.slice(cursor);
}

/** The span of `value[from, to)` in the text that `insertBreaks` produced from `positions`. */
function spanOf(from, to, positions) {
  const first =
    to > from
      ? from + positions.filter((at) => at <= from).length
      : from + positions.filter((at) => at < from).length;
  return [first, to + positions.filter((at) => at < to).length];
}

/**
 * Counts the parts that a label line of the closing block touches, in the plain join of `parts`.
 * The plain join drops the bold heading marks, so the opening `**` of a heading adds no part that
 * main's plain line does not touch. The block starts at the last `Conclusion:` line, or at a lone
 * required label line or `Verdict:` line above it. A label line touches every part that holds one
 * of its characters, so a label cut across parts counts both. A line terminator or trailing space
 * is no character of the line. Text before the block and plain prose after it touch no label line.
 */
function labelLinePartCount(parts) {
  const { plainText: text, plainSpans: spans } = joinParts("", parts);

  let offset = 0;
  const lines = text.split("\n").map((line) => {
    const span = [offset, offset + line.trimEnd().length];
    offset += line.length + 1;
    return { line, span };
  });
  const last = lines.findLastIndex(({ line }) => opensBlockStart(line));
  const start =
    last === -1
      ? -1
      : leadingRequiredLabelStart(
          lines.map(({ line }) => line),
          last,
        );
  const touched = new Set();
  for (const { line, span } of lines.slice(Math.max(start, 0))) {
    if (start === -1 || !opensBlockLabelLine(line)) continue;
    spans.forEach(([from, to], index) => {
      if (from < span[1] && span[0] < to) touched.add(index);
    });
  }
  return touched.size;
}
