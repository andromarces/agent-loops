import { redactEnvSecrets } from "../lib/redact.mjs";
import {
  REPORT_LABEL_NAMES,
  guardVerdict,
  hasClosingBlockAttempt,
  leadingRequiredLabelStart,
} from "../lib/report.mjs";
import { isNonEmptyString } from "./shared.mjs";

// A part that opens a report label. The reviewer `Verdict:` line is excluded: it gates acceptance,
// so a `Verdict:` that sat mid-line before the join stays mid-line and reads as `unknown` rather
// than becoming a verdict the model never wrote on its own line. The heading form names the label
// alone on its line, so it opens a label line too.
const LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")})(?::|\\s*$)`, "i");
const BLOCK_LABEL_LINE = new RegExp(
  `^(?:(?:${REPORT_LABEL_NAMES.join("|")})(?::|\\s*$)|Verdict:)`,
  "i",
);
const BLOCK_START = /^Conclusion(?::|\s*$)/i;

const INTERLEAVED_MESSAGE = "opencode returned closing block attempts from interleaved messages.";
const UNIDENTIFIED_MESSAGE = "opencode returned a closing block that spans unidentified parts.";

// Upper bound, in UTF-16 code units, on the joined text of a stream error.
const ERROR_TEXT_LIMIT = 4000;

/**
 * Joins the text parts of a turn into one response. Parts group into messages by `part.messageID`
 * (parts without a valid id form one unidentified message). A part glues to the one before it,
 * except that a part opening a report label starts its own line, and a new message
 * starts its own line. The last message that holds a closing block attempt governs
 * alone: earlier attempt-holding messages drop, messages without an attempt stay.
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
    return parts.reduce(joinPart, breaks ? `${text}\n` : text);
  }, "");
}

/**
 * Counts the parts that a label line of the closing block touches, in the join of `parts`. The
 * block starts at the last `Conclusion:` line, or at a lone required label line or `Verdict:`
 * line above it. A label line touches every part that holds one of its
 * characters, so a label cut across parts counts both. A line terminator or trailing space is no
 * character of the line. Text before the block and plain prose after it touch no label line.
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
    const span = [offset, offset + line.trimEnd().length];
    offset += line.length + 1;
    return { line, span };
  });
  const last = lines.findLastIndex(({ line }) => BLOCK_START.test(line));
  const start =
    last === -1
      ? -1
      : leadingRequiredLabelStart(
          lines.map(({ line }) => line),
          last,
        );
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
