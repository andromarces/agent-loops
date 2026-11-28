# 0182. Fold a prose section with no list under one closing-block label

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md). The replaced part is the section definition of decision 1: "A section is a bare dash run, or a prose lead with its dash run." A section is now a bare dash run, a prose line, or a prose lead with its dash run, and a prose line folds only inside a run that holds a prose lead with its dash run. Every other sentence of decision 1 stays in force. Decision 4 stays in force except for the exception of [ADR 0168](0168-fold-a-plain-label-list-item.md), which remains in force: a dash item or sub-item that opens with a plain report label name is item text inside a folding run. Decisions 2, 3, and 5 stay in force. Every sentence of the Consequences section stays true, because each one names a lead with its list or a refusal, not a bare prose line.

## Date

2026-11-28

## Context

Issue #2069 records three Claude worker reports that `parseReportBlock` at `b8b2f17d` returned null for. Two reports held one label with a prose paragraph and a later prose lead with its dash list. The old section rule folded a prose lead with its list only when the label line sat directly above the prose, so the paragraph between them made the list a dropped list and the block unparseable. The one repair turn returned null for both.

The third report wrote `Conclusion` and `Why` after the other four labels, in bold. The block starts at the last `Conclusion:` line, so `Blockers` was reported missing, the report was null, and the repair returned `mismatched`: the repair restated the four values above the block, and the matcher read only the block.

The first change read label lines above the block for the matcher. The review found that it accepted a `Checks` value from an earlier block, rejected an unchanged wordless `Notes: -`, and accepted a repair that dropped that label. It also found a trailing prose section after bare dash lists that main rejects, and a worker prompt sentence that claimed a response without `Conclusion` has no block.

## Decision

1. **Fold a prose section with no list inside a run.** A run of prose sections under one label folds in order when it holds a prose lead with its dash list. A section with no list joins as `; <prose>`, and its paragraph lines join with a space. A prose section after bare dash lists with no prose lead stays unparseable, as it is in main. The `foldEmptyLabelLists` fold in `src/lib/report.mjs` reads it.
2. **Keep every origin/main value.** A prose paragraph that no later dash list follows keeps the origin/main result, so the paragraph stays out of the value. Two blank lines and no blank line before a section keep their refusals. The run fold applies only to the labels that took it.
3. **Keep the outside-block check text per label.** The fold builds one text per label with each dash item's own lead left out, as before, and the check runs once on that text. The new sections add their words to that text in order.
4. **Parse a reordered block once.** When the block from the last `Conclusion:` line holds no `Blockers` line, and no earlier `Conclusion` line stands in the response, a run of report label lines directly above it, with only blank lines between and a `Blockers:` line in the run, joins the block. The parser then reads the four values the response wrote before its final `Conclusion` and `Why`. A block that holds `Blockers`, and a response with an earlier `Conclusion` line, keep their start, so no block that main parses changes and an earlier block never supplies a value. `reorderedBlockStart` in `src/lib/report.mjs` reads it.
5. **Keep main's repair match, with label presence.** `repairedReportMatches` reads only the parser's per-label output. A label the parser returned a value for must stay present in the repair, a wordless dash included. A changed, added, dropped, or moved word still refuses the repair, and the inherited comparison still applies when the fold reads the raw block. No label line above the block is read for the match.
6. **State the order in the prompts.** The worker preamble and the closing-block repair prompt state that `Conclusion:` comes first and `Why:` comes second, before the other labels. Neither claims that a response without `Conclusion` has no block, because plain prose above the first label still supplies the conclusion.

## Consequences

- The issue #2069 shape 1 parses with the paragraph, the lead, and every item of both dash lists in the value.
- The issue #2069 shape 2 parses with the two-line paragraph, the lead and its list, and the trailing paragraph in the `Conclusion` value.
- The issue #2069 shape 3 parses directly, so the parent reads the worker `Deferred` and `Notes` values without a repair.
- A repair of that block accepts the same values in the reordered form, a wordless `Notes: -` included. A repair that adds, removes, or changes a label is refused.
- A repair cannot gain a `Checks` value from an earlier block, and trailing prose after bare dash lists keeps main's refusal.
- A writer that puts `Conclusion` and `Why` first meets a rule that the worker preamble and the repair prompt both state.
- A prose paragraph with no list that no dash list follows keeps its origin/main value, so the fold changes no shape that main already parses.

### Probe

- A differential probe compared the parser with `b8b2f17d` on 265,716 enumerated unit sequences. It found no shape whose value changed and no shape that main parses and the change refuses.
- The probe compared 1,200,000 random sequences of up to twelve units. It found no changed value and no refusal of a shape that main parses.

## Alternatives

1. **Bar both shapes in the prompts.** Not taken for shapes 1 and 2. The fold keeps the report that the worker already wrote, as [ADR 0167](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md) did for its shape.
2. **Read every label of the response for the match.** Not taken. A label line in narration, in a quoted example, or in an earlier block would then become evidence, and the repair could supply a value the final block never held.

## Authors

Andro Marces

## Links

- [Issue #2069](https://github.com/andromarces/agent-loops/issues/2069)
- [PR #2073: Fold a prose section with no list and repair a reordered closing block](https://github.com/andromarces/agent-loops/pull/2073)
- [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md)
- [ADR 0168: Fold a closing-block list item that opens with a plain label name](0168-fold-a-plain-label-list-item.md)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- [ADR 0169: Name the outcome of a repair that does not recover a closing block](0169-name-the-outcome-of-a-repair-that-does-not-recover-a-block.md)
- Implementation:
  - Fold: `foldEmptyLabelLists`, `proseSectionOwner`, `proseSections`, and `proseParagraph` in `src/lib/report.mjs`
  - Block start: `reorderedBlockStart` in `src/lib/report.mjs`
  - Match: `originalLabelTokens` and `repairedReportMatches` in `src/lib/report.mjs`
  - Rendered rules: `reportBlock` and `closingBlockRepairPrompt` in `src/prompts/rules.mjs`, and `conclusionFirstRule` in `src/prompts/worker.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, `tests/prompts/worker.test.mjs`, and `tests/prompts/rules.test.mjs`
- [ADR Index](README.md)
