# 0122. Report the open PR of the work tree branch in the worker envelope

## Status

accepted

## Date

2026-11-10

## Context

Step 2 of [Declaring a PR run](../docs/orchestrator/pr-declaration.md) told the parent to read the PR number from the worker report. The report has no PR field. On 2026-11-09, a `work-first` run on Trialfacts/tf-twilio opened PR 175. The worker report named neither the PR number nor its checks. The parent read `gh pr list --head <branch>` itself, outside the allowed status reads.

A worker can push the run branch before its report. The runtime can then read the open PR of that branch from Git and GitHub state. No child text is needed.

## Decision

1. **Worker field.** After a worker turn that ends `ok`, the dispatch reads the open PR of the work tree branch. It adds `workTree.pr: {number, head}` beside `head` and `clean` in the envelope and `lastResult`. A reviewer turn reads no PR.
2. **Branch.** The runtime reads the branch with `git symbolic-ref --short -q HEAD`. A detached head reads no GitHub state and carries no field.
3. **Query.** The read is `gh pr list --head <branch> --state open --json number,headRefOid,isCrossRepository`. It reuses the `gh` dependency of dispatch and the existing bounded read helpers. No dependency is added.
4. **Result.** Exactly one open PR in the work tree repository yields the field. A cross-repository PR is rejected. Zero matches, several matches, a bad number, or a bad head yields no field.
5. **Validation.** `number` is a positive integer. `head` is a full 40-character SHA, stored in lowercase.
6. **Failure.** A nonzero exit, a timeout, a parse failure, or a transport error yields no field. It logs one redacted `warn` line. It changes no turn status and no exit code. A cancel ends the read at once and adds no field.
7. **Head source.** The field reports the head that GitHub returned. It can differ from `workTree.head`, for example before a push. The parent compares the two before it relies on the PR head.
8. **Docs.** The `workTree` bullet of [the orchestrator instructions](../docs/orchestrator-instructions.md) names the field as the PR source. The parent reads the PR number there for `declare-pr`, `wait-checks --pr`, and `finish --compare-head`. Step 2 of the PR declaration reads it in place of the worker report.

## Consequences

- A worker turn that opens a PR gives the parent the PR number and head without free text from the child.
- A run with no open PR, an ambiguous branch, a fork PR, or a failed read keeps its turn status. The parent reads no field and adds no PR source.
- The worker envelope read is one extra `git` read and one extra `gh` read per worker turn. A detached head reads no GitHub state.
- A PR head that moves after the worker push stays visible. The parent compares it with `workTree.head` before a completion decision.
- The headless `agent-loop` loop keeps its own resolver and does not share this field.

## Alternatives

1. **Read the PR number from the worker report.** Not taken. This is the source of the issue. A child can omit the number or name another PR.
2. **Reuse `resolveWorkerPr`.** Not taken. It requires the PR head to equal the local head. The new field must report a PR head that differs before a push.
3. **Add a separate top-level `pr` field.** Not taken. The PR belongs to the work tree state, beside `head` and `clean`.
4. **Fail the turn on a read failure.** Not taken. The PR read is evidence, and a wrong or failed read must not fail work that succeeded.

## Authors

Andro Marces

## Links

- [Issue #1755](https://github.com/andromarces/agent-loops/issues/1755)
- [ADR 0043: Let the headless runtime declare the PR that a worker opens](0043-let-the-headless-runtime-declare-the-pr-that-a-worker-opens.md)
- [ADR 0041: Declare the run PR after init with `role declare-pr`](0041-declare-the-run-pr-after-init-with-declare-pr.md)
- Implementation:
  - Source: `readWorkTreePr` in `src/lib/work-tree-pr.mjs`, `dispatch` in `src/role/dispatch.mjs`
  - Tests: `tests/lib/work-tree-pr.test.mjs`, `tests/role.dispatch.pr.test.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/pr-declaration.md`
- [ADR Index](README.md)
