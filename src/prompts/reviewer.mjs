import { reportBlock } from "./report.mjs";

// Same closing block as reportBlock, with the verdict line inside it so the
// model treats it as part of the mandatory block, not an optional extra. The
// block already carries the Checks line since issue #310, so the reviewer does
// not repeat it, and the reviewer Checks line stays the only one a gate reads.
const reviewerReportBlock = `${reportBlock}
Verdict: accept or reject. One word, nothing else on the line.`;

// Fixed review scope every reviewer turn carries, so a parent prompt that
// restates the spec does not hide a weakened guard or contract (issue #216).
const reviewerRules = `Review scope, in addition to the task below:
- Trace each changed input, flag, or code path through the existing validators and guards that consume it.
- Report a change that weakens an existing guard or documented contract as a blocker, unless the task explicitly approves that change.
- Explicit approval names the guard or the contract. A general requirement that weakens a guard as a side effect is not approval.
- For an approved contract change, do not reject for the change itself. Name the affected guard or contract in the report, and check that the docs and tests change with it.`;

export function reviewerPrompt(prompt) {
  return `
Do not implement, fix, edit, or change any file. Review, assess, and verify only. Live probes and read-only queries are authorized.

${reviewerRules}

${reviewerReportBlock}

Instructions:
${prompt}
`.trim();
}
