# 0132. Count a head on the base branch as pushed proof

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md).
These parts are replaced:

- Decision 13's pushed-proof bullet, which names the remote-branch proof and the merged
  pull-request proof only.
- Decision 13's sentence that a local commit neither proof covers is reported as
  `unpushed-local-work`.
- Acceptance check 13's first sentence, which states that a pushed successful work tree is
  removed.

Every other decision, consequence, and acceptance check of ADR 0106, as later amended, stays in
force.

## Date

2026-11-12

## Context

A batch loop whose task ends with no code change has no branch on the remote and no pull request.
Its head stays on the commit it was created from, `origin/<base>`, so removal loses no commit.
`cleanupLoop` read the remote branch and then the pull request, so both proofs failed. It kept
the work tree with reason `the loop has no pushed proof (unpushed)`.

A batch of four issues on 12 Nov 2026 ended two loops with an issue edit and no pull request.
Both succeeded. Each work tree was clean, its head equalled `origin/main`, and
`git log origin/main..HEAD` was empty. The owner removed both work trees by hand.

## Decision

1. **Third proof.** In `cleanupLoop`, after the remote-branch proof and before the
   pull-request proof, fetch `origin/<base>` with the same fetch helper that reads the loop
   branch. The head is proved pushed when it is an ancestor of the fetched base head. The proof
   runs after the identity, path, registration, lock, branch, cleanliness, and claim checks.
2. **Failed read.** A failed or empty base read returns a keep with reason
   `the base branch read failed (unpushed)`. It never counts as proof, and it does not fall
   through to the pull-request proof.
3. **Removal.** A removal through this proof runs the same `git worktree remove --force`,
   link-safe remainder delete, and claim release as every other removal.
4. **Unchanged.** Every earlier check keeps its order, its reason text, and its Git arguments.

## Consequences

- A succeeded loop with a clean work tree whose head is on `origin/<base>` has its work tree
  removed. It has no remote branch and no pull request.
- A loop with a local commit that is on no remote ref keeps its work tree.
- A loop with a remote branch runs one extra `git fetch origin <base>` only when that branch
  does not prove the push.
- A repository whose `origin/<base>` cannot be read keeps every such work tree with the base
  read reason. That includes a loop with a merged pull request.

## Alternatives

1. **Treat the absence of a pull request as proof.** Rejected. A loop with no code change has no
   pull request, and so does a loop with unpushed local work.
2. **Compare the head with the local base branch.** Rejected. A stale local base ref can sit
   behind a local commit and make an unpushed head look contained.
3. **Fall through to the pull-request proof on a failed base read.** Rejected. The keep reason
   then does not name the failed read.

## Authors

Andro Marces

## Links

- [Issue #1898: Remove the work tree of a succeeded batch loop whose head is already on the base branch](https://github.com/andromarces/agent-loops/issues/1898)
- [PR #1902](https://github.com/andromarces/agent-loops/pull/1902)
- [ADR 0106 decision 13](0106-foreground-batch-scheduling.md) (pushed-proof bullet and acceptance check 13 replaced)
- Implementation: `cleanupLoop` in `src/batch/cleanup.mjs`
- Tests: `tests/batch/cleanup.test.mjs`
- [ADR Index](README.md)
