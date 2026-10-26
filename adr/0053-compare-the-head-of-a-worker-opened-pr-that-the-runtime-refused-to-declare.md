# 0053. Compare the head of a worker-opened PR that the runtime refused to declare

## Status

accepted

Partially supersedes [ADR 0052: Verify the PR head in a headless run without the required-check gate](0052-verify-the-pr-head-in-a-headless-run-without-the-required-check-gate.md). This ADR replaces decision 6 (scope) and alternative 1 (apply the compare to the undeclared worker-opened PR, deferred). Decisions 1 to 5 of ADR 0052 hold.

## Date

2026-10-26

## Context

The headless runtime declares the PR that a worker opens and gates the finish on it (ADR 0043, ADR 0045). On a repository whose required-check sources are unreadable, the runtime refuses to declare that PR, because the gate would refuse every finish (#1097). ADR 0052 gave the operator `--compare-head <pr>` for a PR that exists at start, and left a worker-opened PR on the marker path. Such a run could only finish with `unresolvedCompare` and exit 4, and nothing compared the PR head with the reviewed commit (issue #1111).

## Decision

1. **Resolver.** `resolveWorkerPr` returns `undeclaredPr`, the number of the matched PR that the required-check read refused. A head, branch, or remote that moved during the read names no PR, and every other undeclared state names none.
2. **Record.** The runtime emits a `pr-undeclared` transcript event with `pr` and `stepsUsed` after the worker turn, and the next orchestrator prompt carries `undeclaredPr` and a note that states the compare. The event is not a declaration: `declaredPrFromTranscript` ignores it.
3. **Claim.** At finish, the runtime applies the ADR 0052 compare, through the same `checkPrHead`, to the undeclared PR with no operator choice. It refuses unless the PR head equals the reviewed head and the reviewed tree is clean. It reads no required-check source and claims no check result. A pass emits a `head-compare` event, reports `headCompare: "verified"`, and exits 0.
4. **Marker.** A finish that also sets `unresolvedCompare` is refused before any GitHub read, as for `--compare-head`.
5. **Guards unchanged.** A run with `--pr`, `--require-ci`, or `--compare-head` never resolves a worker-opened PR, so it never records one as undeclared. A declared PR still ends through its gate. A later worker turn that declares a PR clears the undeclared PR. A later turn that refuses another PR replaces it.
6. **Continuation.** A continuation does not restore the undeclared PR. It restores a PR from a `pr-declared` record only, so the transcript record of the earlier run carries no compare into the new run. The continuation resolves the worker-opened PR again after its own worker turn, and a continuation with no worker turn keeps the marker path.

## Consequences

- A headless run on an unreadable-source repository, in which the worker opens a PR, records a matched head apart from an unreadable one, with no operator input.
- The compare is not a pass on the checks. The orchestrator prompt and the docs state that `verified` still carries what the checks showed.
- A worker that closes the undeclared PR, or moves its head, makes the finish refuse until the run ends. This fails closed. known-limit: an earlier undeclared PR stays the target when a later worker turn names none.
- The prompt text for a run that finishes through the marker changes only for a worker result that carries `undeclaredPr`.

## Alternatives

1. **Restore the undeclared PR in a continuation**: rejected. The compare reads the PR head against the reviewed state of the current run, so a restored number would claim a PR that no worker turn of the new run opened or confirmed. The continuation resolves it again.
2. **Declare the PR and relax the gate**: rejected, as in ADR 0051. The gate fails closed on purpose (ADR 0012).
3. **Keep the marker path and rely on the parent**: rejected. Issue #1111 shows that nothing compares the PR head in that case.

## Authors

Andro Marces

## Links

- [Issue #1111](https://github.com/andromarces/agent-loops/issues/1111)
- Supersedes (partially): [ADR 0052](0052-verify-the-pr-head-in-a-headless-run-without-the-required-check-gate.md)
- Related: #1097, #1104, [ADR 0043](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md), [ADR 0045](0045-gate-the-finish-on-the-pr-that-the-headless-runtime-declares.md), [ADR 0051](0051-record-a-verified-pr-head-compare-without-the-required-check-gate.md)
- Implementation: `resolveWorkerPr` in `src/lib/worker-pr.mjs`, `runLoop` and `evaluateFinish` in `src/runtime.mjs`, `resultPrompt` in `src/prompts/orchestrator.mjs`; documented in `docs/orchestrator-instructions.md` and `docs/orchestrator/pr-declaration.md`
- [ADR Index](README.md)
