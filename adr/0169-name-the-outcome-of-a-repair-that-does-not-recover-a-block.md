# 0169. Name the outcome of a repair that does not recover a closing block

## Status

accepted

## Date

2026-11-26

## Context

Issue #2015 records an OpenCode worker turn whose closing block held every report label but `Blockers`, with a prose lead and a dash list under `Why`. [ADR 0167](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md) folds that section into the `Why` value. The issue records the repair outcome as unknown and offers two changes: recover the block when the repair restates the original content label by label, or name the repair outcome in the envelope.

A per-label exact match cannot accept a canonical restatement that moves the folded section from `Why` to `Checks`. Allowing a cross-label move would weaken the guard that [ADR 0094](0094-repair-a-null-child-closing-block.md) decision 5 sets. A reviewer probe reproduced a report with an empty `Why:` line and indented prose: moving the words `to run` from `Deferred` to `Checks` turned `npm test failed` into `npm test failed to run` and cleared the accept gate. A worker repair could likewise swap which suite passed. The same probe showed that an explicitly empty `Blockers:` line took the rule reserved for an absent label, so a repair could fill it with `none`.

## Decision

1. **Keep the per-label exact match.** A repaired report is used only when every label holds the same normalized content as the same label in the original response. A repair never alters, adds, drops, or moves content between labels. The reviewer verdict rule and the accept evidence rule of ADR 0094 decision 5 stay.
2. **Keep an empty label apart from an absent one.** A label line with no value is empty. Only a label that no line names may gain `none` on repair, and the added value must be exactly `none`: the parsed value decides, not its word count, so a lone dash or another wordless value is content the original did not hold. An empty label must stay empty.
3. **Name the repair outcome on a null report.** When the repair does not recover the block, the turn result and the dispatch envelope carry `reportRepairOutcome` with one value: `not-run`, `failed`, `null`, or `mismatched`. The field holds no response text. `not-run` is the fallback when a null report has no repair attempt. `repairedReportMatches` in `src/lib/report.mjs` applies the content rule, and `runChild` in `src/child-turn.mjs` sets the outcome.
4. **Take the outcome route for issue #2015.** The issue records the repair outcome as unknown, and the exact match does not accept a restatement that moves the folded section. A faithful restatement that keeps the section under its original label still recovers the report.
5. **Change no parser shape.** The block that parses keeps its current behavior, and the envelope gains one field.

## Consequences

- The guard is unchanged from ADR 0094 decision 5 except for the empty-label rule, so a repair can never turn a failed check, a passed suite, or a blocker into different content.
- A failed, null, or mismatched repair is now distinguishable in the envelope without response text, so the parent can tell whether the repair turn ran and why it did not recover the block.
- A canonical restatement that moves a folded section leaves `report` null and `raw` carries the original response. The parent reads `reportRepairOutcome` for the reason.
- An explicitly empty required label still makes the report null, and a repair cannot clear that state with `none`.
- Every shape from the issue that a faithful restatement can keep label by label still recovers.

## Alternatives

1. **Accept a cross-label move when an absent required label is the only defect.** Not taken. A reviewer report could turn a failed check into a check not yet run and clear the accept gate, and a worker could swap which suite passed.
2. **Default an absent required label to `none` in the parser.** Not taken. It removes the required-label check for every response and hides a real omission.
3. **Fill an explicitly empty label on repair.** Not taken. An empty label is a defect, not an omission, so the repair must not supply a value the child did not state.
4. **Leave the null unexplained.** Not taken. The parent then cannot tell a failed repair from a null or mismatched one.

## Authors

Andro Marces

## Links

- [Issue #2015](https://github.com/andromarces/agent-loops/issues/2015)
- [PR #2018: Recover a worker report that lacks only Blockers after repair](https://github.com/andromarces/agent-loops/pull/2018)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md), which keeps the exact content rule with the empty-label rule
- [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md), which folds the issue shape's section under `Why`
- Implementation:
  - Content match: `repairedReportMatches` in `src/lib/report.mjs`
  - Repair outcome: `runChild` in `src/child-turn.mjs`, `dispatchPayload` in `src/role/dispatch.mjs`, and `resultPrompt` in `src/prompts/orchestrator.mjs`
  - Docs: `docs/orchestrator/closing-block.md`, `docs/reference/role.md`, and `docs/orchestrator-instructions.md`
  - Tests: `tests/child-turn.report-repair.test.mjs`, `tests/role/dispatch.reports.test.mjs`, and `tests/prompts/orchestrator.test.mjs`
- [ADR Index](README.md)
