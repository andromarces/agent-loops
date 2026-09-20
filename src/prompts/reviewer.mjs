import { reportBlock } from "./report.mjs";

// Same closing block as reportBlock, with the verdict line inside it so the
// model treats it as part of the mandatory block, not an optional extra.
const reviewerReportBlock = `${reportBlock}
Verdict: accept or reject. One word, nothing else on the line.`;

export function reviewerPrompt(prompt) {
  return `
Do not implement, fix, edit, or change any file. Review, assess, and verify only. Live probes and read-only queries are authorized.

${reviewerReportBlock}

Instructions:
${prompt}
`.trim();
}
