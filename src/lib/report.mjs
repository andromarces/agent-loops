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

// An accept counts only with a Checks line in the closing block, matching the
// parent rule the prompt states (#217) and the interactive --require-accept gate
// (issue #218). An accept without a Checks line is treated as not accepted.
export function isAcceptedReview(response) {
  return parseVerdict(response) === "accept" && Boolean(parseReportBlock(response)?.checks);
}
