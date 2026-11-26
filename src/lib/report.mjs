// Parses the closing block that reportBlock (src/prompts/rules.mjs) requires
// from every child turn, plus the reviewer Verdict line. Both parse only the
// final block. It starts at the last `Conclusion:` line, or at a lone required
// label or `Verdict:` line directly above that line.
// A column-0 line that holds only a report label name, or only `**Label**`, reads as that label.
// Labels or verdicts in earlier prose therefore never produce a verdict.

const REPORT_LABELS = [
  ["conclusion", "Conclusion", false],
  ["why", "Why", false],
  ["blockers", "Blockers", false],
  ["checks", "Checks", true],
  ["notes", "Notes", true],
  ["deferred", "Deferred", true],
];

export const REPORT_LABEL_NAMES = REPORT_LABELS.map(([, label]) => label);

const LABEL_NAMES = REPORT_LABEL_NAMES.join("|");
const LABEL_OR_VERDICT = [...REPORT_LABEL_NAMES, "Verdict"].join("|");

// Compiles each label pattern once, so a parse never compiles one per call.
const LABEL_PATTERN_BY_KEY = new Map(
  [...REPORT_LABEL_NAMES, "Verdict"].map((label) => [
    label.toLowerCase(),
    new RegExp(`^${label}:\\s*(.*)$`, "i"),
  ]),
);

// A column-0 label line whose name and colon sit inside `**...**`, for example `**Why:** text`.
// Only the six report labels gain this form, so a bold lead with another name stays text.
const BOLD_LABEL = `\\*\\*(?:${LABEL_NAMES}):\\*\\*`;
const BOLD_LABEL_LINE = new RegExp(`^\\*\\*(${LABEL_NAMES}):\\*\\*(.*)$`, "i");

// A column-0 `**Label**` at the start of a line, with no colon directly after the closing marks.
// Such a line reads as its plain form, so trailing text makes the same prose line the plain form
// makes. A colon after the marks keeps them, because `**Label**:` is a decorated label.
const BOLD_HEADING_START = new RegExp(`^\\*\\*(${LABEL_NAMES})\\*\\*(?!:)`, "i");

// A column-0 line that holds only a label name, for example `Conclusion`, or only `**Label**`, for
// example `**Conclusion**`, with optional trailing whitespace. Only the six report labels gain
// these forms. The first capture group holds the plain name, the second the bold name.
const PLAIN_HEADING_LABEL_LINE = new RegExp(
  `^(?:(${LABEL_NAMES})\\s*$|\\*\\*(${LABEL_NAMES})\\*\\*\\s*$)`,
  "i",
);

// The line that starts a plain heading block: a `Conclusion:` line, or a line that holds only
// `Conclusion` or only `**Conclusion**`.
const CONCLUSION_START_LINE = /^(?:Conclusion(?::|\s*$)|\*\*Conclusion\*\*\s*$)/i;

// A line that opens a known report label or a plain `Verdict` line at column 0, in any colon form.
// A lone label name, plain or bold, is no known label line.
const KNOWN_LABEL_LINE = new RegExp(`^(?:(?:${LABEL_NAMES}|Verdict):|${BOLD_LABEL})`, "i");

// A line that opens a plain report label at column 0.
const PLAIN_LABEL_LINE = new RegExp(`^(?:${LABEL_NAMES}):`, "i");

/**
 * True when `line` opens a known report label or a plain `Verdict` line at column 0, plain or bold.
 * A line inside a fenced code block is no known label.
 * @param {string} line
 * @param {boolean} [fenced]
 * @returns {boolean}
 */
function isKnownLabelLine(line, fenced = false) {
  return !fenced && KNOWN_LABEL_LINE.test(line);
}

// Lines inside a fenced code block, from a ``` or ~~~ opener to its matching closer. A bold report
// label inside a fence stays text.
function fencedLines(lines) {
  const fenced = Array.from({ length: lines.length }, () => false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence !== null) {
      fenced[i] = true;
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
        fence = null;
      }
    } else if (match) {
      fenced[i] = true;
      fence = match[1];
    }
  }
  return fenced;
}

/**
 * Returns the lines of `text` with each column-0 bold report label line normalized to its colon
 * form, for example `**Label:**` to `Label:`. A bold label inside a fenced code block stays text.
 * With `boldLabels` false, the bold lines are unchanged. A lone label name, plain or bold, is left
 * as written, because the plain heading path reads it. A column-0 line that holds only a report
 * label name reads as that label from the last `Conclusion:` line or lone `Conclusion` line to the
 * end, so an earlier lone label name stays prose. A bold heading at that start takes the lines
 * under it as the plain form does, because the plain heading path reads both forms. A `**Label**`
 * at the start of a line with trailing text reads as the plain name too, so it supplies the same
 * prose line. With `boldLabels` false, only the `**Label:**` colon form stays bold. The fenced
 * flags come with the lines, so a caller never scans the fences twice. With
 * `legacyBoldHeadings`, a line that holds only `**Label**` becomes `Label:` before the plain
 * heading path, as an init task was parsed before the heading forms were unified.
 * @param {string} text
 * @param {boolean} [boldLabels]
 * @param {boolean} [legacyBoldHeadings]
 * @returns {{ lines: string[], fenced: boolean[] }}
 */
function normalizedReportLines(text, boldLabels = true, legacyBoldHeadings = false) {
  const lines = boldLabels ? text.split(/\r?\n/) : text.split("\n");
  const fenced = fencedLines(lines);
  const normalized = lines.map((line, index) => {
    const heading = legacyBoldHeadings ? boldHeadingName(line) : null;
    if (heading !== null) {
      return fenced[index] ? `x${line}` : `${heading}:`;
    }
    if (boldLabels && BOLD_LABEL_LINE.test(line)) {
      return isKnownLabelLine(line, fenced[index])
        ? line.replace(BOLD_LABEL_LINE, "$1:$2")
        : `x${line}`;
    }
    // The bold marks around a label name at a line start are invisible to the plain heading path,
    // so an inline name supplies the same prose line as the plain form. The legacy task parse
    // keeps the line as main read it.
    return legacyBoldHeadings ? line : line.replace(BOLD_HEADING_START, "$1");
  });
  const start = conclusionStart(normalized, fenced);
  return { lines: plainHeadingLines(normalized, fenced, start), fenced };
}

/**
 * The index of the last `Conclusion:` line or line that holds only `Conclusion` or only
 * `**Conclusion**`, outside a fence, or the line count when the response holds none. The plain
 * heading form reads from there, so a lone label name in earlier prose stays prose.
 * @param {string[]} lines
 * @param {boolean[]} fenced
 * @returns {number}
 */
function conclusionStart(lines, fenced) {
  let start = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!fenced[i] && CONCLUSION_START_LINE.test(lines[i])) {
      start = i;
    }
  }
  return start;
}

