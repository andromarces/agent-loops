# 0051. Record a verified PR-head compare without the required-check gate

## Status

partially-superseded

Superseded by [ADR 0052: Verify the PR head in a headless run without the required-check gate](0052-verify-the-pr-head-in-a-headless-run-without-the-required-check-gate.md). ADR 0052 gives the headless `agent-loop` command a `--compare-head <pr>` input, so decision 5 (interactive only) and alternative 3 (add a headless flag) no longer apply. Decisions 1 to 4 remain in force.

## Date

2026-10-26

## Context

ADR 0009 and ADR 0045 end a PR run through the `--require-ci` gate, which resolves the PR head and reads the required checks. On a repository whose required-check sources settle nothing, for example a private repository on the GitHub Free plan (#301), the gate refuses every finish. Such a run declares no PR and finishes with `unresolvedCompare`. The interactive parent then compares the PR head with `reviewed.head` itself, and a run whose head matched leaves the same envelope and state as a run whose head could not be read (issue #1098).

## Decision

1. **Flag.** `agent-loop role finish --compare-head <pr>` reads the PR head with one `gh pr view` and refuses unless it equals `reviewed.head` and the reviewed tree is clean. Both refusals use the wording of the gate.
2. **No check claim.** The compare reads no required-check source or check result, and claims none. The PR read returns the merge state, which the compare does not evaluate.
3. **Record.** A passing compare adds `"headCompare": "verified"` to the envelope and the state file. The value differs from `unresolvedCompare`, which records that no one resolved the head.
4. **Exclusion.** The flag is refused beside `--require-ci`, beside `unresolvedCompare`, and for a run that declares a PR, which still needs its gate. It is finish-only and refused in `review-only`. The refusals run before any GitHub read.
5. **Interactive only.** The headless `agent-loop` command takes no such flag, because its finish action carries the parent's own compare.

## Consequences

- A reader tells a runtime-verified head from an unresolved one, on a repository where the gate cannot run.
- `headCompare` is no pass on the checks. The `verified` text and the reviewer `Checks` line state them.
- The merge state is not evaluated, so a PR that is behind its base or blocked still finishes. The gate stays the route that enforces that.
- An omitted flag keeps the accepted gap of issue #286.

## Alternatives

1. **Let the parent keep the marker only**: rejected. It cannot record a compare that the parent resolved.
2. **Relax `--require-ci` on an unreadable source**: rejected. The gate fails closed on purpose (ADR 0012).
3. **Add a headless flag**: deferred. A headless run has no repository on which this gap was observed.

## Authors

Andro Marces

## Links

- [Issue #1098](https://github.com/andromarces/agent-loops/issues/1098)
- [Pull request #1101](https://github.com/andromarces/agent-loops/pull/1101)
- Partially superseded by [ADR 0052](0052-verify-the-pr-head-in-a-headless-run-without-the-required-check-gate.md), [pull request #1110](https://github.com/andromarces/agent-loops/pull/1110)
- Related: #301, #281, #286, [ADR 0009](0009-declare-a-pr-input-on-every-run.md), [ADR 0012](0012-establish-the-absence-of-a-required-check.md), [ADR 0045](0045-gate-the-finish-on-the-pr-that-the-headless-runtime-declares.md)
- Implementation: `checkPrHead` and `compareHeadConflict` in `src/lib/ci-gate.mjs`, the flag in `src/role.mjs`; documented in `docs/orchestrator-instructions.md`, `docs/orchestrator/pr-declaration.md`, and `docs/reference/role.md`
- [ADR Index](README.md)
