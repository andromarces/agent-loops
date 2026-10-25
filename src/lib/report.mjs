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

export const REPORT_LABEL_NAMES = REPORT_LABELS.map(([, label]) => label);

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

// An emphasis run at line start, for example `*emphasis* note`. A leading `*`
// is also a spaceless bullet marker (`*item`, issue #243), but a `*` pair whose
// close a letter precedes and a non-word, non-`*` character or end of line
// follows is ordinary prose, so it does not blank the block (issues #259 and
// #264). A letter before the close tells a real emphasis run from a spaceless
// bullet whose later `*` is a wildcard or multiplication (`*glob src/*.mjs`,
// `*use 2* 3`), which would otherwise drop the item with no `raw` signal. The
// letter requirement also keeps a spaceless bullet with a later ` * ` a list.
// The close must not be glued to a following token that carries a letter or an
// ASCII digit, so a spaceless bullet whose later `*` a letter precedes and a
// filename or glob continues (`*file*.mjs`, `*glob src/a*.mjs`) counts as a
// list too (issue #267). The cost is wider than a glued word
// (`*self*-hosted`): any following token that carries a letter or an ASCII digit
// flags as well, for example `*Claude*'s review`, `*emph*—then more`, `*a*/b`,
// `*Note*:x`, and `*emph*.2`. A non-ASCII digit (`*emph*.٢`, `*file*.٢`) carries
// no `\d`, so it does not flag. The cost is not only a reporting loss: a null
// block has no Checks line, so the `--require-accept` gate also refuses.
// `acceptGateReason` in src/role.mjs returns "the accepted review has no Checks
// line", and `isAcceptedReview` in this file returns false. Both
// directions fail closed, but the report loses its text to `raw`, and the
// `acceptGateReason` refusal names the wrong cause.
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
 * pre-#214 format stays parseable. A `- ` or `N. ` list that directly follows a report label
 * line is that label's value, or joins the value the line already holds: the markers drop
 * and the items join with "; " (issues #846, #879, and #915). The reviewer `Verdict:` line is no
 * report label, so a list after it stays dropped. One level of `- ` sub-items, indented to the
 * text column of the item above (two spaces, or three after `1. `), joins into that item with
 * ", " (issues #870 and #915). An indented non-list line directly after an item or its sub-items
 * folds into that item with a space (issue #1082). A prose line with a `- ` list directly under it also folds into the label above
 * it as `<prose>: <items>`, when a blank line separates the prose from that label (issue #898).
 * Any other list line in the block, for example
 * bullets, instead makes the whole block unparseable, so the dispatch
 * layer surfaces the dropped list through `raw` (issues #229, #240, and #249).
 * This covers a list outside any label, a list that a non-list line or a blank
 * line separates from its label, a bullet with no space after its
 * marker even under an empty label (issue #243), a `*` or `+` bullet, an ordered item, an indented bullet that is not one nested level, and a list under an earlier occurrence that a later
 * repeat shadows or after the reviewer `Verdict:` line (issue #249), because the
 * scan covers every line, not only the winning last occurrence of each label. A
 * label that indentation or markdown decoration hides also makes the block
 * unparseable, so `raw` carries its value (issue #243). A `- ` item or sub-item that opens with a
 * bold label name, for example `- **Checks:** ran`, is item text when it folds into a label's list
 * run (issue #1006); the same line outside a run still blanks the block, because the decorated-label
 * check runs again on the folded lines. Any other decorated form blanks the block, folded or not.
 * @param {string} response
 * @returns {{ conclusion: string, why: string, blockers: string, checks: string | null, notes: string | null, deferred: string | null } | null}
 */
export function parseReportBlock(response) {
  const block = closingBlock(response);
  if (!block) {
    return null;
  }
  if (block.some((line) => DECORATED_LABEL_LINE.test(line) && !BOLD_DASH_ITEM.test(line))) {
    return null;
  }
  const lines = foldEmptyLabelLists(block);
  if (!lines || lines.some((line) => DECORATED_LABEL_LINE.test(line)) || hasDroppedList(lines)) {
    return null;
  }
  const report = {};
  for (const [key, label, optional] of REPORT_LABELS) {
    const found = lastLabeled(lines, label);
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

// A report label line, empty or with a value, for example `Notes:` or `Notes: none`. The reviewer
// `Verdict:` line is no report label, so a list after it never folds.
const LABEL_LINE = new RegExp(`^(?:${REPORT_LABEL_NAMES.join("|")}):`, "i");

// The list shapes that fold under a label: a `-` or an ordered `N.` marker at column 0, exactly
// one ASCII space (U+0020), then an item (issue #915 added the ordered marker). Any other separator
// (a tab, a nonbreaking space, a second space), a spaceless bullet, an indented bullet, a `*` or
// `+` bullet, and an `N)` item stay lists that hasDroppedList rejects.
const FOLDABLE_ITEM = /^(?:- |\d+\. )(?=\S)/;

// The item shape that folds under a prose heading (issue #898): a dash item only. An ordered item
// after a prose line stays a list that hasDroppedList rejects.
const HEADING_ITEM = /^- (?=\S)/;

// The one nesting level that folds into its parent item: ASCII spaces up to the column where the
// parent item text starts (two after `- `, three after `1. `), a `-`, exactly one ASCII space, then
// an item (issue #870). Another indent width, a tab, another marker, and a second nesting level
// stay lists that hasDroppedList rejects.
const foldableSubitem = (marker) => new RegExp(`^ {${marker.length}}- (?=\\S)`);

/** True when the line is a list item. A thematic break and an emphasis run are not lists. */
function isListLine(line) {
  return LIST_LINE.test(line) && !THEMATIC_BREAK.test(line) && !EMPHASIS_LINE.test(line);
}

/** True when the line is an item that matches `pattern` and may fold into a label's value. */
function isFoldableItem(line, pattern) {
  return pattern.test(line) && isListLine(line);
}

/** True when the line is a `- ` item indented to the text column of its parent item `marker`. */
function isFoldableSubitem(line, marker) {
  return foldableSubitem(marker).test(line) && isListLine(line);
}

/**
 * True when the line is an indented prose line that continues the item above (issue #1082): ASCII
 * spaces or tabs, then text that is neither a list nor a thematic break. An indented list line is
 * no continuation, so hasDroppedList still refuses it.
 */
function isContinuationLine(line) {
  return /^[ \t]+\S/.test(line) && !isListLine(line) && !THEMATIC_BREAK.test(line);
}

/**
 * The items that match `pattern` and directly follow line `start`, and the last line used. Each
 * item absorbs its sub-items, joined with ", ", then the continuation lines after them, joined with
 * a space like a Markdown lazy continuation.
 */
function takeItems(lines, start, pattern) {
  let i = start;
  const items = [];
  while (i + 1 < lines.length && isFoldableItem(lines[i + 1], pattern)) {
    const [marker] = lines[++i].match(pattern);
    const parts = [lines[i].slice(marker.length).trim()];
    while (i + 1 < lines.length && isFoldableSubitem(lines[i + 1], marker)) {
      parts.push(lines[++i].trim().slice(2).trim());
    }
    const continuation = [];
    while (i + 1 < lines.length && isContinuationLine(lines[i + 1])) {
      continuation.push(lines[++i].trim());
    }
    items.push([parts.join(", "), ...continuation].join(" "));
  }
  return { items, end: i };
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

/**
 * Folds an unbroken run of `- ` items that directly follows a report label line into that label's
 * value: markers stripped, items joined with "; ", and joined to a value the label line already
 * holds with "; " too (issues #846 and #879). Each
 * item absorbs the run of `  - ` sub-items right after it, joined to it with ", " (issue #870).
 * A prose line with a `- ` run (never an ordered run) directly under it folds into the preceding report label as
 * `<prose>: <items>` when one or more blank lines separate that prose from the label line (issue
 * #898). Every other list shape stays in the result for hasDroppedList. Returns null when a later
 * line repeats a folded label, because the repeat shadows the folded list and it would drop with
 * no `raw` signal.
 * @param {string[]} lines
 * @returns {string[] | null}
 */
function foldEmptyLabelLists(lines) {
  const out = [];
  const folded = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LABEL_LINE.test(line)) {
      const { items, end } = takeItems(lines, i, FOLDABLE_ITEM);
      if (items.length > 0) {
        const label = line.trim();
        folded.push({ label: label.slice(0, label.indexOf(":")), index: out.length });
        out.push(appendToLabel(label, items.join("; ")));
        i = end;
        continue;
      }
    } else if (isPlainProseLine(line) && out.length > 0 && out.at(-1).trim() === "") {
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
/** The first failing acceptance check, "verdict" or "checks", or null when the review is accepted. */
export function acceptanceFailure(response) {
  if (parseVerdict(response) !== "accept") {
    return "verdict";
  }
  return parseReportBlock(response)?.checks ? null : "checks";
}

export function isAcceptedReview(response) {
  return acceptanceFailure(response) === null;
}
