// Parses the closing block that reportBlock (src/prompts/rules.mjs) requires
// from every child turn, plus the reviewer Verdict line. Both parse only the
// final block. It starts at the last `Conclusion:` line, or at a lone required
// label line directly above that line (issue #1592), so labels or verdicts in
// earlier prose can never produce a verdict.

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
 * Returns `text` with each column-0 bold report label normalized to its plain form. The forms are
 * `**Label:**` (issue #1483) and a line that holds only `**Label**` (issue #1585). A bold label
 * inside a fenced code block stays text. With `boldLabels` false, the text is unchanged, which
 * reads a bold label as origin/main did.
 * @param {string} text
 * @param {boolean} [boldLabels]
 * @returns {string}
 */
function normalizeReportLabels(text, boldLabels = true) {
  if (!boldLabels) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  return lines
    .map((line, index) => {
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
    })
    .join("\n");
}

// A report label that indentation or markdown decoration hides from the strict
// match, for example `**Deferred**: x`, `*Deferred:* x`, `### Deferred: x`,
// `> Deferred: x`, or `  Deferred: x`. Such a value would otherwise be dropped,
// so the whole block is unparseable and `raw` carries the text (issue #243).
// The Verdict label is excluded: a malformed verdict already maps to `unknown`
// and never carries report text.
const DECORATED_LABEL_LINE = new RegExp(
  `^(?!(?:${REPORT_LABEL_NAMES.join("|")}):)\\s*(?:>\\s*|#{1,6}\\s+|[-*+]\\s*|\\d+[.)]\\s+)*[*_\`]{0,2}(?:${REPORT_LABEL_NAMES.join("|")})[*_\`]{0,2}\\s*:`,
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

// A Markdown table delimiter row: cells of only dashes with optional colons, separated by `|`,
// with or without outer pipes. A line with no `|` is no delimiter row (issue #1366).
const TABLE_DELIMITER = /^:?-+:?$/;

/** True when the line is a Markdown table delimiter row: cells of only dashes with optional colons, separated by `|`, with or without outer pipes. */
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

// An emphasis run at line start, for example `*emphasis* note`.
// - A leading `*` is also a spaceless bullet marker (`*item`, issue #243).
// - A `*` pair whose close a letter precedes is ordinary prose when a non-word,
//   non-`*` character or the line end follows. It does not blank the block
//   (issues #259 and #264).
// - A letter before the close tells a real emphasis run from a spaceless bullet.
//   That bullet's later `*` is a wildcard or multiplication (`*glob src/*.mjs`,
//   `*use 2* 3`). Without the letter requirement, the item drops with no `raw` signal.
// - The letter requirement also keeps a spaceless bullet with a later ` * ` a list.
// - The close must not be glued to a following token that carries a letter or an
//   ASCII digit. A spaceless bullet whose later `*` a letter precedes and a
//   filename or glob continues (`*file*.mjs`, `*glob src/a*.mjs`) counts as a
//   list too (issue #267).
// - The cost is wider than a glued word (`*self*-hosted`). Any following token
//   that carries a letter or an ASCII digit flags as well, for example
//   `*Claude*'s review`, `*emph*—then more`, `*a*/b`, `*Note*:x`, and `*emph*.2`.
// - A non-ASCII digit (`*emph*.٢`, `*file*.٢`) carries no `\d`, so it does not flag.
// - The cost is not only a reporting loss. A null block has no Checks line, so
//   the `--require-accept` gate also refuses. `acceptGateReason` in
//   src/role/finish.mjs returns "the accepted review has no Checks line", and
//   `isAcceptedReview` in this file returns false. Both directions fail closed,
//   but the report loses its text to `raw`, and the `acceptGateReason` refusal
//   names the wrong cause.
//
// known-limit: a `*` line whose closing `*` a letter precedes, where the
// character right after the close is not a word character or `*`, and where
// nothing glued from that character on is a letter or an ASCII digit (`*file*`,
// `*glob src/a*`, `*use a* b`, `*glob src/a*, b`), reads as an emphasis run, so
// the block still parses and the line is dropped with no `raw` signal (issue
// #275, accepted gap). The two checks are separate, so `*emph*._` stays exempt
// while `*emph*_` and `*a*_.b` blank the block. The same line is a valid
// spaceless bullet, and no pattern on the line tells the two apart; the rest of
// the block carries no signal either, so the line is the only evidence there is.
// Ceiling: every matching line in the block drops this way, under any label.
// That is no new class of loss, because any line that is neither a label nor a
// list already drops the same way (`Notes:` then `file a is stale`). Every
// other `*` line either is a list and blanks the block (`*item`, `* item`,
// `*file*.mjs`) or is not a list and drops as prose (`**bold** note`). Upgrade
// path: drop this exemption and read every `*` opener as a list, which loses the
// emphasis shapes above into `raw` and makes that loss loud.
const EMPHASIS_LINE = /^\s*\*(?=\S)[^*]*(?<=\p{L})\*(?![\w*])(?![^\s]*[\p{L}\d])/u;

// A report label name or `Verdict`, in any case, anywhere in the text, followed by optional
// emphasis or code marks and whitespace and then a colon. It has no lead-in condition on purpose:
// every lead-in rule missed another list shape (issue #449), so the rule is the widest
// one. It holds every label the strict match, DECORATED_LABEL_LINE, or LIST_LINE reads, and it
// also holds a mid-sentence mention such as `the conclusion: none`. That mention fails closed.
const LABEL_MENTION = new RegExp(
  `(?:${[...REPORT_LABEL_NAMES, "Verdict"].join("|")})[*_\`]{0,2}\\s*:`,
  "i",
);

// A label or `Verdict` mention that bars a prose line from introducing a folded list (issue #898).
// It differs from LABEL_MENTION in one way: any run of emphasis or code marks may follow the name,
// not at most two. A mark before the name needs no rule, because the match has no lead-in condition.
const HEADING_LABEL_MENTION = new RegExp(
  `(?:${[...REPORT_LABEL_NAMES, "Verdict"].join("|")})[*_\`]*\\s*:`,
  "i",
);

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
 * without that line. A lone required label line above it, with only blank lines between, joins the
 * block (issue #1592). That label must appear once in the response outside a fence, so a quoted or
 * repeated label stays out. The whole response is normalized first, so a bold label starts a block
 * as its plain form does. With `unlabeled`, a response without a `Conclusion:` label takes the
 * non-blank line directly before the first known report label as `Conclusion`. When a bold-lead
 * narration paragraph sits there, the nearest plain prose line above becomes `Conclusion` (issue
 * #1597).
 * @param {string} response
 * @param {{ unlabeled?: boolean, boldLabels?: boolean, diagnose?: boolean }} [options]
 * @returns {string[] | null}
 */
function closingBlock(response, { unlabeled = false, boldLabels = true, diagnose = false } = {}) {
  // A bold label inside a fenced code block stays text (issue #1483).
  const lines = normalizeReportLabels(response, boldLabels).split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^Conclusion:\s*/i.test(lines[i])) {
      start = i;
    }
  }
  if (start !== -1) {
    return lines.slice(leadingRequiredLabelStart(lines, start));
  }
  if (!unlabeled) {
    return null;
  }
  const first = lines.findIndex((line) => PLAIN_LABEL_LINE.test(line));
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
      return diagnose ? lines.slice(first) : null;
    }
    before = prose;
  }
  const block = lines.slice(before);
  block[0] = `Conclusion: ${lines[before].trim()}`;
  return block;
}

