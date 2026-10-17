# 0043. Let the headless runtime declare the PR that a worker opens

## Status

accepted

Partially supersedes [ADR 0041: Declare the run PR after init with `role declare-pr`](0041-declare-the-run-pr-after-init-with-declare-pr.md). ADR 0041 decision 5 leaves the headless loop unchanged. Its alternative 4 rejects a `declare-pr` action for the orchestrator. This ADR keeps that rejection. It adds a runtime-owned declaration for the headless loop. Every other decision of ADR 0041 holds.

## Date

2026-10-17

## Context

The headless loop takes `--pr` and `--require-ci` on one command line before any worker runs. A task such as "address issue N through a PR" has no PR at start, because the worker opens it. Such a run lost the runtime-supplied required-check status (issue #320) and the declared-PR finish rule (issue #302). Without that rule an omitted `unresolvedCompare` marker reads as a verified finish (issue #286). ADR 0041 fixed this for `role` runs only. Issue #919 offered two fixes: the runtime resolves the PR itself, or the docs state that such a task uses `role`.

## Decision

1. **Option 1 of issue #919.** After each worker turn that ends `ok`, a headless run with no `--pr` and no `--require-ci` resolves the PR. The runtime sets the run PR once. The run then behaves as one that passed `--pr`. The reviewer prompts carry the supplied status, and a finish applies the declared-PR rule.
2. **Runtime-owned input.** The resolver reads Git and GitHub state only. It reads the checked-out branch and the URL of the branch remote. It reads the work tree head that the runtime read after the turn. It reads `gh pr list --head <branch> --state open`. A worker report, a reviewer report, a task text, and an orchestrator action never choose or change the PR.
3. **Fail closed.** The runtime declares a PR only when exactly one open PR from that branch exists. Its base repository must be the repository of the branch remote. Its URL must end in its number. Its head commit must equal the work tree head. The branch, the remote repository, and the head must be unchanged after the `gh` read. These states leave the run undeclared: zero matches, several matches, a different head, and a detached head. A PR from a fork and a PR for another base repository do the same. A branch, remote, or head that changes during the read does the same. So do a failed `gh` read, an unparseable reply, and any malformed entry. A later worker turn tries again.
4. **One way, once.** After a declaration, no later turn resolves or changes the PR. A run with `--pr` or `--require-ci` at start never resolves a PR, so its behavior is unchanged.
5. **Finish with no gate.** `--require-ci` is a run input that no turn can supply. A run that declares its PR this way has no `--require-ci`. It refuses every finish through the existing declared-PR rule, so it never ends through the `unresolvedCompare` path. The run ends only through `abort` with the missing gate named in the reason.
6. **Base repository.** `GH_REPO` can point `gh` at another repository, so the check never trusts a `gh` answer for the run repository. The PR URL gives the base repository. The `git` remote of the branch gives the run repository: `branch.<branch>.remote`, or `origin` when none is set. Each must name the same GitHub host, owner, and repository, or the run stays undeclared.
7. **Continuation.** `--continue-from` restores the declared PR from the `pr-declared` events of the earlier transcript. The continued run emits a `pr-declared` event with `restored: true`, so a later continuation keeps it. The declared PR is an init field of the continued run. A `--pr` or `--require-ci` for another PR is refused before any turn, and a flag for the same PR is accepted. `--mode review-only` is refused, as it refuses `--pr` at init.
8. **Malformed record.** A `pr-declared` event with a `pr` that is not a positive integer is refused. So are two different PRs, and a PR that differs from the `--pr` or `--require-ci` of the earlier run. A refusal never reads as no declaration, because that drops the finish rule.
9. **Visibility.** The runtime emits one `pr-declared` event with `pr` and `stepsUsed`. The result prompt of that worker turn carries `declaredPr` and states the finish rule, so the orchestrator knows before it plans a finish.

## Consequences

- A headless task whose worker opens the PR gets the declared-PR finish rule. It gets the supplied check status from the next reviewer turn. A reviewer turn that ran before the declaration read the checks itself.
- A headless run with no PR flag whose worker opens a PR can no longer finish with `unresolvedCompare`. Earlier it ended on exit `4`. Now it ends on exit `1` at finish, or through `abort`.
- A task that must end through a gated finish starts with `--require-ci <n>` for an existing PR, or runs through `role`.
- Each worker turn of an undeclared run costs one `gh pr list` read. A run with no `gh` credential logs a warning and stays undeclared.
- The resolver names one PR for one branch and head. A second PR from the same branch makes the run undeclared and leaves the earlier marker rule in force.
- A repository whose gate cannot read the rulesets (issue #301) still refuses every finish of a declared run.

## Alternatives

1. **Keep the gap and document that such a task uses `role` (option 2 of issue #919).** Not taken. A headless run keeps ending through `unresolvedCompare`, with no supplied status for a PR that exists.
2. **Add `declare-pr` to the headless loop as an orchestrator action.** Rejected, as in ADR 0041. The orchestrator is a child turn, so it picks the PR that gates its own run.
3. **Let the runtime also set `--require-ci` for the resolved PR.** Rejected. The gate is an operator choice with its own failure modes, such as unreadable rulesets, and the resolved PR is not an operator input.
4. **Resolve the PR from the worker report.** Rejected. The report is child text, so a child picks the PR.

## Authors

Andro Marces

## Links

- [Issue #919](https://github.com/andromarces/agent-loops/issues/919)
- Partially supersedes [ADR 0041: Declare the run PR after init with `role declare-pr`](0041-declare-the-run-pr-after-init-with-declare-pr.md)
- [PR #923](https://github.com/andromarces/agent-loops/pull/923)
- Related issues: #286, #302, #320
- Implementation:
  - Source: `resolveWorkerPr` in `src/lib/worker-pr.mjs`, `runLoop` in `src/runtime.mjs`, `declaredPrFromTranscript` in `src/lib/continuation.mjs`
  - Tests: `tests/runtime.declare-pr.test.mjs`, `tests/cli.continue-from.declared-pr.test.mjs`, `tests/lib/continuation.test.mjs`
  - Docs: `docs/orchestrator-instructions.md` (A headless task whose worker opens the PR), `docs/reference/usage.md`
- [ADR Index](README.md)
