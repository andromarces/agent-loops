# 0052. Verify the PR head in a headless run without the required-check gate

## Status

accepted

Partially supersedes [ADR 0051: Record a verified PR-head compare without the required-check gate](0051-record-a-verified-pr-head-compare-without-the-required-check-gate.md). This ADR replaces decision 5 (interactive only) and alternative 3 (add a headless flag, deferred). Decisions 1 to 4 of ADR 0051 hold.

## Date

2026-10-26

## Context

ADR 0051 let an interactive run record a verified PR-head compare on a repository whose required-check sources settle nothing, for example a private repository on the GitHub Free plan (#301). The headless `agent-loop` command had no such input. On the same repository `--pr` is refused at start (#1092), a worker-opened PR stays undeclared (#1097), and the run ends only with `unresolvedCompare` and exit 4, even when the PR head equals the reviewed head (issue #1104).

## Decision

1. **Input.** `agent-loop --compare-head <pr>` applies the ADR 0051 compare at each finish, through the same `checkPrHead`. It refuses unless the PR head equals the reviewed head and the reviewed tree is clean. It reads no required-check source, evaluates no merge state, and claims no check result.
2. **Record.** A passing finish emits a `head-compare` transcript event, reports `headCompare: "verified"` from the loop, and exits 0. `unresolvedCompare` keeps its event and exit 4, so the two outcomes stay distinct.
3. **Exclusion.** The command refuses the flag with `--pr`, `--require-ci`, and `--mode review-only` before the run starts. The runtime refuses it with `--pr`, `--require-ci`, and a continuation of a declared PR. A finish that also sets `unresolvedCompare` is refused before any GitHub read, as ADR 0051 decision 4 requires. A continuation of a declared PR is refused before any transcript write or child turn, in the check that refuses a changed `--pr` or `--require-ci`.
4. **No declaration.** A run with the input declares no worker-opened PR. The operator chose the compare because the gate cannot run, so a declared PR would impose a gate that refuses every finish.
5. **Continuation.** The input is a run input of each invocation, like `--require-ci`: the transcript records it in `options.compareHead`, and a continuation does not restore it. Each invocation selects it again. A continuation of a run that had no declared PR passes it again or passes another PR number. Omitting it on a continuation disables the runtime compare and leaves the marker path.
6. **Scope.** The input names the PR at start. A PR that a worker opens in a run with no such input stays undeclared with the marker path, as ADR 0043 and #1097 state. The runtime does not apply the compare to it.

## Consequences

- A headless run for an existing PR on an unreadable-source repository records a matched head apart from an unreadable one.
- The compare is not a pass on the checks. The prompt, the help, and the docs state that `verified` still carries what the checks showed.
- The merge state is not evaluated, as in ADR 0051.
- A PR that the worker opens on such a repository still ends with `unresolvedCompare`.

## Alternatives

1. **Apply the compare to the undeclared worker-opened PR**: deferred. It needs the resolver to surface the PR number of a refused declaration, a new transcript state for a PR the run did not declare, and an automatic claim without an operator choice. No issue shows the need yet.
2. **Relax `--require-ci` on an unreadable source**: rejected, as in ADR 0051. The gate fails closed on purpose (ADR 0012).

## Authors

Andro Marces

## Links

- [Issue #1104](https://github.com/andromarces/agent-loops/issues/1104)
- [Pull request #1110](https://github.com/andromarces/agent-loops/pull/1110)
- Supersedes (partially): [ADR 0051](0051-record-a-verified-pr-head-compare-without-the-required-check-gate.md)
- Related: #301, #1092, #1097, [ADR 0043](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md), [ADR 0045](0045-gate-the-finish-on-the-pr-that-the-headless-runtime-declares.md)
- Implementation: `--compare-head` in `src/cli.mjs`, `headCompareGate` in `src/runtime.mjs`, `checkPrHead` in `src/lib/ci-gate.mjs`; documented in `docs/orchestrator-instructions.md`, `docs/orchestrator/pr-declaration.md`, and `docs/reference/usage.md`
- [ADR Index](README.md)
