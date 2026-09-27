// Parses the closing block that reportBlock (src/prompts/report.mjs) requires
// from every child turn, plus the reviewer Verdict line. Both parse only the
// final block, which starts at the last `Conclusion:` line, so labels or
// verdicts in earlier prose can never produce a verdict.

const REPORT_LABELS = [
  ["conclusion", "Conclusion", false],
  ["why", "Why", false],
  ["blockers", "Blockers", false],
  ["checks", "Checks", true],
  ["notes", "Notes", true],
  ["deferred", "Deferred", true],
];

const REPORT_LABEL_NAMES = REPORT_LABELS.map(([, label]) => label);

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

// An emphasis run at line start, for example `*emphasis* note`. A leading `*`
// is also a spaceless bullet marker (`*item`, issue #243), but a `*` pair that
// wraps a run, closed by a `*` that whitespace or end of line follows, is
// ordinary prose, so it does not blank the block (issue #259).
const EMPHASIS_LINE = /^\s*\*(?=\S)[^*]*(?:\*(?!\S))/;

/**
 * The closing block: the lines from the last `Conclusion:` line to the end of
 * the response, or null when the response has no `Conclusion:` line at all.
 * @param {string} response
 * @returns {string[] | null}
 */
function closingBlock(response) {
  const lines = response.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^Conclusion:\s*/i.test(lines[i])) {
      start = i;
    }
  }
  return start === -1 ? null : lines.slice(start);
}

/**
 * Extracts the closing block as `{ conclusion, why, blockers, checks, notes, deferred }`.
 * Each label is matched case-insensitively at line start inside the closing
 * block only; the last occurrence in that range wins. `conclusion`, `why`, and
 * `blockers` are required, and a missing or empty one makes the whole block
 * unparseable. `checks`, `notes`, and `deferred` are optional: an absent or
 * empty label maps to null and never makes the block null, so a response in the
 * pre-#214 format stays parseable. A list line anywhere in the block, for
 * example bullets, instead makes the whole block unparseable, so the dispatch
 * layer surfaces the dropped list through `raw` (issues #229, #240, and #249).
 * This covers a label that already holds a value, including the required
 * `blockers`, not only an empty optional one, a bullet with no space after its
 * marker (issue #243), and a list under an earlier occurrence that a later
 * repeat shadows or after the reviewer `Verdict:` line (issue #249), because the
 * scan covers every line, not only the winning last occurrence of each label. A
 * label that indentation or markdown decoration hides also makes the block
 * unparseable, so `raw` carries its value (issue #243).
 * @param {string} response
 * @returns {{ conclusion: string, why: string, blockers: string, checks: string | null, notes: string | null, deferred: string | null } | null}
 */
export function parseReportBlock(response) {
  const block = closingBlock(response);
  if (!block) {
    return null;
  }
  if (block.some((line) => DECORATED_LABEL_LINE.test(line))) {
    return null;
  }
  if (hasDroppedList(block)) {
    return null;
  }
  const report = {};
  for (const [key, label, optional] of REPORT_LABELS) {
    const found = lastLabeled(block, label);
    if (!found) {
      if (optional) {
        report[key] = null;
        continue;
      }
      return null;
    }
    if (found.value === "") {
      if (optional) {
        report[key] = null;
        continue;
      }
      return null;
    }
    report[key] = found.value;
  }
  return report;
}

/**
 * True when the block holds a list line the parser would drop. A label holds
 * one line, so a list anywhere in the block is dropped, including under an
 * earlier occurrence of a label that a later occurrence shadows and after the
 * reviewer `Verdict:` line (issue #249). A thematic break and an emphasis run
 * are not lists.
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasDroppedList(lines) {
  for (const line of lines) {
    if (LIST_LINE.test(line) && !THEMATIC_BREAK.test(line) && !EMPHASIS_LINE.test(line)) {
      return true;
    }
  }
  return false;
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
