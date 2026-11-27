# 0179. Admit an issue whose only open closing reference names another repository

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0178: Mark a succeeded loop that does not deliver its item](0178-mark-a-succeeded-loop-that-does-not-deliver-its-item.md).
The replaced parts are decision 6's clause that the eligibility check keeps excluding an issue by a
closing reference's number whatever repository it names, and the consequence that restates that
over-exclusion. Every other decision, consequence, and alternative stays in force.

## Date

2026-11-28

## Context

The batch eligibility check reads each open pull request's closing references and excludes every
issue whose number one of them names
([ADR 0106](0106-foreground-batch-scheduling.md) decision 6). It builds that set from every
reference number, so a pull request that closes `other/repo#42` also excludes local issue 42.

The delivery check of
[ADR 0178](0178-mark-a-succeeded-loop-that-does-not-deliver-its-item.md) already compares the
reference repository with the batch repository. Decision 6 kept the eligibility check at its
number-only rule, as the safe direction, and left this case out of scope. A foreign reference
therefore still excludes a local issue that no pull request of this repository closes
([issue #2052](https://github.com/andromarces/agent-loops/issues/2052)).

## Decision

1. A closing reference stops excluding its issue only when its repository identity is present,
   splits into owner and name the way the delivery helper splits it, and differs from the batch
   repository by owner and name compared without case.
2. Every other reference keeps the exclusion by number: a missing identity, an identity that does
   not split into two parts, an identity equal to the batch repository, and a failed or missing
   batch repository identity read. An equal identity includes a managed-user owner such as
   `mona-cat_octo`, which the comparison accepts as written.
3. The eligibility caller applies this rule to each closing reference before it adds the number to
   its excluded set. It also adds the body keywords of a pull request whose base is not the default
   branch, and the pull request's commit messages, as before; those already name only this
   repository, or a bare issue number.
4. The comparison reuses the delivery check's identity comparison. It validates no owner or name
   shape and trims no part, so a value is compared as written. A malformed identity that still
   splits into two differing parts names another repository, exactly as the delivery check reads
   it.
5. The delivery check keeps its behavior byte-for-byte: `referenceClosesIssue`, `repositoryParts`,
   `readPullRequestClosingNumbers`, and its `closed` and `unreadable` sets are unchanged. The new
   rule lives in the eligibility caller only.
6. The parent selection rule in `docs/orchestrator-instructions.md` and
   `src/prompts/orchestrator.mjs` is out of scope and stays unchanged.

## Consequences

- An open pull request whose only closing reference names another repository with the same issue
  number no longer excludes the local issue.
- A reference with a missing identity, or one whose identity does not split into two parts, still
  excludes its issue. A failed or missing batch repository identity read also keeps the exclusion.
- A same-repository reference still excludes its issue, including one with a managed-user owner,
  and it keeps the exclusion when another reference of the same pull request names the same number
  in another repository.
- The delivery marker of ADR 0178 reads the same evidence as before, so a loop's partial reasons
  do not change.

## Alternatives

1. **Validate the owner and name shape.** Rejected. Three review rounds of
   [issue #2049](https://github.com/andromarces/agent-loops/issues/2049) showed that a character rule
   either admits a malformed identity or rejects a valid managed-user login such as
   `mona-cat_octo`. The check needs identity equality, not validity.
2. **Compare repositories inside the shared closure read.** Rejected. The delivery check consumes
   the same read, so a change there would change its `closed` and `unreadable` sets. The
   eligibility caller owns the eligibility rule.
3. **Drop the exclusion when an identity is unreadable.** Rejected. That would admit an issue whose
   closing reference names no readable repository, which is the unsafe direction.
4. **Trim an identity before the comparison.** Rejected. The delivery check compares as written, and
   a trimmed value would match where the delivery check finds no match.
5. **Apply the rule to body keywords and commit messages.** Rejected. A body keyword names this
   repository by construction, and a commit message names a bare issue number.

## Links

- [Issue #2052: Admit an issue whose only open closing reference names another repository](https://github.com/andromarces/agent-loops/issues/2052)
- [PR #2054: Admit an issue whose only open closing reference names another repository](https://github.com/andromarces/agent-loops/pull/2054)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0178: Mark a succeeded loop that does not deliver its item](0178-mark-a-succeeded-loop-that-does-not-deliver-its-item.md)
- [Implementation: batch eligibility](../src/batch/eligibility.mjs)
- [Tests: batch eligibility](../tests/batch/eligibility.test.mjs)
- [ADR Index](README.md)
