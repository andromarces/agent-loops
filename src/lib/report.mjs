// Parses the closing block that reportBlock (src/prompts/rules.mjs) requires
// from every child turn, plus the reviewer Verdict line. Both parse only the
// final block. It starts at the last `Conclusion:` line, or at a lone required
// label or `Verdict:` line directly above that line (issues #1592 and #1793).
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

// Compiles each label pattern once, so a parse never compiles one per call (issue #1858).
const LABEL_PATTERN_BY_KEY = new Map(
  [...REPORT_LABEL_NAMES, "Verdict"].map((label) => [
    label.toLowerCase(),
    new RegExp(`^${label}:\\s*(.*)$`, "i"),
  ]),
);

// A column-0 label line whose name and colon sit inside `**...**`, for example `**Why:** text`.
// Only the six report labels gain this form, so a bold lead with another name stays text (issue
// #1483).
const BOLD_LABEL = `\\*\\*(?:${LABEL_NAMES}):\\*\\*`;
const BOLD_LABEL_LINE = new RegExp(`^\\*\\*(${LABEL_NAMES}):\\*\\*(.*)$`, "i");

// A column-0 line that holds only `**Label**`, for example `**Conclusion**`, with optional trailing
// whitespace. Only the six report labels gain this form (issue #1585).
const BOLD_HEADING_LABEL = `\\*\\*(?:${LABEL_NAMES})\\*\\*\\s*$`;
const BOLD_HEADING_LABEL_LINE = new RegExp(`^\\*\\*(${LABEL_NAMES})\\*\\*\\s*$`, "i");

// A line that opens a known report label or a plain `Verdict` line at column 0, plain or bold.
const KNOWN_LABEL_LINE = new RegExp(
  `^(?:(?:${LABEL_NAMES}|Verdict):|${BOLD_LABEL}|${BOLD_HEADING_LABEL})`,
  "i",
);

// A line that opens a plain report label at column 0.
const PLAIN_LABEL_LINE = new RegExp(`^(?:${LABEL_NAMES}):`, "i");

/**
 * True when `line` opens a known report label or a plain `Verdict` line at column 0, plain or bold.
 * A line inside a fenced code block is no known label (issue #1483).
 * @param {string} line
 * @param {boolean} [fenced]
 * @returns {boolean}
 */
function isKnownLabelLine(line, fenced = false) {
  return !fenced && KNOWN_LABEL_LINE.test(line);
}

