# 0048. Bind the wait-checks states to the PR head commit

## Status

accepted

Partially supersedes [ADR 0010: A runtime-owned bound on the interactive required-check wait](0010-runtime-owned-required-check-wait-bound.md). This ADR replaces decision 2 (the envelope), decision 8 (the `gh pr checks` outcome decides alone), and decision 12 (the empty required list) of ADR 0010. Every other decision of ADR 0010 holds: the operation, the bound and its default, the child-exit ceiling and `childExitUnconfirmed`, work-tree validation inside the bound, the item validation, the status-only rule, the `--cwd` rule, and the instruction wording.

## Date

2026-10-19

## Context

`wait-checks` read `gh pr checks <pr>`, which queries by PR identity and names no commit. A wait that started before GitHub moved the PR head to a new commit, as right after a worker push or `gh pr update-branch`, read the passing checks of the previous head and settled on them. A head that moved away and back, or a stale view, did the same (issue #961). The envelope said nothing about which commit its checks described, so the parent could not tell.

The runtime-supplied required-check status (ADR 0011, ADR 0024) already reads the check runs and commit statuses by commit SHA and resolves the required contexts from the gate sources. It cannot serve the wait as it is: it judges the evaluated commit (the test merge commit when that carries a check), returns names only, and withholds a pass on a dirty work tree or a merge state, which a wait has no reason to do.

## Decision

1. Each poll reads the PR head and base with `gh pr view <pr> --json headRefOid,baseRefName`, runs `gh pr checks` for its exit-code outcome, and takes every check state from the check runs and commit statuses of the head SHA (`commits/{sha}/check-runs` and `/status`, every page, through the readers of the `--require-ci` gate). `gh pr checks` supplies no state.
2. The envelope is `{ "status", "pr", "timedOut", "head", "checks" }`, with `noRequiredChecks`, `childExitUnconfirmed`, and `prFailures` present only when they apply. `head` is the commit that `checks` describe, or `null` when no state was read for a commit. `checks` holds only states read for `head`.
3. `--head <sha>` (wait-checks only, a full lowercase commit SHA) keeps the wait running while the PR head is another commit. A wait that reaches the bound first returns `timedOut: true`, `head: null`, and an empty `checks`, never a pass.
4. The required wait judges each required context as the gate does, with the gate's own matching and verdict (`matchingEntries`, `evaluateContext`): an app-qualified context is satisfied only by a check run of that app, and a context with no entry on the commit is pending. The `--all` wait judges the latest check run of each name and app and the latest commit status of each context.
5. The required wait resolves its contexts with `requiredContexts` and the rule of the supplied status, `requiredResolutionRefusal`, and also refuses any source that settled nothing. A ruleset or protection source with no usable reply, a source reply that is not valid JSON, and a failed read of the required names exit 1 with `status: "error"` before any state is judged, because such a source can hold a required check or an app qualifier the wait never saw. A caller whose credential cannot read the ruleset or classic-protection sources therefore gets an error from the required wait and uses `--all`. The `--all` wait reads no source.
6. The commit states only make the outcome stricter. A pass needs both the `gh pr checks` outcome and every state of the commit to pass, so exit 8 and the no-checks-yet reply keep the wait running until the bound. A failing state of the commit settles the wait.
7. A failure that `gh pr checks` lists settles the wait whatever the commit shows. That evidence is PR-level and is not pinned to a commit, so it is reported in `prFailures`, apart from `checks`, and never reads as a state of `head`. A parent never records a pass from an envelope that carries `prFailures`. The failure survives a bound that a later read reaches (`timedOut: true` with `prFailures`) and a commit or source read that fails (`head: null`, empty `checks`).
8. `childExitUnconfirmed` covers every `gh` child of a poll, including a sibling read that the first failure left running to the ceiling, and it rides on every envelope, settled, timed out, or error.

## Consequences

- A result never describes a commit other than the one it names, even when the PR head moves during the wait. The PR can still have moved on by the time the wait returns, because the head is read once at the start of the poll, so the parent compares `head` with the commit it expects.
- The required wait costs more reads per poll: the head, the checks, the repository, the ruleset and protection sources, the names, and the commit reads.
- A credential without access to the ruleset or protection sources cannot use the required wait. This is the fail-closed price of keeping app-qualified matching.
- A check that is required but that no read of the PR lists yet is absent, as before (ADR 0010, decision 12, for the part that remains).
- A parent reads `prFailures` besides `checks`. `checks` alone is no verdict while `prFailures` is present.

Live verification (issue #710): running.

## Alternatives

1. **Use `readRequiredChecks` directly**: rejected. It judges the evaluated commit rather than the head, returns names only, withholds a pass on the clean-tree and merge-state rules, has its own timeout, and has no `--all` or `noRequiredChecks`. The wait shares its source-resolution rule instead.
2. **Bracket `gh pr checks` with two head reads**: rejected after review. Two equal head reads do not bind the checks to that head, because a head that moves away and back, or a stale view, leaves `gh pr checks` answering for another commit.
3. **Copy a listed failure into `checks`**: rejected after review. `checks` would then label a PR-level failure of another commit as a state of `head`.
4. **Judge unreadable sources by name**: rejected after review. An unreadable source can hold an app qualifier or a required check, so a pass from it is not a pass.
5. **Drop the failure that `gh pr checks` lists when the commit passes**: rejected. A listed failure must settle the wait, and a pass the commit shows must not hide it.

## Authors

Andro Marces

## Links

- [Issue #961: Name and pin the PR head that a wait-checks result describes](https://github.com/andromarces/agent-loops/issues/961)
- [PR #968](https://github.com/andromarces/agent-loops/pull/968)
- Implementation: `waitChecks` in `src/lib/check-wait.mjs`, `requiredResolutionRefusal`, `matchingEntries`, and `evaluateContext` in `src/lib/ci-gate.mjs`, the `wait-checks` operation in `src/role.mjs`, the error envelope in `src/role-envelope.mjs`; tests in `tests/lib/check-wait.test.mjs` and `tests/role.wait-checks.test.mjs`; documented in `docs/orchestrator-instructions.md` and [Interactive child dispatch](../docs/reference/role.md#interactive-child-dispatch-agent-loop-role)
- [ADR 0010: A runtime-owned bound on the interactive required-check wait](0010-runtime-owned-required-check-wait-bound.md)
- [ADR 0024: Supply the required-check status to the reviewer for every run that names a PR](0024-supply-the-required-check-status-for-a-named-pr.md)
- [ADR Index](README.md)
