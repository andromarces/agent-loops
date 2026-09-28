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
- For an approved contract change, do not reject for the change itself. Name the affected guard or contract in the report, and check that the docs and tests change with it.
- When the task names a pull request, read the required checks for the reviewed head with gh pr checks <pr> --required. The command reads status only. It changes nothing. The rules below it apply only then.
  - Report a failing required check as a blocker. Exit code 8 means a check is pending: report it in Checks, not as a blocker.
  - Exit code 1 covers a failing check, a repository with no required check, and a read error. Report a blocker only when the output lists a failing required check. Report any other exit 1 as unresolved in Checks.
  - The command omits a check that has not started, so a read pass covers only the listed checks.
  - The read reflects the PR head on GitHub. When that head differs from the local reviewed head, report the mismatch in Checks.
  - When gh cannot read the checks, report the status as unresolved in Checks. Report a pass only when the read shows one.`;

// The status a declared-PR run read for the PR head, as two lines inside the
// required-check group. The reviewer keeps its own read as the fallback, so a
// supplied status never removes the read it can make on its own (issue #320).
function runtimeReadLines(prChecks) {
  return [
    `  - This run read the required checks for PR ${prChecks.pr} before this turn: ${prChecks.summary}. Report that status and do not read it again.`,
    "  - Keep your own read as the fallback. Prefer it when the supplied status is unresolved, and report any difference between your read and the supplied status in Checks.",
  ];
}

export function reviewerPrompt(prompt, prChecks = null) {
  const supplied = prChecks === null ? "" : `\n${runtimeReadLines(prChecks).join("\n")}`;
  return `
Do not implement, fix, edit, or change any file. Review, assess, and verify only. Live probes and read-only queries are authorized.

${reviewerRules}${supplied}

${reviewerReportBlock}

Instructions:
${prompt}
`.trim();
}
