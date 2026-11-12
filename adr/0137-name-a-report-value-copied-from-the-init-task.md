# 0137. Name a report value copied from the init task

## Status

accepted

This ADR partially supersedes [ADR 0136: Keep the init task label lines out of the child report](0136-keep-the-init-task-label-lines-out-of-the-child-report.md). The superseded parts are:

- Decision 5's rule that the plain-prose limit stays and the prompt rule is the only barrier.
- The third consequence's rule that a plain task quotation still parses as a block with the prompt rule as the mitigation.
- Alternative 3's rejection of an envelope field for the copied label.

Decision 6 stays in force: the #1615 repair keeps the original label content, so a repaired value still fails the match.

## Date

2026-11-13

## Context

A worker can copy the `Init task:` label lines as plain lines at column 0 (issue #1914). The parser takes that shape as a valid closing block. ADR 0136 decision 5 records the limit, and the prompt rule reaches a first turn only. A later turn of the same conversation has no `Init task:` block, so it has no rule.

A scripted worker turn on `origin/main` at commit `70a9b315` reproduced the case. The task and the response held `Conclusion: TASK-LABEL-CONCLUSION-1914`, `Why: TASK-LABEL-WHY-1914`, `Blockers: none`, and `Checks: TASK-LABEL-CHECKS-1914`. The result held every task value in its report and no field that named a label.

## Decision

1. **Detect a copied task value.** `copiedTaskReportLabels` in `src/lib/report.mjs` takes the parsed report and the init task. It returns the label names whose report value equals the value of the same label in the task. The task goes through `parseReportBlock`, so a fenced task line supplies no value.
2. **Store one result field.** `runChild` in `src/child-turn.mjs` computes `reportCopiedTaskLabels` once beside `reportOutsideBlockLabels`. A turn with no match carries no field.
3. **Carry the field on every surface.** The `role dispatch` envelope and the state file `lastResult` read the stored value. The headless result prompt carries it too.
4. **Reject the repair turn.** Decision 6 of ADR 0136 stays. The #1615 repair keeps the original label content, so a repaired report still holds the copied value.
5. **Skip a non-specific value.** A task value of `none` or `n/a` names no label. A correct report can hold `none`, so a match costs one restatement turn on a correct report.
6. **Read no task `Verdict:` line.** A task `Verdict:` line supplies no comparison. `accept` is a normal reviewer answer, so a match cannot show a copy.
7. **Keep label names only.** The field holds label names, never task or response text.
8. **State the parent action.** The orchestrator instructions and the headless prompt tell the parent to dispatch one turn of the same role for the copied result. The detail is in the closing-block page, and the envelope field is in the role reference.
9. **Name the heuristic.** The comparison reads the same label only. An exact coincidental match costs one restatement turn, and a copied value under another label stays out.
10. **Keep the comparison input on every turn.** Callers pass the init task to `runChild` on every turn: `state.task` on the dispatch path and the loop task on the headless path. A later turn therefore reads the stored task with no prompt block.

## Consequences

- The parent learns each copied label without reading the child response.
- A first turn and a later turn of the same conversation name the same labels.
- A report whose values differ carries no field, and a task value of `none` names no label.
- A task `Verdict:` line never adds the field.
- The report, the verdict, the repair, both accept gates, and the OpenCode split guard keep their behavior.
- A coincidental exact match costs one restatement turn, and a copied value under another label reaches the parent unnamed.

## Scripted probe

The probe ran on 2026-11-13 on macOS with Node v27.0.0-alpha.0.1.0. It called one scripted worker turn through `runChild` in a new disposable Git repository.

The task and the response held these lines: `Conclusion: TASK-LABEL-CONCLUSION-1914`, `Why: TASK-LABEL-WHY-1914`, `Blockers: none`, and `Checks: TASK-LABEL-CHECKS-1914`.

On `origin/main` at commit `70a9b315`, the report held `TASK-LABEL-CONCLUSION-1914` as its conclusion. The result keys held no `reportCopiedTaskLabels`.

On this change, the same probe returned `["Conclusion", "Why", "Checks"]`. `Blockers` held `none` in both, so the field left it out.

## Alternatives

1. **Use the #1615 repair turn.** Not taken. Decision 6 of ADR 0136 stays, and the repair keeps the original content.
2. **Compare across labels.** Not taken. A value under another label creates a false positive with no copy.
3. **Skip every one-word value.** Not taken. A marker value is often one word, and the `none` and `n/a` list covers the common report answer.
4. **Add the field to the prompt rule only.** Not taken. A later turn has no task block, so the prompt cannot reach it.

## Authors

Andro Marces

## Links

- [Issue #1914](https://github.com/andromarces/agent-loops/issues/1914)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md), related as the #1615 repair turn
- [ADR 0136: Keep the init task label lines out of the child report](0136-keep-the-init-task-label-lines-out-of-the-child-report.md)
- Implementation:
  - Detection: `copiedTaskReportLabels` in `src/lib/report.mjs`
  - Result field: `runChild` in `src/child-turn.mjs`
  - Envelope field: `dispatchPayload` in `src/role/dispatch.mjs`
  - Headless payload: `resultPrompt` in `src/prompts/orchestrator.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/closing-block.md`, and `docs/reference/role.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, `tests/role/dispatch.reports.test.mjs`, `tests/prompts/orchestrator.test.mjs`, and `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
