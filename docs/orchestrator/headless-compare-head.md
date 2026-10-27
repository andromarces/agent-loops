# Headless compare-head and undeclared PR

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a headless run passes `--compare-head`, when a run has no usable required-check source, and when a headless run finishes with a worker-opened PR.

A headless run on a repository whose required-check sources are unreadable, for
example a private repository on the GitHub Free plan (#301), passes
`--compare-head <pr>` for a PR that exists at start (#1104). It is the headless form of
the interactive `--compare-head` in [Finish output](../orchestrator-instructions.md#finish-output) and keeps its contract. At finish, the
runtime reads the PR head and state and refuses unless the PR is open, it equals the
reviewed head, and the reviewed tree is clean. It reads no required-check source and claims no check
result, and it does not evaluate the merge state. A pass emits a `head-compare`
transcript event and the run exits `0`, distinct from `unresolvedCompare` and its
exit `4`. The command refuses the flag with `--pr`, `--require-ci`, and
`--mode review-only`, and a finish that also sets `unresolvedCompare` is refused
before any GitHub read. A continuation of a declared PR refuses the flag before any
transcript write. The transcript records the flag, but a continuation does not
restore it: each invocation selects `--compare-head` again, as it selects
`--require-ci`, and omitting it on a continuation disables the runtime compare and
leaves the marker path.
A worker-opened PR is never declared in such a run, because the flag names the PR at
start. A run without the flag needs none for a PR that the worker opens (#1111, ADR
0053): the runtime refuses to declare it, records a `pr-undeclared` event, and
applies the same compare at finish. A finish with `unresolvedCompare` is refused for
it, and a closed or merged PR refuses the finish even when its head is unchanged. A continuation does not restore the undeclared PR and resolves it again after its
own worker turn, and a continuation with no worker turn keeps the marker path.
