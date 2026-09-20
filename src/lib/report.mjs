// Parses the closing block that reportBlock (src/prompts/report.mjs) requires
// from every child turn, plus the reviewer Verdict line. Both parse only the
// final block, which starts at the last `Conclusion:` line, so labels or
// verdicts in earlier prose can never produce a verdict.

const REPORT_LABELS = [
  ["conclusion", "Conclusion"],
  ["why", "Why"],
  ["blockers", "Blockers"],
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
 * Extracts the closing block as `{ conclusion, why, blockers }`. Each label is
 * matched case-insensitively at line start inside the closing block only; the
 * last occurrence in that range wins. Returns null when the block or any of
 * the three labels is missing.
 * @param {string} response
 * @returns {{ conclusion: string, why: string, blockers: string } | null}
 */
export function parseReportBlock(response) {
  const block = closingBlock(response);
  if (!block) {
    return null;
  }
  const report = {};
  for (const [key, label] of REPORT_LABELS) {
    const match = lastLabeledLine(block, label);
    if (!match) {
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
