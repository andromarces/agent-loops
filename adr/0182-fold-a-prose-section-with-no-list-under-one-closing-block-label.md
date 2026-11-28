# 0182. Fold a prose section with no list under one closing-block label

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md). The replaced part is the section definition of decision 1: "A section is a bare dash run, or a prose lead with its dash run." A section is now a bare dash run, a prose line, or a prose lead with its dash run. Every other sentence of decision 1 stays in force, and so does every sentence of decisions 2, 3, 4, and 5. Every sentence of the Consequences section stays true, because each one names a lead with its list or a refusal, not a bare prose line.

## Date

2026-11-28

## Context

Issue #2069 records three Claude worker reports that `parseReportBlock` at `b8b2f17d` returned null for. Two reports held one label with a prose paragraph and a later prose lead with its dash list. The old section rule folded a prose lead with its list only when the label line sat directly above the prose, so the paragraph between them made the list a dropped list and the block unparseable. The one repair turn returned null for both.

The third report wrote `Conclusion` and `Why` after the other four labels, in bold. The block starts at the last `Conclusion:` line, so `Blockers` was reported missing, the report was null, and the repair returned `mismatched`: the repair restated the four values above the block, and the matcher read only the block.

## Decision

1. **Fold a prose section with no list.** A run of prose sections under one label that holds a prose lead with its dash list joins the value in order. A section with no list joins as `; <prose>`, and a paragraph's lines join with a space. The `foldEmptyLabelLists` fold in `src/lib/report.mjs` reads it.
2. **Keep every origin/main value.** A prose paragraph that no later dash list follows keeps the origin/main result, so the paragraph stays out of the value. A label that took a section fold consumes a following prose section with no list, because the origin/main result for that shape is null. Two blank lines and no blank line before a section keep their refusals.
3. **Keep the outside-block check text per label.** The fold builds one text per label with each dash item's own lead left out, as before, and the check runs once on that text. The new sections add their words to that text in order.
4. **State the order in the prompts.** The worker preamble and the closing-block repair prompt state that `Conclusion:` comes first and `Why:` comes second, before the other labels.
5. **Match a repair that only reorders.** `repairedReportMatches` reads the inline value of a label line directly above the closing block, with only blank lines between, when the fold returns per-label values. The repair may restate those labels in the canonical order. A changed, added, dropped, or moved word still refuses the repair, and the inherited comparison still applies when the fold reads the raw block.

## Consequences

- The issue #2069 shape 1 parses with the paragraph, the lead, and every item of both dash lists in the value.
- The issue #2069 shape 2 parses with the two-line paragraph, the lead and its list, and the trailing prose line in the `Conclusion` value.
- The issue #2069 shape 3 report still parses to null, and its canonical repair now matches, so the parent reads the worker `Deferred` and `Notes` values.
- A writer that puts `Conclusion` and `Why` first meets a rule that the worker preamble and the repair prompt both state.
- A prose paragraph with no list that no dash list follows keeps its origin/main value, so the fold changes no shape that main already parses.
- A repair that changes a label value above the block still leaves the report null with `reportRepairOutcome` `mismatched`.

## Alternatives

1. **Bar both shapes in the prompts.** Not taken for shapes 1 and 2. The fold keeps the report that the worker already wrote, as [ADR 0167](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md) did for its shape.
2. **Read every label of the response for the match.** Not taken. A label line in narration or in a quoted example would then become evidence, and the repair could supply a value the closing block never held.

## Authors

Andro Marces

## Links

- [Issue #2069](https://github.com/andromarces/agent-loops/issues/2069)
- [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- [ADR 0169: Name the outcome of a repair that does not recover a closing block](0169-name-the-outcome-of-a-repair-that-does-not-recover-a-block.md)
- Implementation:
  - Fold: `foldEmptyLabelLists`, `proseSectionOwner`, and `proseSections` in `src/lib/report.mjs`
  - Match: `originalLabelTokens` and `labelLinesAboveBlock` in `src/lib/report.mjs`
  - Rendered rules: `reportBlock` and `closingBlockRepairPrompt` in `src/prompts/rules.mjs`, and `conclusionFirstRule` in `src/prompts/worker.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, `tests/prompts/worker.test.mjs`, and `tests/prompts/rules.test.mjs`
- [ADR Index](README.md)
