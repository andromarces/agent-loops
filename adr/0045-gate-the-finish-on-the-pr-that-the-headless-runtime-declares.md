# 0045. Gate the finish of a headless run on the PR that its runtime declares

## Status

accepted

Partially supersedes [ADR 0043: Let the headless runtime declare the PR that a worker opens](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md). This ADR replaces decision 5 of ADR 0043 and the finish consequences that follow from it. Every other decision of ADR 0043 holds.

## Date

2026-10-18

## Context

ADR 0043 made a headless run with neither `--pr` nor `--require-ci` declare the PR that its worker opens. `--require-ci` is a run input that only the command line sets, so such a run refused every finish and ended only through `abort`. Before ADR 0043 it ended on exit `4` with the `unresolvedCompare` marker. No headless task whose worker opens a PR could then end through a verified finish (issue #924). Issue #924 offered three options: apply the gate for the declared PR at finish, add an opt-in start flag, or keep the abort-only outcome.

## Decision

1. **Option 1 of issue #924.** A run whose PR the runtime declared (ADR 0043) applies the `--require-ci` gate to that PR at finish, as if it had passed `--require-ci <pr>`. This holds for a PR declared in the run and for a PR restored by `--continue-from`.
2. **Reason.** The runtime resolved the PR from Git and GitHub state, and no child chose it, so the PR is not child input. The gate is the check that ADR 0043 lacked for the run. Option 2 adds a flag that the task author cannot know at start and leaves the default run with no verified finish. Option 3 leaves no verified finish for a headless task whose worker opens a PR.
3. **Same gate.** A finish passes only through the existing `--require-ci` rules: a reviewer turn on the current state, the PR head equal to the reviewed commit, a clean reviewed tree, a merge state that the gate accepts, and every required check passed. A refusal gives one corrective turn, and a failing or pending required check is a refusal that names the check. A `gh` failure is a refusal, not a throw. `unresolvedCompare` is refused, because the gate resolves that compare.
4. **Unchanged for `--pr`.** A run that passes `--pr` with no `--require-ci` still refuses every finish through the missing-gate rule. The operator chose that PR, and the operator can pass the gate flag.
5. **Visibility.** The result prompt of the worker turn that declares the PR states that the runtime gates the finish on that PR. The init prompt of a continued run that restores a PR carries the gate rule.

## Consequences

- A headless task whose worker opens a PR ends through a gated finish after a reviewer accept with passing required checks. A failing or pending required check keeps the finish refused.
- A repository whose gate cannot read the rulesets (issue #301) still refuses every finish of a declared run. A base branch with no required check passes the gate and emits `no-required-checks`.
- A run whose declaration fails stays undeclared and keeps the `unresolvedCompare` marker rule.
- A declared run needs a reviewer turn after the last worker turn before it can finish, and each such turn costs a step.

## Alternatives

1. **Add an opt-in start flag that gates on the PR the runtime declares later (option 2 of issue #924).** Not taken. It adds a flag and leaves the default run with no verified finish.
2. **Keep the abort-only outcome (option 3 of issue #924).** Not taken. No headless task that opens a PR could end through a verified finish.

## Authors

Andro Marces

## Links

- [Issue #924](https://github.com/andromarces/agent-loops/issues/924)
- Partially supersedes [ADR 0043](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md)
- [Issue #919](https://github.com/andromarces/agent-loops/issues/919)
- Implementation:
  - Source: `runLoop` in `src/runtime.mjs`, `declaredPrNote` in `src/prompts/orchestrator.mjs`
  - Tests: `tests/runtime.declare-pr.test.mjs`
  - Docs: `docs/orchestrator-instructions.md` (A headless task whose worker opens the PR), `docs/reference/usage.md`
- [ADR Index](README.md)
