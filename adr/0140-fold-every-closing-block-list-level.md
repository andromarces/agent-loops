# 0140. Fold every closing-block list level

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md). The replaced part is decision 9, which froze the accepted parser shapes.

Decisions 1 to 8 stay in force.

## Date

2026-11-13

## Context

Issue #1917 recorded three worker reports that parsed to null, and each repair turn left the parent with `raw`. Shape 1 nests a second list level under a `Notes:` item. Shape 3 nests a second level under a bold `Why:` item. The closing-block rule folded only one sub-item level, so the deeper item stayed a dropped list and the block parsed to null.

A probe of the source at `2a193106` returned null for shapes 1, 2, and 3. Shape 1 and shape 3 parse after the deeper level folds. Shape 2 holds bold heading paragraphs and prose between lists, and it stays out of scope.

## Decision

1. **Fold every nesting level.** A sub-item at its parent text column joins its parent item with `, `, as the first level does. Each deeper level repeats the same rule through `takeSubitems` in `src/lib/report.mjs`.
2. **Apply the fold once.** The shared parse in `report.mjs` serves the interactive `role finish --require-accept` path and the headless `runLoop` path with `requireAccept` true.
3. **Keep every other rejection.** A missing parent item, another indent width, a tab, and a star bullet stay unparseable. So do a bold heading that groups a list, prose between two lists, a fenced label line, and the `Verdict` rules.
4. **State the rule in the prompt and the docs.** `reportBlock` in `src/prompts/rules.mjs` states that every nesting level folds. `docs/orchestrator/closing-block.md` states the same rule.
5. **Keep the repair match.** `repairedReportMatches` still compares the content of every original label. A faithful restatement of shape 1 matches, and a restatement that adds or drops a word does not.

## Consequences

- A report with a deeper list level parses instead of failing closed into `raw`. Its nested content joins the parent value in reading order.
- The interactive gate and the headless gate read the same report for these shapes, because both use the shared parse.
- The repair turn is no longer needed for a report whose only defect is a deeper list level. Its content-match guard is unchanged.
- Shape 2 keeps its origin/main result, and no bold heading line becomes a list fold.
- Every shape outside the fold still leaves a dropped list that fails closed.

### Probe

- The probe ran `parseReportBlock` from source `2a193106` on the three issue shapes. Shapes 1 and 3 returned null.
- The same probe ran a faithful repair of shape 1. `repairedReportMatches` returned true, so the mismatch in the reported run came from changed repair content.

## Alternatives

1. **Bar a list below the first sub-level in the worker prompt.** Not taken. The issue offers this choice, and the fold keeps the report that the worker already wrote.
2. **Fold bold heading paragraphs and prose between lists too.** Not taken. Shape 2 is a different failure class from issues #1386 and #915.

## Authors

Andro Marces

## Links

- [Issue #1917](https://github.com/andromarces/agent-loops/issues/1917)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- Implementation:
  - Fold: `takeSubitems` and `takeItems` in `src/lib/report.mjs`
  - Rendered rule: `reportBlock` in `src/prompts/rules.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/runtime.require-accept.test.mjs`, `tests/role/finish.abort.test.mjs`, and `tests/prompts/rules.test.mjs`
- [ADR Index](README.md)
