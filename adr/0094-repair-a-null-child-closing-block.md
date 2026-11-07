# 0094. Repair a null child closing block once in the same session

## Status

accepted

This ADR supersedes no earlier decision. It keeps [ADR 0084](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md) as a narrow accounting exception for a first Codex model refusal and adds no general refund policy.

## Date

2026-11-07

## Context

`src/lib/report.mjs` parses the closing block with a fixed set of accepted shapes. Each new shape that a model writes needed a parser change, for example issues #1483, #1520, #1585, #1592, #1597, #1601, and #1603. A parse miss fails closed: `report` is null, `raw` carries the whole response, and a null report is not accepted. The turn still charges its step and may have done work, so repeated misses can exhaust the step budget.

`reportMissingLabels` alone is not a complete trigger. `missingRequiredReportLabels` returns an empty list for a structural failure and for a response with no recognizable label, so a null report can carry no missing-label field.

`decide` in `src/orchestrator.mjs` already takes one repair turn for a malformed parent action, and issue #1034 documents that repair for a refused action. The child path had no equivalent.

## Decision

1. **Trigger on a null report only.** After a successful string response, `runChild` in `src/child-turn.mjs` parses the report. A `report === null` starts the repair. The missing-label list stays a diagnostic and never decides the trigger.
2. **Take one repair turn in the same session.** The repair invocation uses the stored session id and the same role state. It runs after the original reviewer mutation check and the post-turn evidence reads, and it runs inside the step that the original turn already charged. A second null report starts no further repair.
3. **Ask for formatting only.** `closingBlockRepairPrompt` in `src/prompts/rules.mjs` asks the child to restate only its closing block in the short canonical format. It names no task, runs no work, and asks the child to keep the original findings, checks, and verdict. The prompt does not quote the original response, because the same conversation holds it.
4. **Keep every turn guard.** A reviewer repair runs under its own `withMutationCheck`, so a write in the repair turn is a fatal mutation. The repair takes the turn signal, and `throwIfCanceled` ends a canceled turn. A cancel that lands with a handled repair failure ends the turn as a cancel too. A repair that reports a missing session is a failed repair: it is never rerun as a first turn, because a new conversation cannot restate the original report. A repair whose session id changes, or that sets `conversationReplaced`, is rejected; the replacement mark stays so the next turn delivers the preamble or task.
5. **Store a repaired report only when it matches the original.** The repair output is untrusted. Each report label that the original response holds with a value must keep that value after whitespace normalization. A label that the original left out may gain only `none`. For a reviewer turn, the repaired verdict must match an explicit `accept` or `reject` in the original response; a missing or unreadable original verdict fails closed. `repairedReportMatches` in `src/lib/report.mjs` applies the rule. A match replaces the response and the report of the result, so the reviewer verdict, the accept gate, and `raw` read the same text. The evidence of the original invocation, such as `reviewed`, `workTree`, `prChecks`, and the turn-window fields, stays.
6. **Fail closed on every failure.** A lost session, a failed repair, a non-string repair response, a repair that still parses to null, and a repaired report that does not match the original leave `report` null with the original response in `raw`. The result stays not accepted, and a repair can never create an acceptance that the original response did not state. The step stays charged.
7. **Repair a null report, not a failed acceptance.** A report that parses but lacks the reviewer `Checks` line or the `Verdict` line takes no repair. `acceptanceFailure` in `src/lib/report.mjs` keeps its current policy: a missing or non-accept verdict yields `verdict`, and an accept without a `Checks` line yields `checks`. A model therefore cannot restate its way past a failed acceptance condition.
8. **State the triage rule.** A parser fix stays valid for a regression on the documented format, a dropped finding, and an incorrect acceptance. A report of an unsupported format is covered only after the repair ships and handles that case; close it as covered when it does. A repeated repair failure stays actionable.
9. **Change no parser shape and add no structured output.** The accepted parser behavior stays frozen. Schema-constrained structured output and a looser parser stay out of scope.

## Consequences

- A null report costs one extra child invocation in the same step instead of a new step. A repeated miss can still exhaust the step budget, but the repair gives the turn a bounded second chance.
- A repaired turn stores a canonical closing block, so the parent reads the same fields as for a first-response parse.
- A repaired block that rewrites a finding or promotes a verdict is unused, so the repair cannot raise acceptance above what the original response stated.
- Reviewer safety is unchanged: the repair is read-only and mutation-checked. Cancellation, session checks, and the original evidence still apply.
- A failed repair, and a cancel that lands with it, leaves the parent with the original response in `raw` and no new failure path.
- Per-adapter resume behavior stays unverified until the live item in issue #710 records a result on Codex, Claude Code, agy, Copilot, and OpenCode. A replacement conversation cannot restate the original report, so it stays a documented unverified case rather than a separate issue.
- The repair adds one invocation event per null report, with the same `stepsUsed` as the original turn.

## Alternatives

1. **Loosen the parser.** Not taken. It grows the accepted surface with every new model shape and keeps the repeated-miss cost.
2. **Refund the step on a null report.** Not taken. ADR 0084 is a narrow Codex model-refusal exception, and a refund would add a second state path with no repair guarantee.
3. **Retry outside the step as a new child turn.** Not taken. It would charge a new step and could run after the reviewer evidence and mutation check.
4. **Quote the original response in the repair prompt.** Not taken. The same session holds it, and a replacement conversation must not be able to invent a restatement.
5. **Repair a parsed report without `Checks` or `Verdict`.** Not taken. It would let a model change the acceptance input instead of formatting a block that already parsed.
6. **Use schema-constrained structured output.** Not taken. It stays out of scope for this change.

## Authors

Andro Marces

## Links

- [Issue #1615](https://github.com/andromarces/agent-loops/issues/1615)
- [PR #1618](https://github.com/andromarces/agent-loops/pull/1618)
- [ADR 0084: Charge no step for a first Codex turn that a model refusal ends](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md)
- [ADR 0016: Resume the session of a failed first turn, with a fallback to a new session](0016-resume-a-failed-first-turn-with-a-fallback.md)
- Implementation:
  - Trigger, repair invocation, and result: `runChild` in `src/child-turn.mjs`
  - Repair prompt: `closingBlockRepairPrompt` in `src/prompts/rules.mjs`
  - Original-evidence binding: `repairedReportMatches` in `src/lib/report.mjs`
  - Acceptance policy: `acceptanceFailure` in `src/lib/report.mjs`
  - Docs: `docs/orchestrator/closing-block.md`, `docs/orchestrator/run-history.md`, `docs/reference/architecture.md`, and `docs/reference/role.md`
  - Tests: `tests/child-turn.report-repair.test.mjs` and `tests/role.dispatch.reports.test.mjs`
- [ADR Index](README.md)
