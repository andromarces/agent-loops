# 0182. Fold a prose section with no list under one closing-block label

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md). The replaced part is the section definition of decision 1: "A section is a bare dash run, or a prose lead with its dash run." A section is now a bare dash run, a prose lead with its dash run, or a plain prose section with no list inside a run that holds a plain prose lead with its dash list. Every other sentence of decision 1 stays in force. Decision 4 stays in force except for the exception of [ADR 0168](0168-fold-a-plain-label-list-item.md), which remains in force: a dash item or sub-item that opens with a plain report label name is item text inside a folding run. Decisions 2, 3, and 5 stay in force. Every sentence of the Consequences section stays true, because each one names a lead with its list or a refusal, not a bare prose line.

## Date

2026-11-28

## Context

Issue #2069 records three Claude worker reports that `parseReportBlock` at `b8b2f17d` returned null for. Two reports held one label with a prose paragraph and a later prose lead with its dash list. The old section rule folded a prose lead with its list only when the label line sat directly above the prose, so the paragraph between them made the list a dropped list and the block unparseable. The one repair turn returned null for both.

The third report wrote `Conclusion` and `Why` after the other four labels, in bold. The block starts at the last `Conclusion:` line, so `Blockers` was reported missing, the report was null, and the repair returned `mismatched`. The issue offers two branches for this shape. This ADR takes the second branch: the prompts state the label order, and a repair that restores a substantive value above the block does not match, which a test records.

An earlier draft parsed the reordered block and read labels above the block for the repair match. The review found that it accepted shapes main rejects, and that it refused an unchanged wordless `Notes: -` while accepting a repair that dropped it. This ADR removes both: the parser and the repair match keep main's behavior for every input except shapes 1 and 2, and this ADR makes no guarantee about the labels of an earlier draft.

## Decision

1. **Fold a prose section with no list inside a run.** A run under one label folds in order when it starts with a plain prose paragraph with no list and holds a plain prose lead with its dash list. The paragraph and a later plain prose section with no list join as `; <prose>`, and each paragraph's lines join with a space. A plain prose line there starts at column 0 with a Unicode letter or digit, holds at least one letter, is no list item, and ends with no pipe. A paragraph followed by a bare dash list and no prose lead starts no such run, and so does a thematic break. A bold prose section and a paragraph outside such a run keep main's result, so every other input parses or refuses as it does in main. The `foldEmptyLabelLists` fold in `src/lib/report.mjs` reads it.
2. **Keep every main value and refusal.** A plain prose paragraph outside such a run stays out of the value, as in main, and trailing prose after bare dash lists stays unparseable. Two blank lines and no blank line before a section keep their refusals. Shape 2's two-line prose paragraph parses.
3. **Keep the outside-block check text per label.** The fold builds one text per label with each dash item's own lead left out, as before, and the check runs once on that text. The new sections add their words to that text in order.
4. **Bar the reordered shape in the prompt.** The worker preamble and the closing-block repair prompt state that `Conclusion:` comes first and `Why:` comes second, before the other labels. Neither claims that a response without `Conclusion` has no block, because plain prose above the first label still supplies the conclusion.
5. **Record why the reordered repair does not match.** The original parse reads from the last `Conclusion:` line, so it holds only `Conclusion` and `Why`. An absent label may gain only a `none` finding, so a repair that restores a substantive value such as `Checks: npm test` does not match, while a repair that supplies `none` for all four absent labels does. Tests feed the original and each repair to `repairedReportMatches` and assert both outcomes. The parser and the matcher keep main's behavior for this shape.

## Consequences

- The issue #2069 shape 1 parses with the paragraph, the lead, and every item of the dash list in the value.
- The issue #2069 shape 2 parses with its two-line paragraph, the lead and its list, and a later paragraph in the run.
- The issue #2069 shape 3 keeps main's null. A repair that restores a substantive value is refused because the parsed block holds only `Conclusion` and `Why`, and an absent label may gain only `none`; a repair that supplies `none` for all four absent labels matches. Committed tests record both outcomes.
- A response with an earlier draft keeps main's behavior, and this ADR makes no guarantee about an earlier draft's labels.
- A repair that drops a wordless `Notes: -`, or changes it to `none`, behaves as it does in main. A star-list repair that drops a dash placeholder also behaves as it does in main.
- A Markdown horizontal rule starts no run, and a bold lead after a plain paragraph keeps main's null. Both have a committed test.
- A writer who puts `Conclusion` and `Why` first meets a rule that the worker preamble and the repair prompt both state.

## Alternatives

1. **Bar shapes 1 and 2 in the prompts.** Not taken. The fold keeps the report that the worker already wrote, as [ADR 0167](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md) did for its shape.
2. **Parse the reordered block and match the repair.** Not taken. It accepted shapes main rejects, and the issue's second branch keeps main's block start and match.
3. **Read every label of the response for the match.** Not taken. A label line in narration, in a quoted example, or in an earlier block would then become evidence, and the repair could supply a value the final block never held.

## Authors

Andro Marces

## Links

- [Issue #2069](https://github.com/andromarces/agent-loops/issues/2069)
- [PR #2073: Fold a prose section with no list and bar a reordered closing block](https://github.com/andromarces/agent-loops/pull/2073)
- [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md)
- [ADR 0168: Fold a closing-block list item that opens with a plain label name](0168-fold-a-plain-label-list-item.md)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- [ADR 0169: Name the outcome of a repair that does not recover a closing block](0169-name-the-outcome-of-a-repair-that-does-not-recover-a-block.md)
- Implementation:
  - Fold: `foldEmptyLabelLists`, `proseSectionOwner`, `proseSections`, and `proseParagraph` in `src/lib/report.mjs`
  - Rendered rules: `reportBlock` and `closingBlockRepairPrompt` in `src/prompts/rules.mjs`, and `conclusionFirstRule` in `src/prompts/worker.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, `tests/prompts/worker.test.mjs`, and `tests/prompts/rules.test.mjs`
- [ADR Index](README.md)
