// The reviewer and consolidation prompts of an audit, and the parsers for their replies.
import { escapeLineSeparators } from "../prompts/escape.mjs";

const MAX_TITLE_LENGTH = 256;
const MAX_FINDINGS = 100;

export function parseFindings(response) {
  if (typeof response !== "string") return null;
  const candidates = [];
  for (const match of response.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  const trimmed = response.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let value;
    try {
      value = JSON.parse(candidates[index]);
    } catch {
      continue;
    }
    if (value !== null && typeof value === "object" && Array.isArray(value.findings)) {
      const findings = normalizeFindings(value.findings);
      if (findings !== null) return findings;
    }
  }
  return null;
}

function normalizeFindings(raw) {
  if (raw.length > MAX_FINDINGS) return null;
  const findings = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.title !== "string" || typeof entry.body !== "string") return null;
    const title = entry.title.trim();
    const body = entry.body.trim();
    if (title === "" || body === "" || title.length > MAX_TITLE_LENGTH) return null;
    const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
    let existingIssue = null;
    if (entry.existingIssue !== undefined && entry.existingIssue !== null) {
      if (!Number.isSafeInteger(entry.existingIssue) || entry.existingIssue < 1) return null;
      existingIssue = entry.existingIssue;
    }
    findings.push({ title, body, evidence, existingIssue });
  }
  return findings;
}

/** Validates a consolidation against the frozen issue list, or null when it is not usable. */
export function validateConsolidation(findings, issues) {
  if (findings === null) return null;
  const numbers = new Set(issues.map((issue) => issue.number));
  const titles = new Set();
  const out = [];
  for (const finding of findings) {
    const key = finding.title.trim().toLowerCase();
    if (titles.has(key)) return null;
    titles.add(key);
    if (finding.existingIssue !== null && !numbers.has(finding.existingIssue)) return null;
    out.push({ ...finding, title: finding.title.trim() });
  }
  return out;
}
export function auditPrompt({ revision, base, kind, focus = null }) {
  const focusText = typeof focus === "string" && focus.trim() !== "" ? focus.trim() : null;
  const goal =
    focusText === null
      ? "Report any item someone can act on, defects included. Do not report praise or general observations."
      : `The only goal of this audit is: ${focusText}`;
  return escapeLineSeparators(`You are reviewer ${kind} of one read-only project audit. Audit revision ${revision} of the base branch ${base} in this work tree.

Do not change a tracked file or an untracked file that Git does not ignore, and do not change Git state. Do not write to GitHub or any remote: do not create, edit, comment on, label, or close an issue or a pull request, and do not push. Read-only queries are allowed. ${goal}

Return exactly one fenced json code block with this document:
{"findings":[{"title":"...","body":"...","evidence":"..."}]}

Rules for the document:
- One finding per item. Do not repeat a finding under two titles.
- The title is a concise issue title of at most 256 characters.
- The body states the item, where it occurs, and why someone can act on it.
- The evidence names the files, symbols, inputs, or commands that support the finding.
- If the revision has no item to report, return an empty findings array.
- Put the document before any other closing text, and include no other fenced json block.`);
}

export function consolidationPrompt({ auditId, revision, findings, issues, focus = null }) {
  const focusText = typeof focus === "string" && focus.trim() !== "" ? focus.trim() : null;
  const supplied = findings.map(({ reviewer, finding }) => ({
    reviewer,
    title: finding.title,
    body: finding.body,
    evidence: finding.evidence,
  }));
  const issueList = issues.map(({ number, title, state }) => ({ number, title, state }));
  return escapeLineSeparators(`You are the consolidation worker of audit run ${auditId} on revision ${revision}. Merge the reviewer findings into one issue set.

The operator focus was: ${focusText === null ? "none supplied" : focusText}

Reviewer findings, supplied by the runtime as JSON:
${JSON.stringify(supplied, null, 2)}

Open and closed issues of the repository, supplied by the runtime as JSON:
${JSON.stringify(issueList, null, 2)}

Rules:
- Merge findings that describe the same item. One item becomes one finding.
- Keep every item someone can act on that any reviewer reported, even an item outside the focus. Do not drop a finding because it is not a defect.
- Compare every finding with every supplied issue, open or closed. When an issue already covers it, set existingIssue to that number. Otherwise set existingIssue to null.
- Never create, edit, comment on, label, or close an issue yourself. The runtime makes every remote write.
- Keep an issue title at most 256 characters, and state the item, its location, and why someone can act on it in the body.

Return exactly one fenced json code block with this document:
{"findings":[{"title":"...","body":"...","evidence":"...","existingIssue":12}]}

Use null for existingIssue when no supplied issue covers the finding, and include no other fenced json block.`);
}