// Lines inside a fenced code block, from a ``` or ~~~ opener to its matching closer. A bold report
// label inside a fence stays text (issue #1483).
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
 * Returns the lines of `text` with each column-0 bold report label normalized to its plain form.
 * The forms are `**Label:**` (issue #1483) and a line that holds only `**Label**` (issue #1585).
 * A bold label inside a fenced code block stays text. With `boldLabels` false, the lines are
 * unchanged. The fenced flags come with the lines, so a caller never scans the fences twice
 * (issue #1858).
 * @param {string} text
 * @param {boolean} [boldLabels]
 * @returns {{ lines: string[], fenced: boolean[] }}
 */
function normalizedReportLines(text, boldLabels = true) {
  const lines = boldLabels ? text.split(/\r?\n/) : text.split("\n");
  const fenced = fencedLines(lines);
  if (!boldLabels) {
    return { lines, fenced };
  }
  return {
    lines: lines.map((line, index) => {
      const boldHeading = BOLD_HEADING_LABEL_LINE.test(line);
      if (!BOLD_LABEL_LINE.test(line) && !boldHeading) {
        return line;
      }
      if (!isKnownLabelLine(line, fenced[index])) {
        return `x${line}`;
      }
      return boldHeading
        ? line.replace(BOLD_HEADING_LABEL_LINE, "$1:")
        : line.replace(BOLD_LABEL_LINE, "$1:$2");
    }),
    fenced,
  };
}

// A report label that indentation or markdown decoration hides from the strict
// match, for example `**Deferred**: x`, `*Deferred:* x`, `### Deferred: x`,
// `> Deferred: x`, or `  Deferred: x`. Such a value would otherwise be dropped,
// so the whole block is unparseable and `raw` carries the text (issue #243).
// The Verdict label is excluded: a malformed verdict already maps to `unknown`
// and never carries report text.
const DECORATED_LABEL_LINE = new RegExp(
  `^(?!(?:${LABEL_NAMES}):)\\s*(?:>\\s*|#{1,6}\\s+|[-*+]\\s*|\\d+[.)]\\s+)*[*_\`]{0,2}(?:${LABEL_NAMES})[*_\`]{0,2}\\s*:`,
  "i",
);

// A dash item or sub-item whose text opens with a bold mark, for example `- **Checks:** ran`. When it
// folds into a label's list run, a label name in the bold lead is item text (issue #1006).
const BOLD_DASH_ITEM = /^\s*- \*\*/;

// A list line the parser would drop, for example `- item`, `* item`, `1. item`,
// or the same without the space after the marker (`-item`). A run of markers
// alone (`---`), a decimal (`1.5x`), an arrow (`->`), and an ordered marker that
// another list marker follows (`1.-x`, `1.*x`) are not lists: after a bullet
// marker a `>` is rejected, and after an ordered marker a digit or a list marker
// is rejected, so an ordinary sentence that opens this way does not blank the
// block (issues #256 and #259).
const LIST_LINE = /^\s*(?:[-*+](?:\s+\S|[^\s\-*+>])|\d+[.)](?:\s+\S|[^\s\d\-*+]))/;

// A markdown thematic break, for example `* * *` or `- - -`. It matches the
// list pattern but carries no item, so it does not drop text.
const THEMATIC_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

const TABLE_DELIMITER = /^:?-+:?$/;

/**
 * True when the line is a Markdown table delimiter row: cells of only dashes with optional colons,
 * separated by `|`, with or without outer pipes. A line with no `|` is no delimiter row (issue #1366).
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
// leading `*` is also a spaceless bullet marker, whose accepted gap is in issue #275.
const EMPHASIS_LINE = /^\s*\*(?=\S)[^*]*(?<=\p{L})\*(?![\w*])(?![^\s]*[\p{L}\d])/u;

// A report label name or `Verdict`, in any case, anywhere in the text, followed by optional
// emphasis or code marks and whitespace and then a colon. It has no lead-in condition on purpose:
// every lead-in rule missed another list shape (issue #449), so the rule is the widest
// one. It holds every label the strict match, DECORATED_LABEL_LINE, or LIST_LINE reads, and it
// also holds a mid-sentence mention such as `the conclusion: none`. That mention fails closed.
const LABEL_MENTION = new RegExp(`(?:${LABEL_OR_VERDICT})[*_\`]{0,2}\\s*:`, "i");

// A label or `Verdict` mention that bars a prose line from introducing a folded list (issue #898).
// It differs from LABEL_MENTION in one way: any run of emphasis or code marks may follow the name,
// not at most two. A mark before the name needs no rule, because the match has no lead-in condition.
const HEADING_LABEL_MENTION = new RegExp(`(?:${LABEL_OR_VERDICT})[*_\`]*\\s*:`, "i");

/**
 * True when the response holds a closing block attempt: any report label name or `Verdict`
 * followed by a colon, anywhere in the text, whether or not the block parses. A response
 * without one is plain prose, such as a late answer to an event after the closing block.
 * @param {string} response
 * @returns {boolean}
 */
export function hasClosingBlockAttempt(response) {
  return LABEL_MENTION.test(response);
}

/**
 * The closing block runs from the last `Conclusion:` line to the end of the response, and is null
 * without that line. A lone required label line or a lone `Verdict:` line above it, with only blank
 * lines between, joins the block (issues #1592 and #1793). That label must appear once in the
 * response outside a fence, so a quoted or repeated label stays out. The whole response is
 * normalized first, so a bold label starts a block as its plain form does. With `unlabeled`, a
 * response without a `Conclusion:` label takes the non-blank line directly before the first known
 * report label outside a fence as `Conclusion`. When a bold-lead narration paragraph sits there,
 * the nearest plain prose line above becomes `Conclusion` (issue #1597).
 * @param {string} response
 * @param {{ unlabeled?: boolean, boldLabels?: boolean, diagnose?: boolean, blankFenced?: boolean, includeFencedStart?: boolean }} [options]
 * @returns {string[] | null}
 */
function closingBlock(
  response,
  {
    unlabeled = false,
    boldLabels = true,
    diagnose = false,
    blankFenced = true,
    includeFencedStart = false,
  } = {},
) {
  // A bold label inside a fenced code block stays text (issue #1483).
  const { lines, fenced } = normalizedReportLines(response, boldLabels);
  // A `Conclusion:` line inside a fence never starts the block, and a fenced line supplies no label
  // when `blankFenced` holds (issue #1909). The guard scan keeps the origin/main start when
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
      // names missing labels (issue #1520).
      return diagnose ? blockFrom(first) : null;
    }
    before = prose;
  }
  const block = blockFrom(before);
  block[0] = `Conclusion: ${lines[before].trim()}`;
  return block;
}