/**
 * Returns the lines from `start` with each column-0 line that holds only a report label name, or
 * only `**Label**`, read as that label, with the non-blank lines under it as its value, joined with
 * a space (issues #1989 and #2020).
 * A line inside a fenced code block stays text. The value stops at a blank line, a list, a Markdown
 * table row, or a label line in any form, so a lone label name with no line under it supplies no
 * value. A line that merely contains a pipe stays part of the value. The line count is kept, so a
 * caller that slices a prefix of the response still measures it.
 * @param {string[]} lines
 * @param {boolean[]} fenced
 * @param {number} start
 * @returns {string[]}
 */
function plainHeadingLines(lines, fenced, start) {
  const out = lines.slice();
  for (let i = start; i < out.length; i++) {
    const name = fenced[i] ? null : reportHeadingName(out[i]);
    if (name === null) {
      continue;
    }
    let end = i + 1;
    const value = [];
    while (end < out.length && !fenced[end] && isHeadingValueLine(out[end], out[end + 1])) {
      value.push(out[end].trim());
      out[end++] = "";
    }
    const label = `${name}:`;
    out[i] = value.length > 0 ? `${label} ${value.join(" ")}` : label;
    i = end - 1;
  }
  return out;
}

/**
 * True when the line under a plain heading label is part of its value: a non-blank line that is
 * neither a list, nor a Markdown table row, nor a label line in any form. A table row stays in the
 * block, so a table under the heading keeps the block unparseable. A line that merely contains a
 * pipe, such as a shell pipeline, is no table row and stays part of the value.
 * @param {string} line
 * @param {string} [next] the line directly below `line`
 * @returns {boolean}
 */
function isHeadingValueLine(line, next) {
  return (
    line.trim() !== "" &&
    !isTableRow(line, next) &&
    !isListLine(line) &&
    !PLAIN_HEADING_LABEL_LINE.test(line) &&
    !readsAsLabelLine(line)
  );
}

/**
 * True when the line belongs to a Markdown table: a delimiter row, or a row directly above one. A
 * line with no pipe is no table row.
 * @param {string} line
 * @param {string} [next] the line directly below `line`
 * @returns {boolean}
 */
function isTableRow(line, next) {
  return (
    isTableDelimiter(line) || (line.includes("|") && next !== undefined && isTableDelimiter(next))
  );
}

// A report label that indentation or markdown decoration hides from the strict
// match, for example `**Deferred**: x`, `*Deferred:* x`, `### Deferred: x`,
// `> Deferred: x`, or `  Deferred: x`. Such a value would otherwise be dropped,
// so the whole block is unparseable and `raw` carries the text.
// The Verdict label is excluded: a malformed verdict already maps to `unknown`
// and never carries report text.
const DECORATED_LABEL_LINE = new RegExp(
  `^(?!(?:${LABEL_NAMES}):)\\s*(?:>\\s*|#{1,6}\\s+|[-*+]\\s*|\\d+[.)]\\s+)*[*_\`]{0,2}(?:${LABEL_NAMES})[*_\`]{0,2}\\s*:`,
  "i",
);

// A dash item or sub-item whose text opens with a bold mark, for example `- **Checks:** ran`, or a
// plain report label name and a colon, for example `- Checks: ran`. When it folds into a label's
// list run, the lead is item text (issues #1006 and #2013). Outside a run, the dropped-list guard
// blanks the block.
const LABEL_DASH_ITEM = new RegExp(`^\\s*- (?:\\*\\*|(?:${LABEL_NAMES}):)`, "i");

// A list line the parser would drop, for example `- item`, `* item`, `1. item`,
// or the same without the space after the marker (`-item`). A run of markers
// alone (`---`), a decimal (`1.5x`), an arrow (`->`), and an ordered marker that
// another list marker follows (`1.-x`, `1.*x`) are not lists: after a bullet
// marker a `>` is rejected, and after an ordered marker a digit or a list marker
// is rejected, so an ordinary sentence that opens this way does not blank the
// block.
const LIST_LINE = /^\s*(?:[-*+](?:\s+\S|[^\s\-*+>])|\d+[.)](?:\s+\S|[^\s\d\-*+]))/;

// A markdown thematic break, for example `* * *` or `- - -`. It matches the
// list pattern but carries no item, so it does not drop text.
const THEMATIC_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

const TABLE_DELIMITER = /^:?-+:?$/;

/**
 * True when the line is a Markdown table delimiter row: cells of only dashes with optional colons,
 * separated by `|`, with or without outer pipes. A line with no `|` is no delimiter row.
 */
function isTableDelimiter(line) {
  if (!line.includes("|")) {
    return false;
  }
  const cells = line.trim().split("|");
  if (cells[0].trim() === "") {
    cells.shift();
  }
  if (cells.at(-1)?.trim() === "") {
    cells.pop();
  }
  return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER.test(cell.trim()));
}

