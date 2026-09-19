// Parses the closing block that reportBlock (src/prompts/report.mjs) requires
// from every child turn, plus the reviewer Verdict line.

const REPORT_LABELS = [
  ["conclusion", "Conclusion"],
  ["why", "Why"],
  ["blockers", "Blockers"],
];

/**
 * Extracts the closing block as `{ conclusion, why, blockers }`. Each label is
 * matched case-insensitively at line start; the last occurrence wins. Returns
 * null when any of the three labels is missing.
 * @param {string} response
 * @returns {{ conclusion: string, why: string, blockers: string } | null}
 */
export function parseReportBlock(response) {
  const report = {};
  for (const [key, label] of REPORT_LABELS) {
    const match = lastLabeledLine(response, label);
    if (!match) {
      return null;
    }
    report[key] = match;
  }
  return report;
}

/**
 * Extracts the reviewer verdict from a `Verdict:` line. Values other than
 * `accept` or `reject` (including a missing or malformed line) map to
 * `unknown`; process success never implies acceptance.
 * @param {string} response
 * @returns {"accept" | "reject" | "unknown"}
 */
export function parseVerdict(response) {
  const line = lastLabeledLine(response, "Verdict");
  if (line) {
    const value = line.toLowerCase();
    if (value === "accept" || value === "reject") {
      return value;
    }
  }
  return "unknown";
}

function lastLabeledLine(text, label) {
  const pattern = new RegExp(`^${label}:\\s*(.*)$`, "im");
  const lines = text.split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      last = match[1].trim();
    }
  }
  return last;
}