/**
 * The block lines from `first`, with each fenced line blanked. A fenced line is quoted text, so it
 * never supplies a report label or a list (issue #1909). The blank keeps the line count that
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
// `Blockers:` (issue #1592). The reviewer `Verdict:` line joins that set (issue #1793).
const LEADING_LABEL_LINES = [
  ...REPORT_LABELS.filter(([, , optional]) => !optional).map(([, label]) => [
    label,
    new RegExp(`^${label}:`, "i"),
  ]),
  ["Verdict", /^Verdict:/i],
];

/**
 * The index where the closing block starts: `start`, or the first lone required label or `Verdict:`
 * line above it. Only blank lines lie between that line and the block (issues #1592 and #1793).
 * A label line inside a fence stays out. A label that another unfenced line repeats stays out too.
 * So a quoted label neither starts nor extends the block. `fenced` reuses the flags of an earlier
 * scan, so a caller that normalized the lines never scans the fences twice (issue #1858).
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

// A column-0 line that opens a bold mark, for example `**Blocker.** The test failed` (issue #1597).
const BOLD_LEAD_LINE = /^\*\*/;

/**
 * The index of the plain prose line above a run of bold-lead narration paragraphs and blank lines,
 * or -1 when there is none. A child can write the conclusion as prose, then bold-lead paragraphs,
 * then the report labels with no `Conclusion:` line (issue #1597).
 * @param {string[]} lines
 * @param {number} from the non-blank line directly above the first known label
 * @returns {number}
 */
function boldNarrationProseLine(lines, from) {
  let at = from;
  while (at >= 0) {
    if (lines[at].trim() === "" || BOLD_LEAD_LINE.test(lines[at])) {
      at--;
      continue;
    }
    return isPlainProseLine(lines[at]) ? at : -1;
  }
  return -1;
}

/**
 * The closing block with the parser's list folding applied, plus the value each report label reads
 * there. It is null when no closing block attempt exists. `parseReportBlock` and the missing-label
 * diagnosis share this step. A label is present exactly when the parser's label scan reads a value
 * for it (issue #1520).
 * @param {string} response
 * @param {{ boldLabels?: boolean, diagnose?: boolean }} [options]
 * @returns {{ block: string[], lines: string[] | null, labels: Array<{ key: string, label: string, optional: boolean, value: string | null }> } | null}
 */