/** True when the block holds a table pair: a line with a `|` and a delimiter row directly below it. */
function hasTablePair(lines) {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes("|") && isTableDelimiter(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

// An emphasis run at line start needs a letter before the closing `*`. Right after the close, no
// word character or `*` follows, and no letter or ASCII digit is glued after that character. A
// leading `*` is also a spaceless bullet marker.
const EMPHASIS_LINE = /^\s*\*(?=\S)[^*]*(?<=\p{L})\*(?![\w*])(?![^\s]*[\p{L}\d])/u;

// A report label name or `Verdict`, in any case, anywhere in the text, followed by optional
// emphasis or code marks and whitespace and then a colon. It has no lead-in condition on purpose:
// every lead-in rule missed another list shape, so the rule is the widest
// one. It holds every label the strict match, DECORATED_LABEL_LINE, or LIST_LINE reads, and it
// also holds a mid-sentence mention such as `the conclusion: none`. That mention fails closed.
const LABEL_MENTION = new RegExp(`(?:${LABEL_OR_VERDICT})[*_\`]{0,2}\\s*:`, "i");

// A label or `Verdict` mention that bars a prose line from introducing a folded list.
// It differs from LABEL_MENTION in one way: any run of emphasis or code marks may follow the name,
// not at most two. A mark before the name needs no rule, because the match has no lead-in condition.
const HEADING_LABEL_MENTION = new RegExp(`(?:${LABEL_OR_VERDICT})[*_\`]*\\s*:`, "i");

/**
 * True when the response holds a closing block attempt: any report label name or `Verdict`
 * followed by a colon, anywhere in the text, or a `Conclusion:` line or line that holds only
 * `Conclusion` or only `**Conclusion**` outside a fence, which starts a plain heading block. The
 * block need not parse. A
 * response without one is plain prose, such as a late answer to an event after the closing block,
 * or fenced output that quotes a label line on its own.
 * @param {string} response
 * @returns {boolean}
 */
export function hasClosingBlockAttempt(response) {
  if (LABEL_MENTION.test(response)) {
    return true;
  }
  const lines = response.split(/\r?\n/);
  const fenced = fencedLines(lines);
  return lines.some((line, index) => !fenced[index] && CONCLUSION_START_LINE.test(line));
}

/**
 * The closing block runs from the last `Conclusion:` line to the end of the response, and is null
 * without that line. A lone required label line or a lone `Verdict:` line above it, with only blank
 * lines between, joins the block. That label must appear once in the
 * response outside a fence, so a quoted or repeated label stays out. The whole response is
 * normalized first, so a bold label starts a block as its plain form does. With `unlabeled`, a
 * response without a `Conclusion:` label takes the non-blank line directly before the first known
 * report label outside a fence as `Conclusion`. When a bold-lead narration paragraph sits there,
 * the nearest plain prose line above becomes `Conclusion`.
 * @param {string} response
 * @param {{ unlabeled?: boolean, boldLabels?: boolean, legacyBoldHeadings?: boolean, diagnose?: boolean, blankFenced?: boolean, includeFencedStart?: boolean }} [options]
 * @returns {string[] | null}
 */
function closingBlock(
  response,
  {
    unlabeled = false,
    boldLabels = true,
    legacyBoldHeadings = false,
    diagnose = false,
    blankFenced = true,
    includeFencedStart = false,
  } = {},
) {
  // A bold label inside a fenced code block stays text.
  const { lines, fenced } = normalizedReportLines(response, boldLabels, legacyBoldHeadings);
  // A `Conclusion:` line inside a fence never starts the block, and a fenced line supplies no label
  // when `blankFenced` holds. The guard scan keeps the origin/main start when
  // `includeFencedStart` holds.
  const blockFrom = (first) =>
    blankFenced ? withoutFencedLines(lines, first, fenced) : lines.slice(first);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((includeFencedStart || !fenced[i]) && /^Conclusion:\s*/i.test(lines[i])) {
      start = i;
    }
  }
  if (start !== -1) {
    return blockFrom(leadingRequiredLabelStart(lines, start, fenced));
  }
  if (!unlabeled) {
    return null;
  }
  const first = lines.findIndex(
    (line, index) => (includeFencedStart || !fenced[index]) && PLAIN_LABEL_LINE.test(line),
  );
  if (first === -1) {
    return null;
  }
  let before = first - 1;
  while (before >= 0 && lines[before].trim() === "") {
    before--;
  }
  if (before < 0 || !isPlainProseLine(lines[before])) {
    const prose = boldNarrationProseLine(lines, before);
    if (prose === -1) {
      // Diagnosis starts at the first known label when no prose line precedes it, so Why still
      // names missing labels.
      return diagnose ? blockFrom(first) : null;
    }
    before = prose;
  }
  const block = blockFrom(before);
  block[0] = `Conclusion: ${proseText(lines[before])}`;
  return block;
}

/**
 * The block lines from `first`, with each fenced line blanked. A fenced line is quoted text, so it
 * never supplies a report label or a list. The blank keeps the line count that
 * `textBeforeBlock` uses.
 * @param {string[]} lines
 * @param {number} first
 * @param {boolean[]} fenced
 * @returns {string[]}
 */
function withoutFencedLines(lines, first, fenced) {
  return lines.slice(first).map((line, index) => (fenced[first + index] ? "" : line));
}

// The required labels a child can write in their own paragraph above `Conclusion:`, for example
// `Blockers:`. The reviewer `Verdict:` line joins that set.
const LEADING_LABEL_LINES = [
  ...REPORT_LABELS.filter(([, , optional]) => !optional).map(([, label]) => [
    label,
    new RegExp(`^${label}:`, "i"),
  ]),
  ["Verdict", /^Verdict:/i],
];

/**
 * The index where the closing block starts: `start`, or the first lone required label or `Verdict:`
 * line above it. Only blank lines lie between that line and the block.
 * A label line inside a fence stays out. A label that another unfenced line repeats stays out too.
 * So a quoted label neither starts nor extends the block. `fenced` reuses the flags of an earlier
 * scan, so a caller that normalized the lines never scans the fences twice.
 * @param {string[]} lines
 * @param {number} start
 * @param {boolean[]} [fenced]
 * @returns {number}
 */
export function leadingRequiredLabelStart(lines, start, fenced = fencedLines(lines)) {
  let first = start;
  for (;;) {
    let at = first - 1;
    while (at >= 0 && lines[at].trim() === "") {
      at--;
    }
    if (at < 0 || fenced[at]) {
      return first;
    }
    const entry = LEADING_LABEL_LINES.find(([, pattern]) => pattern.test(lines[at]));
    if (!entry) {
      return first;
    }
    const [, pattern] = entry;
    const occurrences = lines.filter((line, index) => !fenced[index] && pattern.test(line));
    if (occurrences.length !== 1) {
      return first;
    }
    first = at;
  }
}

// A column-0 line that opens a bold mark, for example `**Blocker.** The test failed`.
const BOLD_LEAD_LINE = /^\*\*/;

/**
 * The index of the plain prose line above a run of bold-lead narration paragraphs and blank lines,
 * or -1 when there is none. A child can write the conclusion as prose, then bold-lead paragraphs,
 * then the report labels with no `Conclusion:` line.
 * @param {string[]} lines
 * @param {number} from the non-blank line directly above the first known label
 * @returns {number}
 */
function boldNarrationProseLine(lines, from) {
  let at = from;
  while (at >= 0) {
    if (lines[at].trim() === "") {
      at--;
      continue;
    }
    if (isPlainProseLine(lines[at])) {
      return at;
    }
    if (BOLD_LEAD_LINE.test(lines[at])) {
      at--;
      continue;
    }
    return -1;
  }
  return -1;
}

/**
 * The closing block with the parser's list folding applied, plus the value each report label reads
 * there. It is null when no closing block attempt exists. `parseReportBlock` and the missing-label
 * diagnosis share this step. A label is present exactly when the parser's label scan reads a value
 * for it.
 * @param {string} response
 * @param {{ boldLabels?: boolean, legacyBoldHeadings?: boolean, diagnose?: boolean }} [options]
 * @returns {{ block: string[], lines: string[] | null, labels: Array<{ key: string, label: string, optional: boolean, value: string | null }>, masked: Map<string, string> } | null}
 */
function foldedReportBlock(
  response,
  { boldLabels = true, legacyBoldHeadings = false, diagnose = false } = {},
) {
  const block = closingBlock(response, {
    unlabeled: true,
    boldLabels,
    legacyBoldHeadings,
    diagnose,
  });
  if (!block) {
    return null;
  }
  const folded = foldEmptyLabelLists(block);
  const lines = folded?.lines ?? null;
  const labels = REPORT_LABELS.map(([key, label, optional]) => {
    const value = lastLabeled(lines ?? block, label)?.value ?? "";
    return { key, label, optional, value: value === "" ? null : value };
  });
  return { block, lines, labels, masked: folded?.masked ?? new Map() };
}

/**
 * The closing block of `response` as report values, or null when the block does not parse.
 * @param {string} response
 * @param {{ boldLabels?: boolean }} [options]
 * @returns {{ report: object } | null}
 */
function reportDetail(response, { boldLabels = true } = {}) {
  const shared = foldedReportBlock(response, { boldLabels });
  if (!shared) {
    return null;
  }
  const { block, lines, labels } = shared;
  if (block.some((line) => DECORATED_LABEL_LINE.test(line) && !LABEL_DASH_ITEM.test(line))) {
    return null;
  }
  // The fold consumes a table under a folded item or a new section, so the table guard reads the
  // block first. ADR 0167 keeps a block that holds a table pair unparseable. The fold still runs,
  // so the missing-label and copied-task diagnostics keep every other label's value.
  if (hasTablePair(block)) {
    return null;
  }
  if (
    !lines ||
    lines.some((line) => DECORATED_LABEL_LINE.test(line)) ||
    hasDroppedList(lines) ||
    hasTablePair(lines)
  ) {
    return null;
  }
  const report = {};
  for (const { key, optional, value } of labels) {
    if (!value) {
      if (optional) {
        report[key] = null;
        continue;
      }
      return null;
    }
    report[key] = value;
  }
  return { report };
}

/**
 * Extracts the closing block as `{ conclusion, why, blockers, checks, notes, deferred }`, or null when
 * the block does not parse. Each label is matched case-insensitively at line start inside the block
 * only, and the last occurrence wins. `conclusion`, `why`, and `blockers` are required, while an
 * absent or empty optional label maps to null. A `- ` or `N. ` list under a label or after one
 * blank line joins the value with "; ", except a blank-line ordered Verdict line. Every nesting level
 * folds a `- ` or `N. ` sub-item at its parent text column with ", ". Any other list line, table
 * pair, or hidden or decorated label is unparseable, except a dash list under plain prose or a
 * whole-line bold heading.
 * @param {string} response
 * @param {{ boldLabels?: boolean }} [options]
 * @returns {{ conclusion: string, why: string, blockers: string, checks: string | null, notes: string | null, deferred: string | null } | null}
 */
export function parseReportBlock(response, { boldLabels = true } = {}) {
  return reportDetail(response, { boldLabels })?.report ?? null;
}

// A pointer to earlier response text, anchored to a short pattern list. A noun phrase counts only
// when `above` ends it, so a comparison such as `above target`, `above the limit`, or `above 80 %`
// stays out. The detection is a heuristic: a pointer that the list misses stays undetected.
const ABOVE_NOUN_POINTER =
  /\b(?:the|this|that|these|those)\s+(?:[\p{L}\p{N}`*_-]+\s+){0,4}above(?=\s*(?:$|[.,;:!?)}\]—–]))/iu;
const ABOVE_VERB_POINTER =
  /\b(?:see|as|stated|described|shown|explained|listed|noted|given|written)\s+(?:it\s+)?above\b/iu;
const CLOSING_BLOCK_POINTER = /\b(?:above|before|earlier in)\s+(?:the\s+)?closing\s+block\b/iu;

// A value that names a report label or `Verdict` points inside the same block.
const NAMED_LABEL_POINTER = new RegExp(`\\b(?:${LABEL_OR_VERDICT})\\b`, "i");

const BLOCKQUOTE_LINE = /^\s{0,3}>/;
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;

/** True when `value` points at response text outside the closing block. */
function pointsOutsideBlock(value) {
  if (typeof value !== "string" || NAMED_LABEL_POINTER.test(value)) {
    return false;
  }
  return [ABOVE_NOUN_POINTER, ABOVE_VERB_POINTER, CLOSING_BLOCK_POINTER].some((pattern) =>
    pattern.test(value),
  );
}

/** True when `text` holds a quoted passage: a blockquote line or a fenced code block. */
function hasQuotedText(text) {
  return text.split(/\r?\n/).some((line) => BLOCKQUOTE_LINE.test(line) || FENCE_LINE.test(line));
}

/** The number of non-empty paragraphs in `text`, separated by blank lines. */
function paragraphCount(text) {
  return text.split(/\r?\n[ \t]*\r?\n/).filter((part) => part.trim() !== "").length;
}

/** The response text before the closing block, or the empty string when there is none. */
function textBeforeBlock(response, block = closingBlock(response, { unlabeled: true })) {
  if (!block) {
    return "";
  }
  const { lines } = normalizedReportLines(response);
  return lines.slice(0, lines.length - block.length).join("\n");
}

/**
 * The report label names whose value points at response text outside the closing block, in report
 * order, for example `["Why"]`. The detection is a heuristic over a small pattern list: a noun
 * phrase whose `above` ends it, a verb before `above`, or a closing-block reference. A word after
 * `above` reads as a comparison and stays out, and a value that names a report label stays inside
 * the block. The check reads one text per label: the folded value with each item's own lead left
 * out, built as diagnostic text for this check. Its separators and lead markup can differ from the
 * folded value, so it is no copy of the value. A label name that starts a dash item is item text
 * rather than a reference, at any nesting depth, while a name inside prose or another item's text
 * stays a reference and keeps the whole value internal, as main does.
 * The exception returns no label when `exception` is true and exactly one label points outside the
 * block, with quoted text or two paragraphs before it. Quoted text is a blockquote line or a fenced
 * code block. A reviewer turn passes `exception: false`, because its prompt bars every reference to
 * text outside the block.
 * @param {string} response
 * @param {ReturnType<typeof parseReportBlock>} report
 * @param {{ exception?: boolean }} [options]
 * @returns {string[]}
 */
export function outsideBlockReportLabels(response, report, { exception = true } = {}) {
  if (!report) {
    return [];
  }
  const folded = foldedReportBlock(response);
  const block = folded?.block ?? null;
  const masked = folded?.masked ?? new Map();
  const labels = REPORT_LABELS.filter(([key]) =>
    pointsOutsideBlock(masked.get(key) ?? report[key]),
  ).map(([, label]) => label);
  if (labels.length === 0) {
    return [];
  }
  const before = textBeforeBlock(response, block);
  if (before.trim() === "") {
    return [];
  }
  if (labels.length > 1 || !exception) {
    return labels;
  }
  return hasQuotedText(before) || paragraphCount(before) >= 2 ? [] : labels;
}

// A task value that a correct report can also hold, so it names no copied label.
const NON_SPECIFIC_VALUE = /^(?:none|n\/a)\.?$/i;

/**
 * The report label names whose value equals the value of the same label in the init task, in report
 * order, for example `["Conclusion"]`. The task label values come from the diagnostic fold that
 * `missingRequiredReportLabels` uses, so a partial task block supplies the values it holds. The task
 * text reads a bold heading as a label line, as it did before the heading forms were unified, so a
 * task keeps its values whatever heading form a response uses. A fenced task line supplies no
 * value. A task value of `none` or `n/a` names no label, because a correct report can hold it.
 * The detection is a heuristic: an exact match names the label, and a value under another label
 * stays out.
 * @param {ReturnType<typeof parseReportBlock>} report
 * @param {string | null | undefined} task
 * @returns {string[]}
 */
export function copiedTaskReportLabels(report, task) {
  if (!report || typeof task !== "string") {
    return [];
  }
  const taskValues = new Map(
    (foldedReportBlock(task, { diagnose: true, legacyBoldHeadings: true })?.labels ?? []).map(
      ({ key, value }) => [key, value],
    ),
  );
  return REPORT_LABELS.filter(([key]) => {
    const value = report[key];
    const taskValue = taskValues.get(key);
    if (typeof value !== "string" || typeof taskValue !== "string") {
      return false;
    }
    const copied = value.trim();
    return copied !== "" && !NON_SPECIFIC_VALUE.test(copied) && copied === taskValue.trim();
  }).map(([, label]) => label);
}

/**
 * Every required label that a null report lacks, in report order: `Conclusion`, `Why`, then
 * `Blockers`. The list is empty when every required label is present or no closing block attempt
 * exists. A structural failure never hides a label that is absent.
 * @param {string} response
 * @returns {string[]}
 */
export function missingRequiredReportLabels(response) {
  const shared = foldedReportBlock(response, { diagnose: true });
  if (!shared) {
    return [];
  }
  return shared.labels
    .filter(({ optional, value }) => !optional && value === null)
    .map(({ label }) => label);
}

/**
 * True when `response` parses only because bold report labels were normalized. A response that
 * also parses without bold labels is not bold-dependent. `parsed` is the already-read bold form.
 * @param {string} response
 * @param {ReturnType<typeof parseReportBlock>} [parsed]
 * @returns {boolean}
 */
export function parsesOnlyWithBoldLabels(response, parsed = parseReportBlock(response)) {
  return parsed !== null && parseReportBlock(response, { boldLabels: false }) === null;
}

/**
 * The report for one child result. A multi-part unidentified OpenCode report that parses only
 * through bold normalization is null. The first parse passes through, so a multi-part response
 * parses at most twice.
 * @param {string} response
 * @param {boolean} [multiPartUnidentified]
 * @returns {ReturnType<typeof parseReportBlock>}
 */
export function reportForResult(response, multiPartUnidentified = false) {
  const report = parseReportBlock(response);
  if (!multiPartUnidentified || report === null) {
    return report;
  }
  return parsesOnlyWithBoldLabels(response, report) ? null : report;
}

// A repaired value that carries no finding, for a label that the original response left out.
const NO_REPAIRED_FINDING = /^none\.?$/i;

// The label line of the closing block, after bold-label normalization.
const REPORT_LABEL_LINE = new RegExp(`^(${LABEL_NAMES}):\\s*(.*)$`, "i");
const LABEL_KEY_BY_NAME = new Map(REPORT_LABELS.map(([key, label]) => [label.toLowerCase(), key]));

// The list markers that a repair may convert: a dash, star, or plus bullet, or an ordered marker.
const LIST_MARKER_PREFIX = /^\s*(?:[-*+](?:\s+|(?=\S))|\d+[.)](?:\s+|(?=\S)))/;

/** The word and number content of a value, so list markers, separators, and line breaks do not decide a match. */
function reportContentTokens(value) {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The text of a list line without its marker, or the line unchanged when it is no list. */
function withoutListMarker(line) {
  return isListLine(line) ? line.replace(LIST_MARKER_PREFIX, "") : line;
}

/**
 * The normalized content of each report label in `response`, from the last occurrence of the label
 * to the next known label. Every line under the label contributes, so a `*` list or a wrapped line
 * that the parser does not fold still counts as content. `named` holds every label that a line names,
 * so a label line with no content stays apart from a label that the response omits. `holds` holds
 * every label with a parsed value or a word in the content scan, so a dash value counts as held and
 * a list the parser drops still counts by its words. `perLabel` is true only when the parser
 * returns per-label values; a failed fold reads the raw block and keeps the inherited comparison.
 * @param {string} response
 * @returns {{ sections: Map<string, string[]>, named: Set<string>, holds: Set<string>, perLabel: boolean } | null}
 */
function originalLabelTokens(response) {
  const shared = foldedReportBlock(response, { diagnose: true });
  if (!shared) {
    return null;
  }
  const { block, labels, lines } = shared;
  const sections = new Map();
  const named = new Set();
  let current = null;
  for (const line of block) {
    const match = line.match(REPORT_LABEL_LINE);
    if (match) {
      current = LABEL_KEY_BY_NAME.get(match[1].toLowerCase()) ?? null;
      if (current !== null) {
        sections.set(current, reportContentTokens(match[2]));
        named.add(current);
      }
      continue;
    }
    if (isKnownLabelLine(line)) {
      current = null;
      continue;
    }
    if (current !== null) {
      sections.get(current).push(...reportContentTokens(withoutListMarker(line)));
    }
  }
  // The parsed label value decides a wordless value: a dash, inline or folded from a list, is a
  // value the original holds. The content scan still marks a label whose words the parser drops,
  // such as a star-list finding, so the inherited comparison stays unchanged for that shape.
  const parsedValue = new Map(labels.map(({ key, value }) => [key, value]));
  const holds = new Set(
    REPORT_LABELS.map(([key]) => key).filter(
      (key) => parsedValue.get(key) !== null || (sections.get(key)?.length ?? 0) > 0,
    ),
  );
  return { sections, named, holds, perLabel: lines !== null };
}

/** True when both lists hold the same words in the same order. */
function sameTokens(left, right) {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

// Maintainer triage: keep a parser fix for a regression, a dropped finding, or an incorrect
// acceptance. Leave an unsupported format uncovered until the repair ships, and keep a repeated
// repair failure actionable.

/**
 * True when a repaired report restates only what the original response already held.
 * The repair is untrusted: each label keeps the normalized content of the original, whatever list
 * form it used, and a reviewer verdict must match an explicit original verdict. A label line that
 * the original wrote with no value is empty, not absent, so the repair must leave it empty. A label
 * that the original omits may gain only a `none` finding, whose sole word is `none` in any case. A
 * dash value is a value the original holds, so it keeps the same comparison as any other held
 * value. The empty-label rule applies only when the parser returns per-label values for the
 * original block. When the fold fails and the parser reads the raw block, the inherited comparison
 * alone applies, with no added-value check. A word that the repair adds, drops, or moves between
 * labels leaves the repair unused, so a repair can never create an acceptance that the original
 * response did not state (issue #2015).
 * @param {string} response the original child response
 * @param {string} repairedResponse the repair turn response
 * @param {ReturnType<typeof parseReportBlock>} report the parsed repaired report
 * @param {{ reviewer?: boolean }} [options]
 * @returns {boolean}
 */
export function repairedReportMatches(
  response,
  repairedResponse,
  report,
  { reviewer = false } = {},
) {
  if (!report) {
    return false;
  }
  const original = originalLabelTokens(response);
  if (original === null) {
    return false;
  }
  const { sections: originals, named, holds, perLabel } = original;
  for (const [key] of REPORT_LABELS) {
    const originalTokens = originals.get(key) ?? [];
    const repaired = reportContentTokens(report[key] ?? "");
    if (perLabel && !holds.has(key)) {
      // The parser returned per-label values, and the original left this label empty or omitted, so
      // any value is an addition, a lone dash included. An empty line stays empty; a label that no
      // line names may gain only a `none` finding, whose sole word is `none` in any case.
      const repairedValue = report[key];
      if (repairedValue === null) {
        continue;
      }
      if (named.has(key)) {
        return false;
      }
      if (!(repaired.length === 1 && NO_REPAIRED_FINDING.test(repaired[0]))) {
        return false;
      }
      continue;
    }
    // The inherited comparison. It applies to every held label, and to every label when the fold
    // failed and the parser read the raw block.
    if (originalTokens.length === 0) {
      if (
        repaired.length > 0 &&
        !(repaired.length === 1 && NO_REPAIRED_FINDING.test(repaired[0]))
      ) {
        return false;
      }
      continue;
    }
    if (!sameTokens(originalTokens, repaired)) {
      return false;
    }
  }
  if (reviewer) {
    const originalVerdict = parseVerdict(response);
    if (originalVerdict !== "accept" && originalVerdict !== "reject") {
      return false;
    }
    const repairedVerdict = parseVerdict(repairedResponse);
    if (repairedVerdict !== originalVerdict) {
      return false;
    }
    // An accept needs the same evidence that the gate reads. A repair cannot supply a label or a
    // Checks line that the original response left out or left empty.
    if (
      repairedVerdict === "accept" &&
      REPORT_LABELS.some(
        ([labelKey, , optional]) => !optional && (originals.get(labelKey)?.length ?? 0) === 0,
      )
    ) {
      return false;
    }
    if (repairedVerdict === "accept" && (originals.get("checks")?.length ?? 0) === 0) {
      return false;
    }
  }
  return true;
}

// The list shapes that fold under a label: a `-` or an ordered `N.` marker at column 0, exactly
// one ASCII space (U+0020), then an item. Any other separator
// (a tab, a nonbreaking space, a second space), a spaceless bullet, an indented bullet, a `*` or
// `+` bullet, and an `N)` item stay lists that hasDroppedList rejects.
const FOLDABLE_ITEM = /^(?:- |\d+\. )(?=\S)/;

// The item shape that folds under a prose heading: a dash item only. An ordered item
// there stays a list that hasDroppedList rejects.
const HEADING_ITEM = /^- (?=\S)/;

// The nesting levels that fold into their parent item.
// A sub-item line holds ASCII spaces up to the parent item text column.
// Then come a `-` or `N. ` marker, one ASCII space, and the item.
// The indent is the parent text column: `- ` takes two spaces, `1. a` three, and `10. a` four.
// Another indent width and a tab stay lists that hasDroppedList rejects.
const foldableSubitem = (marker) => new RegExp(`^ {${marker.length}}(?:- |\\d+\\. )(?=\\S)`);

// An ordered sub-item at the parent text column, with exactly one ASCII space after its marker.
const orderedSubitem = (marker) => new RegExp(`^ {${marker.length}}\\d+\\. (?=\\S)`);

const LABEL_WORD_THEN_SEPARATOR = new RegExp(
  `^[^\\p{L}\\p{N}]*(?:\\p{N}+[^\\p{L}\\p{N}]*)?(?:${LABEL_OR_VERDICT})\\s*[^\\p{L}\\p{N}\\s]`,
  "iu",
);

/**
 * True when the line reads as a report label or `Verdict` line under any markup or separator. After
 * NFKC normalization it skips every leading character that is no letter or digit, such as quote,
 * heading, list, and emphasis marks, in any count. It then skips one optional number. It holds a
 * label name or `Verdict`, any case, optional whitespace, and a character that is no letter, digit,
 * or whitespace. Every colon variant (`:`, `：`, `∶`) and every other separator therefore matches,
 * and the check names no markup or separator shape. A label word that a letter, digit, or
 * whitespace-then-letter follows (`Notes about x`, `Why this matters:`) is prose and does not match.
 */
function readsAsLabelLine(line) {
  return LABEL_WORD_THEN_SEPARATOR.test(line.normalize("NFKC"));
}

const VERDICT_WORD_THEN_SEPARATOR = new RegExp(
  `^[^\\p{L}\\p{N}]*(?:\\p{N}+[^\\p{L}\\p{N}]*)?Verdict\\s*[^\\p{L}\\p{N}\\s]`,
  "iu",
);

/**
 * True when the line reads as a `Verdict` line under any markup or separator. After NFKC
 * normalization it skips leading non-letter, non-digit characters and one optional number. It then
 * holds `Verdict`, any case, optional whitespace, and a character that is no letter, digit, or
 * whitespace. An ordered sub-item never folds it into item text.
 */
function readsAsVerdictLine(line) {
  return VERDICT_WORD_THEN_SEPARATOR.test(line.normalize("NFKC"));
}

/** True when the line is a list item. A thematic break and an emphasis run are not lists. */
function isListLine(line) {
  return LIST_LINE.test(line) && !THEMATIC_BREAK.test(line) && !EMPHASIS_LINE.test(line);
}

/** True when the line is an item that matches `pattern` and may fold into a label's value. */
function isFoldableItem(line, pattern) {
  return pattern.test(line) && isListLine(line);
}

/** True when the line is a `- ` or `N. ` sub-item at the parent text column, unless an ordered item reads as a Verdict line. */
function isFoldableSubitem(line, marker) {
  // An ordered sub-item that reads as a Verdict line never folds, so a rejection stays visible.
  // A dash sub-item folds.
  const hiddenVerdict = orderedSubitem(marker).test(line) && readsAsVerdictLine(line);
  return foldableSubitem(marker).test(line) && isListLine(line) && !hiddenVerdict;
}

/**
 * True when the line is an indented prose line that continues the item above: ASCII
 * spaces or tabs, then text that is neither a list, a thematic break, nor a report label or
 * `Verdict` line. An indented list line or label line is no continuation and keeps its earlier
 * outcome: hasDroppedList refuses the list, and the label line never folds into an item.
 */
function isContinuationLine(line) {
  return (
    /^[ \t]+\S/.test(line) &&
    !isListLine(line) &&
    !THEMATIC_BREAK.test(line) &&
    !readsAsLabelLine(line)
  );
}

// The lead of a dash or ordered item, plain or bold, for example `Checks:` or `**Checks:**`.
const ITEM_LEAD = new RegExp(`^(?:\\*\\*)?(?:${LABEL_NAMES})(?:\\*\\*)?:`, "i");

/**
 * The text of an item with its own report label lead left out, for the diagnostic outside-block
 * text. Its separators and lead markup can differ from the folded value.
 */
function withoutItemLead(text) {
  return text.replace(ITEM_LEAD, "");
}

/**
 * The text of the item at `start` and of its direct sub-items at every deeper level, joined with
 * ", ", and the last line used. `marker` is the full marker prefix of the parent line, so its
 * length is the column where the sub-item marker starts. `masked` is the same text with the lead
 * of each part left out, for the diagnostic outside-block text; its separators and lead markup can
 * differ from the folded value.
 */
function takeSubitems(lines, start, marker) {
  const [subMarker] = lines[start].match(foldableSubitem(marker));
  const text = lines[start].slice(subMarker.length).trim();
  const parts = [text];
  const masked = [withoutItemLead(text)];
  let i = start;
  while (i + 1 < lines.length && isFoldableSubitem(lines[i + 1], subMarker)) {
    const nested = takeSubitems(lines, i + 1, subMarker);
    parts.push(nested.text);
    masked.push(nested.masked);
    i = nested.end;
  }
  return { text: parts.join(", "), masked: masked.join(", "), end: i };
}

/**
 * The items that match `pattern` and directly follow line `start`, and the last line used. Each
 * item absorbs its sub-items at every deeper level, joined with ", ". The continuation lines after
 * them join with a space, like a Markdown lazy continuation.
 */
function takeItems(lines, start, pattern, { refuseOrderedVerdict = false } = {}) {
  let i = start;
  const items = [];
  const masked = [];
  while (i + 1 < lines.length && isFoldableItem(lines[i + 1], pattern)) {
    if (refuseOrderedVerdict && isOrderedVerdictItem(lines[i + 1])) {
      break;
    }
    const [marker] = lines[++i].match(pattern);
    const text = lines[i].slice(marker.length).trim();
    const parts = [text];
    const maskedParts = [withoutItemLead(text)];
    while (i + 1 < lines.length && isFoldableSubitem(lines[i + 1], marker)) {
      const nested = takeSubitems(lines, i + 1, marker);
      parts.push(nested.text);
      maskedParts.push(nested.masked);
      i = nested.end;
    }
    const continuation = [];
    while (i + 1 < lines.length && isContinuationLine(lines[i + 1])) {
      const next = lines[++i].trim();
      continuation.push(next);
      // A continuation joins the part it continues, with the space the fold uses, so a wrapped
      // sentence reaches one check rather than two (issue #2014 review).
      maskedParts[maskedParts.length - 1] += ` ${next}`;
    }
    items.push([parts.join(", "), ...continuation].join(" "));
    masked.push(maskedParts.join(", "));
  }
  return { items, masked: masked.join("; "), end: i };
}

/** True when the line is a column-0 ordered item that reads as a Verdict line. */
function isOrderedVerdictItem(line) {
  return /^\d+\. /.test(line) && readsAsVerdictLine(line);
}

/** Appends text to a label line's value, joined with "; " when the line already holds a value. */
function appendToLabel(label, text) {
  const hasValue = label.slice(label.indexOf(":") + 1).trim() !== "";
  return `${label}${hasValue ? "; " : " "}${text}`;
}

/**
 * The report label name of a column-0 heading line, plain or bold, or null when the line holds no
 * heading. Only the six report labels gain this form. An adapter that splits or joins response text
 * uses it, so both heading forms split alike.
 * @param {string} line
 * @returns {string | null}
 */
export function reportHeadingName(line) {
  const match = line.match(PLAIN_HEADING_LABEL_LINE);
  return match ? (match[1] ?? match[2]) : null;
}

/** The label name of a column-0 line that holds only `**Label**`, or null for any other line. */
function boldHeadingName(line) {
  return line.match(PLAIN_HEADING_LABEL_LINE)?.[2] ?? null;
}

/**
 * The text that a report line supplies as prose: the label name of a column-0 heading line, plain
 * or bold, so both forms supply the same value, and otherwise the trimmed line.
 */
function proseText(line) {
  return reportHeadingName(line) ?? line.trim();
}

/**
 * A plain prose line that may introduce a folded list: its first character is not
 * whitespace, `*`, `_`, a backtick, `>`, or `#`, is not a list, and names no report label or
 * `Verdict` followed by any run of marks, optional whitespace, and a colon anywhere. A malformed or decorated label, a `Verdict` line, and a
 * `*` line therefore never supply a field value. A column-0 heading line, plain or bold, is the
 * lone label name, so it supplies prose here as the plain form does.
 */
function isPlainProseLine(line) {
  if (reportHeadingName(line) !== null) {
    return true;
  }
  return /^[^\s*_`>#]/.test(line) && !isListLine(line) && !HEADING_LABEL_MENTION.test(line);
}

const BOLD_PROSE_LINE = /^\*\*[^*]+\*\*$/;

/**
 * True when the line is a whole-line bold prose heading that can introduce a folded list.
 * Examples are `**Reviewer notes.**`. The bold must wrap the whole line, so a `*` bullet and
 * a `**bold** note` line with trailing text stay out.
 */
function isBoldProseLine(line) {
  return BOLD_PROSE_LINE.test(line) && !isListLine(line) && !HEADING_LABEL_MENTION.test(line);
}

function trimTrailingBlanks(out) {
  while (out.length > 0 && out.at(-1).trim() === "") {
    out.pop();
  }
}

/**
 * Folds each section under a report label line into that label's value. A section is a bare dash
 * run, or a prose lead with its `- ` run, and exactly one blank line comes before each.
 * A prose lead follows the prose-lead rules, the whole-line bold heading included.
 * Markers drop, and sections join each other and an existing value with a semicolon and a space.
 * Each item absorbs the `- ` or `N. ` sub-items right after it, joined with ", ".
 * Null when the guards below reject a label in `sectioned` or a folded label appears again. A table
 * pair is no concern of this fold, because the caller refuses it before it reads this result.
 * `masked` holds, per label, one text for the outside-block check: the folded value with each
 * item's own lead left out, built as diagnostic text. Its separators and lead markup can differ
 * from the folded value, so it is no copy of the value. A continuation line stays in the item text
 * it continues.
 * @param {string[]} lines
 * @returns {{ lines: string[], masked: Map<string, string> } | null}
 */
function foldEmptyLabelLists(lines) {
  const out = [];
  const folded = [];
  // Labels that took a section fold, labels past the general rule, and labels that broke it.
  // `sectioned` gains a label from the `extra` dash loop, the bare-dash branch, or
  // `foldedAfterBlank`.
  const sectioned = new Set();
  const nonCanonical = new Set();
  const invalid = new Set();
  // The outside-block text of each label: the folded value with each item's own lead left out,
  // built as diagnostic text. Its separators and lead markup can differ from the folded value, so
  // it is no copy of the value. A later occurrence of a label replaces the earlier one.
  const masked = new Map();
  const labelKey = (labelText) =>
    LABEL_KEY_BY_NAME.get(labelText.slice(0, labelText.indexOf(":")).trim().toLowerCase()) ?? null;
  const appendMasked = (text, addition) => `${text}${text.trim() === "" ? " " : "; "}${addition}`;
  const addMasked = (labelText, addition) => {
    const key = labelKey(labelText);
    if (key !== null) {
      masked.set(key, appendMasked(masked.get(key) ?? "", addition));
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PLAIN_LABEL_LINE.test(line)) {
      const inlineKey = labelKey(line);
      if (inlineKey !== null) {
        masked.set(inlineKey, line.slice(line.indexOf(":") + 1).trim());
      }
      let { items, masked: itemMasked, end } = takeItems(lines, i, FOLDABLE_ITEM);
      if (items.length === 0 && lines[i + 1]?.trim() === "") {
        // One blank line then a dash or ordered run under the same label folds too.
        // Two blank lines and every other list shape stay for hasDroppedList.
        // A blank-line ordered item that reads as a Verdict line stays unparseable.
        ({
          items,
          masked: itemMasked,
          end,
        } = takeItems(lines, i + 1, FOLDABLE_ITEM, {
          refuseOrderedVerdict: true,
        }));
      }
      let extra = false;
      // Any number of bare dash sections, each after exactly one blank line (issue #2005).
      while (items.length > 0 && lines[end + 1]?.trim() === "") {
        const next = takeItems(lines, end + 1, HEADING_ITEM);
        if (next.items.length === 0) {
          break;
        }
        items.push(...next.items);
        itemMasked = appendMasked(itemMasked, next.masked);
        end = next.end;
        extra = true;
      }
      if (items.length > 0) {
        const label = line.trim();
        folded.push({ label: label.slice(0, label.indexOf(":")), index: out.length });
        if (extra) {
          sectioned.add(out.length);
        }
        addMasked(label, itemMasked);
        out.push(appendToLabel(label, items.join("; ")));
        i = end;
        continue;
      }
    } else if (
      (isPlainProseLine(line) || isBoldProseLine(line)) &&
      out.length > 0 &&
      out.at(-1).trim() === ""
    ) {
      const at = out.findLastIndex((entry) => entry.trim() !== "");
      const oneBlankBefore = i >= 2 && lines[i - 1]?.trim() === "" && lines[i - 2]?.trim() !== "";
      let { items, masked: itemMasked, end } = takeItems(lines, i, HEADING_ITEM);
      let foldedAfterBlank = false;
      if (
        items.length === 0 &&
        isPlainProseLine(line) &&
        oneBlankBefore &&
        lines[i + 1]?.trim() === "" &&
        !nonCanonical.has(at)
      ) {
        // Exactly one blank line before the prose and one before its dash list folds (issue #2005).
        // The fold consumes both blanks, so a later section needs its own blank line.
        ({ items, masked: itemMasked, end } = takeItems(lines, i + 1, HEADING_ITEM));
        foldedAfterBlank = items.length > 0;
      }
      if (items.length > 0 && at >= 0 && PLAIN_LABEL_LINE.test(out[at])) {
        // Adds the label to `invalid` when it is `sectioned` and `oneBlankBefore` is false.
        if (sectioned.has(at) && !oneBlankBefore) {
          invalid.add(at);
        }
        if (!oneBlankBefore) {
          nonCanonical.add(at);
        }
        folded.push({ label: out[at].slice(0, out[at].indexOf(":")), index: at });
        addMasked(out[at], `${proseText(line).replace(/:$/, "")}: ${itemMasked}`);
        out[at] = appendToLabel(
          out[at],
          `${proseText(line).replace(/:$/, "")}: ${items.join("; ")}`,
        );
        if (foldedAfterBlank) {
          sectioned.add(at);
          trimTrailingBlanks(out);
        }
        i = end;
        continue;
      }
    } else if (
      isFoldableItem(line, HEADING_ITEM) &&
      i >= 2 &&
      lines[i - 1]?.trim() === "" &&
      lines[i - 2]?.trim() !== ""
    ) {
      // A bare dash section after a preceding section, with exactly one blank line before it.
      const at = out.findLastIndex((entry) => entry.trim() !== "");
      if (at >= 0 && PLAIN_LABEL_LINE.test(out[at]) && !nonCanonical.has(at)) {
        const { items, masked: itemMasked, end } = takeItems(lines, i - 1, HEADING_ITEM);
        if (items.length > 0) {
          folded.push({ label: out[at].slice(0, out[at].indexOf(":")), index: at });
          sectioned.add(at);
          addMasked(out[at], itemMasked);
          out[at] = appendToLabel(out[at], items.join("; "));
          trimTrailingBlanks(out);
          i = end;
          continue;
        }
      }
    }
    out.push(line);
  }
  // A sectioned label holds only its value line, blanks, and later label lines.
  // The scan stops at the `isKnownLabelLine` break, the non-blank line that adds the label to
  // `invalid`, or the end of `out`.
  // Null when the scan adds a label in `sectioned` to `invalid`.
  for (const at of sectioned) {
    for (let j = at + 1; j < out.length; j++) {
      if (isKnownLabelLine(out[j])) {
        break;
      }
      if (out[j].trim() !== "") {
        invalid.add(at);
        break;
      }
    }
  }
  // Null when `invalid` is not empty. Every block that parsed at ffaf28d0 keeps its values, except
  // a table pair, which the caller refuses before it reads this result.
  if (invalid.size > 0) {
    return null;
  }
  // Null when a folded label's `lastLabeled` index differs from its fold index.
  return folded.every(({ label, index }) => lastLabeled(out, label).index === index)
    ? { lines: out, masked }
    : null;
}

/**
 * True when the block holds a list line the parser would drop. A label holds
 * one line, so a list anywhere in the block that foldEmptyLabelLists left is
 * dropped, including under an earlier occurrence of a label that a later
 * occurrence shadows and after the reviewer `Verdict:` line.
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasDroppedList(lines) {
  return lines.some(isListLine);
}

/**
 * Extracts the reviewer verdict from a `Verdict:` line inside the closing block. The verdict word
 * alone, or the word closed by an optional sentence period, maps to that word. A punctuation
 * separator, whitespace, and a clause after the word also map to that word. A clause that names
 * either verdict maps to `unknown`, because it does not state one verdict. A verdict outside the
 * block, a missing line, or a malformed line maps to `unknown`, and process success never implies
 * acceptance. A `Verdict:` line inside a fenced code block supplies no verdict.
 * @param {string} response
 * @returns {"accept" | "reject" | "unknown"}
 */
export function parseVerdict(response) {
  return verdictFrom(closingBlock(response));
}

/**
 * The verdict for the OpenCode split-message guard. It keeps the origin/main block start, fenced
 * lines included, so every stream that a split refused still refuses. It never
 * supplies a report or a gate.
 * @param {string} response
 * @returns {"accept" | "reject" | "unknown"}
 */
export function guardVerdict(response) {
  return verdictFrom(closingBlock(response, { blankFenced: false, includeFencedStart: true }));
}

/** The verdict word of a closing block, or `unknown` when the block holds no clear verdict. */
function verdictFrom(block) {
  const line = block ? (lastLabeled(block, "Verdict")?.value ?? null) : null;
  const value = line ? line.replace(/\.$/, "") : null;
  const match = value ? value.match(/^(accept|reject)(?:\s*[—–:,.-]\s+(.*))?$/i) : null;
  if (!match) {
    return "unknown";
  }
  if (match[2] && /\b(accept|reject)\b/i.test(match[2])) {
    return "unknown";
  }
  return match[1].toLowerCase();
}

/** Last line in `lines` that opens `label`, with its value and index. */
function lastLabeled(lines, label) {
  const pattern = LABEL_PATTERN_BY_KEY.get(label.toLowerCase());
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (match) {
      found = { value: match[1].trim(), index: i };
    }
  }
  return found;
}

/**
 * The first failing acceptance check, "verdict" or "checks", or null when the review is accepted.
 * An accept counts only with a Checks line in the closing block. That matches the parent rule the
 * prompt states and the interactive --require-accept gate. An accept without a
 * Checks line is treated as not accepted.
 * The optional stored report is the one the turn result carries, so a fail-closed null is kept.
 * @param {string} response
 * @param {ReturnType<typeof parseReportBlock>} [report]
 * @returns {"verdict" | "checks" | null}
 */
export function acceptanceFailure(response, report = parseReportBlock(response)) {
  if (parseVerdict(response) !== "accept") {
    return "verdict";
  }
  return report?.checks ? null : "checks";
}
