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

// A line that opens any label in the closing block, including the reviewer's
// Verdict line. Bounds the search for a list a label would drop.
const LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")}|Verdict):`, "i");

// A report label that indentation or markdown decoration hides from the strict
// match above, for example `**Deferred**: x`, `*Deferred:* x`, `### Deferred: x`,
// `> Deferred: x`, or `  Deferred: x`. Such a value would otherwise be dropped,
// so the whole block is unparseable and `raw` carries the text (issue #243).
// The Verdict label is excluded: a malformed verdict already maps to `unknown`
// and never carries report text.
const DECORATED_LABEL_LINE = new RegExp(
  `^(?!(?:${REPORT_LABEL_NAMES.join("|")}):)\\s*(?:>\\s*|#{1,6}\\s+|[-*+]\\s*|\\d+[.)]\\s+)*[*_\`]{0,2}(?:${REPORT_LABEL_NAMES.join("|")})[*_\`]{0,2}\\s*:`,
  "i",
);

// A list line the parser would drop below a label, for example `- item`,
// `* item`, `1. item`, or the same without the space after the marker
// (`-item`). A run of markers alone, for example `---`, is not a list.
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])(?:\s+\S|[^\s\-*+])/;

// A markdown thematic break, for example `* * *` or `- - -`. It matches the
// list pattern but carries no item, so it does not drop text.
const THEMATIC_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

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
 * pre-#214 format stays parseable. A label followed by a list line, for example
 * bullets, instead makes the whole block unparseable, so the dispatch layer
 * surfaces the dropped list through `raw` (issues #229 and #240); this covers a
 * label that already holds a value, including the required `blockers`, not only
 * an empty optional one. A bullet with no space after its marker counts as a
 * list line, and a label that indentation or markdown decoration hides also
 * makes the block unparseable, so `raw` carries its value (issue #243).
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
    if (hasListAfter(block, found.index)) {
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
 * True when a list line follows `index` before the next label line or the end
 * of the block. Such a list would otherwise be dropped, because a label holds
 * one line and the list below it is never read, and a bullet with no space
 * after the marker counts as a list line (issue #243). A thematic break is not
 * a list.
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function hasListAfter(lines, index) {
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    if (LABEL_LINE.test(line)) {
      return false;
    }
    if (LIST_LINE.test(line) && !THEMATIC_BREAK.test(line)) {
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