function foldedReportBlock(response, { boldLabels = true, diagnose = false } = {}) {
  const block = closingBlock(response, { unlabeled: true, boldLabels, diagnose });
  if (!block) {
    return null;
  }
  const lines = foldEmptyLabelLists(block);
  const labels = REPORT_LABELS.map(([key, label, optional]) => {
    const value = lastLabeled(lines ?? block, label)?.value ?? "";
    return { key, label, optional, value: value === "" ? null : value };
  });
  return { block, lines, labels };
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
  if (block.some((line) => DECORATED_LABEL_LINE.test(line) && !BOLD_DASH_ITEM.test(line))) {
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
// stays out. The detection is a heuristic: a pointer that the list misses stays undetected
// (issue #1907).
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
function textBeforeBlock(response) {
  const block = closingBlock(response, { unlabeled: true });
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
 * the block.
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
  const labels = REPORT_LABELS.filter(([key]) => pointsOutsideBlock(report[key])).map(
    ([, label]) => label,
  );
  if (labels.length === 0 || labels.length > 1 || !exception) {
    return labels;
  }
  const before = textBeforeBlock(response);
  return hasQuotedText(before) || paragraphCount(before) >= 2 ? [] : labels;
}

// A task value that a correct report can also hold, so it names no copied label.
const NON_SPECIFIC_VALUE = /^(?:none|n\/a)\.?$/i;

/**
 * The report label names whose value equals the value of the same label in the init task, in report
 * order, for example `["Conclusion"]`. The task label values come from the diagnostic fold that
 * `missingRequiredReportLabels` uses, so a partial task block supplies the values it holds. A fenced
 * task line supplies no value. A task value of `none` or `n/a` names no label, because a correct
 * report can hold it. The detection is a heuristic: an exact match names the label, and a value
 * under another label stays out.
 * @param {ReturnType<typeof parseReportBlock>} report
 * @param {string | null | undefined} task
 * @returns {string[]}
 */
export function copiedTaskReportLabels(report, task) {
  if (!report || typeof task !== "string") {
    return [];
  }
  const taskValues = new Map(
    (foldedReportBlock(task, { diagnose: true })?.labels ?? []).map(({ key, value }) => [
      key,
      value,
    ]),
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
 * exists. A structural failure never hides a label that is absent (issue #1520).
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
 * also parses without bold labels is not bold-dependent.
 * @param {string} response
 * @returns {boolean}
 */
export function parsesOnlyWithBoldLabels(response) {
  return (
    parseReportBlock(response) !== null &&
    parseReportBlock(response, { boldLabels: false }) === null
  );
}

/**
 * The report for one child result. A multi-part unidentified OpenCode report that parses only
 * through bold normalization is null. The first parse passes through, so a multi-part response
 * parses at most twice (issue #1858).
 * @param {string} response
 * @param {boolean} [multiPartUnidentified]
 * @returns {ReturnType<typeof parseReportBlock>}
 */
export function reportForResult(response, multiPartUnidentified = false) {
  const report = parseReportBlock(response);
  if (!multiPartUnidentified || report === null) {
    return report;
  }
  return parseReportBlock(response, { boldLabels: false }) === null ? null : report;
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
 * that the parser does not fold still counts as content (issue #1615).
 * @param {string} response
 * @returns {Map<string, string[]> | null}
 */
function originalLabelTokens(response) {
  const block = closingBlock(response, { unlabeled: true, diagnose: true });
  if (!block) {
    return null;
  }
  const sections = new Map();
  let current = null;
  for (const line of block) {
    const match = line.match(REPORT_LABEL_LINE);
    if (match) {
      current = LABEL_KEY_BY_NAME.get(match[1].toLowerCase()) ?? null;
      if (current !== null) {
        sections.set(current, reportContentTokens(match[2]));
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
  return sections;
}

// Maintainer triage: keep a parser fix for a regression, a dropped finding, or an incorrect
// acceptance. Leave an unsupported format uncovered until the repair ships, and keep a repeated
// repair failure actionable (issue #1615).

/**
 * True when a repaired report restates only what the original response already held (issue #1615).
 * The repair is untrusted: each label keeps the normalized content of the original, whatever list
 * form it used, a label that the original left out may gain only `none`, and a reviewer verdict
 * must match an explicit original verdict. Any mismatch leaves the repair unused, so a repair can
 * never create an acceptance that the original response did not state.
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
  const originals = originalLabelTokens(response);
  if (originals === null) {
    return false;
  }
  for (const [key] of REPORT_LABELS) {
    const original = originals.get(key) ?? [];
    const repaired = reportContentTokens(report[key] ?? "");
    if (original.length === 0) {
      if (
        repaired.length > 0 &&
        !(repaired.length === 1 && NO_REPAIRED_FINDING.test(repaired[0]))
      ) {
        return false;
      }
      continue;
    }
    if (
      original.length !== repaired.length ||
      original.some((token, index) => token !== repaired[index])
    ) {
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
// one ASCII space (U+0020), then an item (issue #915 added the ordered marker). Any other separator
// (a tab, a nonbreaking space, a second space), a spaceless bullet, an indented bullet, a `*` or
// `+` bullet, and an `N)` item stay lists that hasDroppedList rejects.
const FOLDABLE_ITEM = /^(?:- |\d+\. )(?=\S)/;

// The item shape that folds under a prose heading (issue #898): a dash item only. An ordered item
// there stays a list that hasDroppedList rejects.
const HEADING_ITEM = /^- (?=\S)/;

// The nesting levels that fold into their parent item.
// A sub-item line holds ASCII spaces up to the parent item text column.
// Then come a `-` or `N. ` marker, one ASCII space, and the item.
// The indent is the parent text column: `- ` takes two spaces, `1. a` three, and `10. a` four (issues #870, #1603, and #1917).
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
 * whitespace. An ordered sub-item never folds it into item text (issue #1082).
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
 * True when the line is an indented prose line that continues the item above (issue #1082): ASCII
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

/**
 * The text of the item at `start` and of its direct sub-items at every deeper level, joined with
 * ", ", and the last line used. `marker` is the full marker prefix of the parent line, so its
 * length is the column where the sub-item marker starts.
 */
function takeSubitems(lines, start, marker) {
  const [subMarker] = lines[start].match(foldableSubitem(marker));
  const parts = [lines[start].slice(subMarker.length).trim()];
  let i = start;
  while (i + 1 < lines.length && isFoldableSubitem(lines[i + 1], subMarker)) {
    const nested = takeSubitems(lines, i + 1, subMarker);
    parts.push(nested.text);
    i = nested.end;
  }
  return { text: parts.join(", "), end: i };
}

/**
 * The items that match `pattern` and directly follow line `start`, and the last line used. Each
 * item absorbs its sub-items at every deeper level, joined with ", ". The continuation lines after
 * them join with a space, like a Markdown lazy continuation.
 */
function takeItems(lines, start, pattern, { refuseOrderedVerdict = false } = {}) {
  let i = start;
  const items = [];
  while (i + 1 < lines.length && isFoldableItem(lines[i + 1], pattern)) {
    if (refuseOrderedVerdict && isOrderedVerdictItem(lines[i + 1])) {
      break;
    }
    const [marker] = lines[++i].match(pattern);
    const parts = [lines[i].slice(marker.length).trim()];
    while (i + 1 < lines.length && isFoldableSubitem(lines[i + 1], marker)) {
      const nested = takeSubitems(lines, i + 1, marker);
      parts.push(nested.text);
      i = nested.end;
    }
    const continuation = [];
    while (i + 1 < lines.length && isContinuationLine(lines[i + 1])) {
      continuation.push(lines[++i].trim());
    }
    items.push([parts.join(", "), ...continuation].join(" "));
  }
  return { items, end: i };
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
 * A plain prose line that may introduce a folded list (issue #898): its first character is not
 * whitespace, `*`, `_`, a backtick, `>`, or `#`, is not a list, and names no report label or
 * `Verdict` followed by any run of marks, optional whitespace, and a colon anywhere. A malformed or decorated label, a `Verdict` line, and a
 * `*` line (issue #275) therefore never supply a field value.
 */
function isPlainProseLine(line) {
  return /^[^\s*_`>#]/.test(line) && !isListLine(line) && !HEADING_LABEL_MENTION.test(line);
}

const BOLD_PROSE_LINE = /^\*\*[^*]+\*\*$/;

/**
 * True when the line is a whole-line bold prose heading that can introduce a folded list (issue
 * #1367). Examples are `**Reviewer notes.**`. The bold must wrap the whole line, so a `*` bullet and
 * a `**bold** note` line with trailing text stay out.
 */
function isBoldProseLine(line) {
  return BOLD_PROSE_LINE.test(line) && !isListLine(line) && !HEADING_LABEL_MENTION.test(line);
}

/**
 * Folds a run of `- ` items that directly follows a report label line into that label's value.
 * Markers drop, and items join each other and an existing value with "; " (issues #846 and #879).
 * Each item absorbs the `- ` or `N. ` sub-items right after it, joined with ", " (issue #870).
 * A prose line with a `- ` run directly under it folds as `<prose>: <items>` after one or more blank
 * lines (issue #898). A dash or ordered run after one blank line joins the label, unless an ordered item reads as a Verdict line (issue #1348).
 * Every other list shape stays for hasDroppedList, and a shadowing repeat returns null while dispatch keeps `raw`.
 * @param {string[]} lines
 * @returns {string[] | null}
 */
function foldEmptyLabelLists(lines) {
  const out = [];
  const folded = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PLAIN_LABEL_LINE.test(line)) {
      let { items, end } = takeItems(lines, i, FOLDABLE_ITEM);
      if (items.length === 0 && lines[i + 1]?.trim() === "") {
        // One blank line then a dash or ordered run under the same label folds too (issues #1348
        // and #1603). Two blank lines and every other list shape stay for hasDroppedList.
        // A blank-line ordered item that reads as a Verdict line stays unparseable.
        ({ items, end } = takeItems(lines, i + 1, FOLDABLE_ITEM, { refuseOrderedVerdict: true }));
      }
      if (items.length > 0) {
        const label = line.trim();
        folded.push({ label: label.slice(0, label.indexOf(":")), index: out.length });
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
      const { items, end } = takeItems(lines, i, HEADING_ITEM);
      if (items.length > 0 && at >= 0 && PLAIN_LABEL_LINE.test(out[at])) {
        folded.push({ label: out[at].slice(0, out[at].indexOf(":")), index: at });
        out[at] = appendToLabel(out[at], `${line.trim().replace(/:$/, "")}: ${items.join("; ")}`);
        i = end;
        continue;
      }
    }
    out.push(line);
  }
  return folded.every(({ label, index }) => lastLabeled(out, label).index === index) ? out : null;
}

/**
 * True when the block holds a list line the parser would drop. A label holds
 * one line, so a list anywhere in the block that foldEmptyLabelLists left is
 * dropped, including under an earlier occurrence of a label that a later
 * occurrence shadows and after the reviewer `Verdict:` line (issue #249).
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
 * acceptance. A `Verdict:` line inside a fenced code block supplies no verdict (issue #1909).
 * @param {string} response
 * @returns {"accept" | "reject" | "unknown"}
 */
export function parseVerdict(response) {
  return verdictFrom(closingBlock(response));
}

/**
 * The verdict for the OpenCode split-message guard. It keeps the origin/main block start, fenced
 * lines included, so every stream that a split refused still refuses (issue #1483). It never
 * supplies a report or a gate (issue #1909).
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
  const pattern =
    LABEL_PATTERN_BY_KEY.get(label.toLowerCase()) ?? new RegExp(`^${label}:\\s*(.*)$`, "i");
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
 * prompt states (#217) and the interactive --require-accept gate (issue #218). An accept without a
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
