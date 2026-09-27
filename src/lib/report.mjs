// Parses the closing block that reportBlock (src/prompts/report.mjs) requires
// from every child turn, plus the reviewer Verdict line. Both parse only the
// final block, which starts at the last `Conclusion:` line, so labels or
// verdicts in earlier prose can never produce a verdict.

const REPORT_LABELS = [
  ["conclusion", "Conclusion", false],
  ["why", "Why", false],
  ["blockers", "Blockers", false],
  ["notes", "Notes", true],
  ["deferred", "Deferred", true],
];

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
 * Extracts the closing block as `{ conclusion, why, blockers, notes, deferred }`.
 * Each label is matched case-insensitively at line start inside the closing
 * block only; the last occurrence in that range wins. `conclusion`, `why`, and
 * `blockers` are required, and a missing or empty one makes the whole block
 * unparseable. `notes` and `deferred` are optional: an absent or empty label
 * maps to null and never makes the block null, so a response in the pre-#214
 * format stays parseable.
 * @param {string} response
 * @returns {{ conclusion: string, why: string, blockers: string, notes: string | null, deferred: string | null } | null}
 */
export function parseReportBlock(response) {
  const block = closingBlock(response);
  if (!block) {
    return null;
  }
  const report = {};
  for (const [key, label, optional] of REPORT_LABELS) {
    const match = lastLabeledLine(block, label);
    if (!match) {
      if (optional) {
        report[key] = null;
        continue;
      }
      return null;
    }
    report[key] = match;
  }
  return report;
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
  const line = block ? lastLabeledLine(block, "Verdict") : null;
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

function lastLabeledLine(lines, label) {
  const pattern = new RegExp(`^${label}:\\s*(.*)$`, "i");
  let last = null;
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      last = match[1].trim();
    }
  }
  return last;
}
