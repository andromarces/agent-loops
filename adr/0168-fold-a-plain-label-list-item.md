# 0168. Fold a closing-block list item that opens with a plain label name

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md). The replaced part is the decorated-label rejection of decision 4, for one shape: a `- ` item or sub-item that opens with a plain report label name and a colon inside a list run that folds under a label. Every other decorated label stays unparseable. Decisions 1, 2, 3, and 5 of ADR 0167 stay in force, and so does every other rejection of decision 4.

## Date

2026-11-25

## Context

Issue #2013 records an interactive `role` run in `review-first` mode that returned `report: null` with `raw`, and the repair turn did not recover the report. The `Why:` list held a third item, `- Checks: the pre-commit hook (oxfmt) and the pre-push lint passed.` The decorated-label guard in `reportDetail` rejected that item, while issue #1006 exempted only the bold form `- **Checks:** ran`. All six labels stood plain at column 0, so no other rule was involved.

A probe of the source at `df133ff1` returned null for the issue shape and for a sub-item that opens with a plain label name. Only the item that opens with a label name caused the failure; no text was lost, because `raw` carried the response.

The issue offers a fold or a prompt bar. The fold follows [ADR 0140](0140-fold-every-closing-block-list-level.md) and ADR 0167, which fold every list level and every one-blank-line section under a label, and it keeps the report that the worker already wrote.

## Decision

1. **Accept a plain label name on a folding dash item.** The decorated-label guard in `reportDetail` exempts a `- ` item or sub-item whose text opens with a report label name and a colon, plain or bold, for example `- Checks: ran` or `- **Notes:** ran`. The item folds into its label value as item text. The guard reads `LABEL_DASH_ITEM` in `src/lib/report.mjs`.
2. **Keep every other rejection.** The exemption covers only a dash item. An item that does not fold, such as one after two blank lines, after the reviewer `Verdict:` line, or at another indent width, stays a dropped list and the block stays unparseable. An ordered, star, or plus item, and an italic, underscored, quoted, or heading-decorated label, also stay unparseable.
3. **Apply the fold once.** The shared parse in `src/lib/report.mjs` serves the dispatch envelope, interactive `role finish --require-accept`, and headless `runLoop` with `requireAccept` true.
4. **State the rule in the prompt and the docs.** `reportBlock` in `src/prompts/rules.mjs` and `docs/orchestrator/closing-block.md` state the plain or bold name.

## Consequences

- The issue #2013 shape parses with every field, and the `Checks:` item stays in the `Why` value as text.
- A sub-item that opens with a plain label name folds into its parent item with `, `.
- Every shape that parsed before keeps its value, because the exemption only skips a rejection that returns null and never changes the fold. The approved table refusal of ADR 0167 is the exception: a block that holds a table pair stays unparseable, and every other label keeps its folded value for the missing-label and copied-task diagnostics.
- The dispatch envelope, the interactive gate, and the headless gate read the same report, because all three use the shared parse.
- A repair turn is no longer needed for this shape.
- The table refusal of ADR 0167 still holds. A table pair anywhere in the block, including one indented under a folded item, makes the block unparseable, so the plain and bold forms cannot clear the acceptance gate through a table. The refusal reads the block before the fold, so the other labels keep their folded values for diagnosis.
- The outside-block signal still fires for a pointer inside a folded item, such as `- Checks: see the test results before the closing block.`, because an unformatted or bold label name and a colon that starts a dash item is an item lead, not a cross-reference. The fold records each item's lead by item, and the check reads each item with its own lead removed and the inline value and each prose lead unchanged, so it covers any nesting depth and a dash item that follows a prose line. A label name inside prose text, after a colon or any other punctuation included, such as `As listed above in Checks: all three jobs passed.`, a name in another item's text, and a code-formatted name in inline text stay internal as ADR 0139 requires. This holds for the plain and bold forms.

### Probe

- The probe ran `parseReportBlock` from source `df133ff1` on the issue shape and on a sub-item shape, `- a` then `  - Notes: b`. Both returned null.
- The same probe on the change returns the full report for the issue shape, with `why` as `Finding 1: one; Finding 2: two; Checks: the pre-commit hook (oxfmt) and the pre-push lint passed.`, and `a, Notes: b` for the sub-item shape.
- The same item outside a run, after the `Verdict:` line, after two blank lines, and at a three-space indent still returns null.

## Alternatives

1. **Bar the shape in the prompt and repair it.** Not taken. The fold keeps the report that the worker already wrote, and the repair turn has a content-match guard.
2. **Fold the ordered and star shapes too.** Not taken. The issue names a dash item, and the other shapes stay refusals that `raw` carries.

## Authors

Andro Marces

## Links

- [Issue #2013](https://github.com/andromarces/agent-loops/issues/2013)
- [PR #2014: Fold a closing-block list item that opens with a plain label name](https://github.com/andromarces/agent-loops/pull/2014)
- [ADR 0167: Fold a second dash list and a prose line under one closing-block label](0167-fold-a-second-dash-list-and-prose-line-under-one-label.md)
- [ADR 0139: Name no outside-block label without outside text](0139-name-no-outside-block-label-without-outside-text.md)
- [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md)
- Implementation:
  - Fold: `LABEL_DASH_ITEM` and `reportDetail` in `src/lib/report.mjs`
  - Rendered rule: `reportBlock` in `src/prompts/rules.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs` and `tests/prompts/rules.test.mjs`
- [ADR Index](README.md)