// The required labels a child can write in their own paragraph above `Conclusion:`, for example
// `Blockers:` (issue #1592).
const REQUIRED_LABEL_LINES = REPORT_LABELS.filter(([, , optional]) => !optional).map(
  ([, label]) => [label, new RegExp(`^${label}:`, "i")],
);

/**
 * The index where the closing block starts: `start`, or the first of the lone required label lines
 * directly above it, with only blank lines between (issue #1592). A label line inside a fence, or a
 * label that another line of the response repeats outside a fence, stays out, so a quoted label
 * neither starts nor extends the block.
 * @param {string[]} lines
 * @param {number} start
 * @returns {number}
 */
export function leadingRequiredLabelStart(lines, start) {
  const fenced = fencedLines(lines);
  let first = start;
  for (;;) {
    let at = first - 1;
    while (at >= 0 && lines[at].trim() === "") {
      at--;
    }
    if (at < 0 || fenced[at]) {
      return first;
    }
    const entry = REQUIRED_LABEL_LINES.find(([, pattern]) => pattern.test(lines[at]));
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
 * absent or empty optional label maps to null. A `- ` or `N. ` list directly under a label, or after
 * one blank line, joins that label's value with "; ". One nesting level folds a `- ` or `N. `
 * sub-item at the parent text column into that item with ", ". Any other list line, a Markdown table
 * pair, or a hidden or decorated label makes the whole block unparseable, so `raw` carries the text.
 * @param {string} response
 * @param {{ boldLabels?: boolean }} [options]
 * @returns {{ conclusion: string, why: string, blockers: string, checks: string | null, notes: string | null, deferred: string | null } | null}
 */
export function parseReportBlock(response, { boldLabels = true } = {}) {
  return reportDetail(response, { boldLabels })?.report ?? null;
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
 * through bold normalization is null.
 * @param {string} response
 * @param {boolean} [multiPartUnidentified]
 * @returns {ReturnType<typeof parseReportBlock>}
 */
export function reportForResult(response, multiPartUnidentified = false) {
  return multiPartUnidentified && parsesOnlyWithBoldLabels(response)
    ? null
    : parseReportBlock(response);
}

// A report label line, empty or with a value, for example `Notes:` or `Notes: none`. The reviewer
// `Verdict:` line is no report label, so a list after it never folds.
const LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")}):`, "i");

// The list shapes that fold under a label: a `-` or an ordered `N.` marker at column 0, exactly
// one ASCII space (U+0020), then an item (issue #915 added the ordered marker). Any other separator
// (a tab, a nonbreaking space, a second space), a spaceless bullet, an indented bullet, a `*` or
// `+` bullet, and an `N)` item stay lists that hasDroppedList rejects.
const FOLDABLE_ITEM = /^(?:- |\d+\. )(?=\S)/;

// The item shape that folds under a prose heading (issue #898): a dash item only. An ordered item
// there stays a list that hasDroppedList rejects.
const HEADING_ITEM = /^- (?=\S)/;

// The one nesting level that folds into its parent item.
// A sub-item line holds ASCII spaces up to the parent item text column.
// Then come a `-` or `N. ` marker, one ASCII space, and the item.
// A `- ` parent takes two spaces and an `N. ` parent takes three (issues #870 and #1603).
// Another indent width, a tab, and a second nesting level stay lists that hasDroppedList rejects.
const foldableSubitem = (marker) => new RegExp(`^ {${marker.length}}(?:- |\\d+\\. )(?=\\S)`);

// An ordered sub-item at the parent text column, with exactly one ASCII space after its marker.
const orderedSubitem = (marker) => new RegExp(`^ {${marker.length}}\\d+\\. (?=\\S)`);

// A line that reads as a report label or `Verdict` line under any markup or separator: after NFKC
// normalization it skips every leading character that is no letter or digit (quote, heading, list,
// and emphasis marks, in any count) and one optional number, then holds a label name or `Verdict`,
// any case, optional whitespace, and a character that is no letter, digit, or whitespace. Every
// colon variant (`:`, `：`, `∶`) and every other separator therefore matches, and the check names no
// markup or separator shape. A label word that a letter, digit, or whitespace-then-letter follows
// (`Notes about x`, `Why this matters:`) is prose and does not match.
const LABEL_WORD_THEN_SEPARATOR = new RegExp(
  `^[^\\p{L}\\p{N}]*(?:\\p{N}+[^\\p{L}\\p{N}]*)?(?:${[...REPORT_LABEL_NAMES, "Verdict"].join("|")})\\s*[^\\p{L}\\p{N}\\s]`,
  "iu",
);

/** True when the line reads as a report label or `Verdict` line under any markup or separator. */
function readsAsLabelLine(line) {
  return LABEL_WORD_THEN_SEPARATOR.test(line.normalize("NFKC"));
}

// A `Verdict` line under any markup or separator: after NFKC normalization it skips leading
// non-letter, non-digit characters and one optional number.
// It then holds `Verdict`, any case, optional whitespace, and a character that is no letter, digit,
// or whitespace. An ordered sub-item never folds it into item text (issue #1082).
const VERDICT_WORD_THEN_SEPARATOR = new RegExp(
  `^[^\\p{L}\\p{N}]*(?:\\p{N}+[^\\p{L}\\p{N}]*)?Verdict\\s*[^\\p{L}\\p{N}\\s]`,
  "iu",
);

/** True when the line reads as a `Verdict` line under any markup or separator. */
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

/** True when the line is a `- ` or `N. ` sub-item indented to the text column of its parent item `marker`. */
function isFoldableSubitem(line, marker) {
  // An ordered sub-item that reads as a Verdict line never folds, so a rejection stays visible.
  // A dash sub-item keeps the origin/main fold.
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
 * The items that match `pattern` and directly follow line `start`, and the last line used. Each
 * item absorbs its sub-items, joined with ", ", then the continuation lines after them, joined with
 * a space like a Markdown lazy continuation.
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
      const [subMarker] = lines[++i].match(foldableSubitem(marker));
      parts.push(lines[i].slice(subMarker.length).trim());
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

// A bold prose line that can introduce a folded list, for example `**Reviewer notes.**`
// (issue #1367). The bold must wrap the whole line, so a `*` bullet and a `**bold** note` line
// with trailing text stay out.
const BOLD_PROSE_LINE = /^\*\*[^*]+\*\*$/;

/**
 * True when the line is a whole-line bold prose heading that can introduce a folded list (issue
 * #1367). Examples are `**Reviewer notes.**`. A `*` bullet and `**bold** note` with trailing text
 * are no heading.
 */
function isBoldProseLine(line) {
  return BOLD_PROSE_LINE.test(line) && !isListLine(line) && !HEADING_LABEL_MENTION.test(line);
}

/**
 * Folds a run of `- ` items that directly follows a report label line into that label's value.
 * Markers drop, and items join each other and an existing value with "; " (issues #846 and #879).
 * Each item absorbs the `- ` or `N. ` sub-items right after it, joined with ", " (issue #870).
 * A prose line with a `- ` run directly under it folds as `<prose>: <items>` after one or more blank
 * lines (issue #898). A dash or ordered run after one blank line joins the label (issue #1348).
 * Every other list shape stays for hasDroppedList, and a shadowing repeat returns null with no `raw` signal.
 * @param {string[]} lines
 * @returns {string[] | null}
 */
function foldEmptyLabelLists(lines) {
  const out = [];
  const folded = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LABEL_LINE.test(line)) {
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
      if (items.length > 0 && at >= 0 && LABEL_LINE.test(out[at])) {
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
 * Extracts the reviewer verdict from a `Verdict:` line inside the closing
 * block. The verdict word alone, the word closed by an optional sentence
 * period, or the word followed by a punctuation separator, whitespace, and a
 * clause, maps to that word. A clause that names either verdict as a whole word
 * (for example `accept, reject`) maps to `unknown`, because it does not state
 * one verdict. A verdict outside the block, or any other value (including a
 * missing or malformed line), also maps to `unknown`; process success never
 * implies acceptance.
 * @param {string} response
 * @returns {"accept" | "reject" | "unknown"}
 */
export function parseVerdict(response) {
  const block = closingBlock(response);
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
  const pattern = new RegExp(`^${label}:\\s*(.*)$`, "i");
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (match) {
      found = { value: match[1].trim(), index: i };
    }
  }
  return found;
}

// An accept counts only with a Checks line in the closing block, matching the
// parent rule the prompt states (#217) and the interactive --require-accept gate
// (issue #218). An accept without a Checks line is treated as not accepted.
/**
 * The first failing acceptance check, "verdict" or "checks", or null when the review is accepted.
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

/**
 * True when the response is an accept with a stored report that carries a Checks line.
 * @param {string} response
 * @param {ReturnType<typeof parseReportBlock>} [report]
 * @returns {boolean}
 */
export function isAcceptedReview(response, report = parseReportBlock(response)) {
  return acceptanceFailure(response, report) === null;
}
