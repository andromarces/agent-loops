# 0041. Declare the run PR after init with `role declare-pr`

## Status

accepted

Partially supersedes [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md). ADR 0009 fixes `--pr` as an init field that no later call changes. This ADR adds one transition after init, from no PR to a number, through `role declare-pr`. Every other decision of ADR 0009 holds, including the finish rule for a declared PR.

## Date

2026-10-17

## Context

`--pr` is an init field. A task such as "address issue N through a PR" has no PR at init: the worker opens it in its first turn, and the parent cannot open it first, because the role rules forbid a parent write to GitHub. Such a run lost the runtime-supplied required-check status in every reviewer prompt (issue #320) and the declared-PR finish rule (issue #302). Without that rule the parent can finish with no gate, and an omitted `unresolvedCompare` marker reads as a verified finish (issue #286). Issue #916 offered two fixes: one transition of `pr` after init, or a documented new-PR flow with `pr` init-only.

## Decision

1. **New operation.** `agent-loop role declare-pr --cwd <dir> --parent-session <id> --pr <n>` sets `pr` in the state file. The envelope is `{"status": "ok", "lifecycle": <lifecycle>, "pr": <n>}`. The run then behaves as one that passed `--pr` at init: `dispatch` reads `state.pr` for the supplied status, and `finish` applies the declared-PR rule. No other code path changes.
2. **One way.** The only transition is from no PR to a number. A run that already has a PR, from init or from an earlier `declare-pr`, refuses the call, also for the same number. No call clears or changes the PR.
3. **Refusals.** The call refuses a terminal run, a `review-only` run (which refuses `--pr` at init for the same reason), a missing `--pr`, a missing `--parent-session`, and a `--parent-session` that differs from the stored id. It works from `active`, `dispatched`, and `interrupted`, and leaves the lifecycle as it is.
4. **Parent only.** `declare-pr` joins `finish`, `abort`, and `extend` as an operation that a spawned child of the run never runs. The spawn-time marker refuses it, with the limit that the `extend` rules state: the parent-session check does not identify the caller.
5. **Headless path.** The headless loop is unchanged. It takes `--pr` and `--require-ci` on one command line before any worker runs, holds no lifecycle state between calls, and has no parent that could call a second operation. Its shared rules (`missingGateRefusal`, `unresolvedCompareReason`, the supplied status for the named PR) already read one PR input, so both paths apply the same rules to a declared PR.
6. **Orchestrator guide.** The guide states how a parent runs and finishes a task whose PR the worker opens: init with no `--pr`, dispatch the worker, read the PR number from its report, run `declare-pr`, and end through `--require-ci <n>`. A repository whose gate cannot read the rulesets (issue #301) keeps the `unresolvedCompare` path, with the PR head compared by hand.

## Consequences

- A run whose worker opens the PR gets the supplied check status and the declared-PR finish rule from the turn after `declare-pr`. A reviewer turn that ran before it read the checks itself.
- `pr` is no longer fixed for the whole run: a reader of a state file cannot tell whether `pr` came from init or from `declare-pr`. The state file does not record the difference.
- A parent that declares a wrong PR number cannot correct it. It must `abort` and start a new run, which starts every role on a new session.
- A repository whose gate cannot read the rulesets still refuses every finish of a declared run, so the parent must not declare the PR there.
- The headless loop keeps the gap for a task whose worker opens the PR.

## Alternatives

1. **Keep `pr` init-only and document the flow (option 2 of issue #916).** Rejected. The parent then finishes with `--require-ci <n>` and no declared-PR rule, so a finish with no gate stays possible, and the reviewer prompts keep no supplied status.
2. **Allow the transition at `finish` with `--require-ci`.** Not taken. The status for the reviewer turns would stay unavailable, and the declared-PR rule would apply only at the end.
3. **Let `declare-pr` change an existing PR.** Rejected. A moved PR would let a run drop the gate for the PR it was bound to.
4. **Add `declare-pr` to the headless loop as an orchestrator action.** Not taken. The loop owns its action set through a validated contract, and the orchestrator is a child turn, so it would let a child choose the PR that gates its own run.

## Authors

Andro Marces

## Links

- [Issue #916](https://github.com/andromarces/agent-loops/issues/916)
- [PR #918](https://github.com/andromarces/agent-loops/pull/918)
- Partially supersedes [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
- Related issues: #286, #301, #302, #320
- [ADR 0021: Do not let a new session take over a run](0021-no-parent-session-takeover.md)
- Implementation:
  - Source: `declarePr` in `src/role.mjs`
  - Tests: `tests/role.declare-pr.test.mjs`
  - Docs: `docs/orchestrator-instructions.md` (Declaring a PR run), `docs/reference/role.md`
- [ADR Index](README.md)
