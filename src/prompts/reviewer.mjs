import { reportBlock } from "./report.mjs";

// Same closing block as reportBlock, with the verdict line inside it so the
// model treats it as part of the mandatory block, not an optional extra.
const reviewerReportBlock = `${reportBlock}
Checks: the commands that ran and their results, or "none". One line.
Verdict: accept or reject. One word, nothing else on the line.`;

// Fixed review scope every reviewer turn carries, so a parent prompt that
// restates the spec does not hide a weakened guard or contract (issue #216).
const reviewerRules = `Review scope, in addition to the task below:
- Trace each changed input, flag, or code path through the existing validators and guards that consume it.
- Report a change that weakens an existing guard or documented contract as a blocker, unless the task explicitly approves that change.
- Explicit approval names the guard or the contract. A general requirement that weakens a guard as a side effect is not approval.
- For an approved contract change, do not reject for the change itself. Name the affected guard or contract in the report, and check that the docs and tests change with it.
- When the task names a pull request, read the required checks for the reviewed head with gh pr checks <pr> --required. The command reads status only. It changes nothing.
- Report a failing required check as a blocker. Exit code 8 means a check is pending: report it in Checks, not as a blocker.
- Exit code 1 covers a failing check, a repository with no required check, and a read error. Report a blocker only when the output lists a failing required check. Report any other exit 1 as unresolved in Checks.
- The command omits a check that has not started, so a read pass covers only the listed checks.
- The read reflects the PR head on GitHub. When that head differs from the local reviewed head, report the mismatch in Checks.
- When the repository has no required check, report that in Checks.
- When gh cannot read the checks, report the status as unresolved in Checks. Report a pass only when the read shows one.`;

export function reviewerPrompt(prompt) {
  return `
Do not implement, fix, edit, or change any file. Review, assess, and verify only. Live probes and read-only queries are authorized.

${reviewerRules}

${reviewerReportBlock}

Instructions:
${prompt}
`.trim();
}
