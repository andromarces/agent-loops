# 0169. Let a repair move content when only a required label is absent

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md). The replaced part is decision 5, for an original block that passes every structural guard and whose only defect is one or more absent required labels. The per-label content rule stays in force for every other case, and every other decision of ADR 0094 stays in force.

## Date

2026-11-26

## Context

Issue #2015 records an OpenCode worker turn whose closing block held every report label but `Blockers`. A prose lead with a dash list followed `Why`, so the parser folded that section into the `Why` value. The repair turn restated the canonical block and put the same words under `Checks`, which is where the canonical format names commands and results. `repairedReportMatches` compared each label with the same label of the original, found `Why` shorter and `Checks` longer, and rejected the repair. The envelope then carried `report: null`, `reportMissingLabels: ["Blockers"]`, and the response in `raw`, with no repair outcome.

A canonical restatement can move a section that the parser folded under the label above it. The words survive; only their label changes. The per-label rule treated that move as content loss.

## Decision

1. **Keep the null-report trigger and one repair turn.** Decision 1 and decision 2 of ADR 0094 stay.
2. **Relax the content match for one case.** When the original block passes every structural guard and its only defect is one or more absent required labels, a repaired report may move content between the labels that the original held with content. `lacksOnlyRequiredLabels` and `relabeledRepairMatches` in `src/lib/report.mjs` apply the rule.
3. **Pin the labels that decide meaning.** `Conclusion` keeps its own content, and a `Blockers` value keeps its own content, so no repair can hide a blocker under another label. `Checks` keeps every original word in order, so a moved section may join it but no check leaves it.
4. **Keep the absent-label rule and the no-change rule.** A label that the original left out gains only `none`, as decision 5 of ADR 0094 states. Across the labels that the original held with content, the repaired report holds the same words with the same counts, in any order, so a repair can move content but never lose or add a word.
5. **Try the per-label rule first.** A repair that keeps every label's own content matches without the relaxation. A structural defect, such as a table pair, a dropped list, or a decorated label, still fails closed.
6. **Keep every other repair guard.** The reviewer verdict match, the non-empty original required labels, and the non-empty original `Checks` line for an accept stay as decision 5 of ADR 0094 states. A repair whose session is lost or replaced, that fails, or that still parses to null still leaves the original response in `raw`.

## Consequences

- The issue #2015 shape yields a non-null report after the repair turn, with `Blockers` set to `none`.
- A canonical restatement that moves a folded section does not lose the report. The parent reads each word under the label that the repair chose.
- A repair still cannot drop a finding, add a word, hide a blocker, remove a check, or promote a verdict.
- The rule applies only to a block whose only defect is an absent required label. A block with a structural defect keeps the per-label rule alone.

## Alternatives

1. **Name the repair outcome in the envelope.** Not taken alone. It explains the null but leaves the report null for a block whose words are all present.
2. **Default an absent required label to `none` in the parser.** Not taken. It removes the required-label check for every response and hides a real omission.
3. **Compare the whole response content without label pins.** Not taken. A repair could move a blocker into `Notes` or a failed check out of `Checks`.
4. **Accept any canonical restatement when the block is structurally readable.** Not taken. A repair could still drop or rewrite a finding.

## Authors

Andro Marces

## Links

- [Issue #2015](https://github.com/andromarces/agent-loops/issues/2015)
- [PR #2018: Recover a worker report that lacks only Blockers after repair](https://github.com/andromarces/agent-loops/pull/2018)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- Implementation:
  - Content match: `repairedReportMatches`, `relabeledRepairMatches`, and `lacksOnlyRequiredLabels` in `src/lib/report.mjs`
  - Repair turn: `runChild` in `src/child-turn.mjs`
  - Docs: `docs/orchestrator/closing-block.md` and `docs/reference/role.md`
  - Tests: `tests/child-turn.report-repair.test.mjs` and `tests/lib/report.test.mjs`
- [ADR Index](README.md)
