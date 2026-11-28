# 0167. Fold a second dash list and a prose line under one closing-block label

## Status

partially-superseded

Partially superseded by [ADR 0168: Fold a closing-block list item that opens with a plain label name](0168-fold-a-plain-label-list-item.md). The replaced part is the decorated-label rejection of decision 4, for a `- ` item or sub-item that opens with a plain report label name and a colon inside a list run that folds under a label. Every other decorated label stays unparseable. Decisions 1, 2, 3, and 5 stay in force, and so does every other rejection of decision 4.

Partially superseded by [ADR 0182: Fold a prose section with no list under one closing-block label](0182-fold-a-prose-section-with-no-list-under-one-closing-block-label.md). The replaced part is the section definition of decision 1: "A section is a bare dash run, or a prose lead with its dash run." A section is now a bare dash run, a prose lead with its dash run, or a plain prose section with no list inside a run that holds a plain prose lead with its dash list. Every other sentence of decision 1 stays in force. Decision 4 stays in force except for the exception of [ADR 0168](0168-fold-a-plain-label-list-item.md), which remains in force: a dash item or sub-item that opens with a plain report label name is item text inside a folding run. Decisions 2, 3, and 5 stay in force. Every sentence of the Consequences section stays true, because each one names a lead with its list or a refusal, not a bare prose line.

## Supersedes

This ADR partially supersedes [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md). The replaced part is the "prose between two lists" item of decision 3. The other decisions stay in force, and so does every other rejection of decision 3.

## Date

2026-11-18

## Context

Issue #2005 recorded a Claude worker report with two `Why:` dash lists and a prose line between them. `parseReportBlock` at `ffaf28d0` returned null for that shape, so the parent read `raw`.

A probe at `ffaf28d0` replayed the six shapes from the issue. The plain list, the list and prose pair, and the blank line and list all parsed. The list and second list, the full issue shape, and the list and prose and list without blank lines returned null.

The issue offers a fold or a prompt bar. The fold follows [ADR 0140](0140-fold-every-closing-block-list-level.md), which folds every list level and every one-blank-line shape that #1917 reported.

The second review round found a third run through a prose lead. This ADR now states the whole unit sequence under one label.

The third review round found that a two-run cap dropped 192 `origin/main` shapes, an ordered first run included. This ADR now states the general section rule and the zero-regression bar.

The fourth review round found a bold lead and a folded table in new sections. This ADR now names the lead rules and the table refusal.

## Decision

1. **Accept any number of sections under a label.** After the label value, exactly one blank line comes before each section. A section is a bare dash run, or a prose lead with its dash run. The lead follows the prose-lead rules, the whole-line bold heading included. A plain lead's list sits directly under it or after one blank line, and a bold lead's list sits directly under it.
2. **Keep every origin/main result.** Every shape that parses at `origin/main` keeps the same items and value here. Two blank lines, or no blank line before a section, start no new section, so the `origin/main` result stays. A blank that one section consumes never counts for the next.
3. **Apply the fold once.** The shared parse in `src/lib/report.mjs` serves the dispatch envelope, interactive `role finish --require-accept`, and headless `runLoop` with `requireAccept` true.
4. **Keep every other rejection.** A decorated label, a list after the reviewer `Verdict:` line, and a table pair stay unparseable. A prose line with a label name and a colon, and an ordered list under a prose line, also stay unparseable.
5. **State the rule in the prompt and the docs.** `reportBlock` in `src/prompts/rules.mjs` and `docs/orchestrator/closing-block.md` state the section rule, the bold lead, and the refusals.

## Consequences

- The issue #2005 shape parses, and every item of both dash lists and the prose line stays in the value.
- Two blank-separated prose subsections, after a dash or ordered first run, keep all three runs.
- A whole-line bold lead starts a new section, and its list sits directly under it.
- A table inside a new section keeps the block unparseable, as the table rule states.
- Every shape that parsed at `origin/main` keeps its value here, so the differential check found no regression.
- Two blank lines, or no blank line before a section, start no new section.
- The dispatch envelope, the interactive gate, and the headless gate read the same report, because all three use the shared parse.
- A repair turn no longer treats the second dash list as a defect that needs no content change.

### Probe

- The differential check enumerated 6,725,600 sequences of up to eight units. The units are a dash run, an ordered run, a prose lead, a bold lead, a table item, one blank line, and two blank lines.
- 2,465 sequences are newly parseable, and every one matches the general section rule.
- No sequence regresses, so every shape that parsed at `origin/main` keeps its value here.
- No newly parseable sequence holds a table item, so the table guard covers every new section.
- The two earlier review shapes parse here and at `origin/main`.

## Alternatives

1. **Bar the shape in the prompt and repair it.** Not taken. The fold keeps the report that the worker already wrote, and the repair turn has a content-match guard.
2. **Fold the shape with no blank lines too.** Not taken. The issue names the blank-line form, and the wider fold changes another refusal.

## Authors

Andro Marces

## Links

- [Issue #2005](https://github.com/andromarces/agent-loops/issues/2005)
- [PR #2007: Fold a second dash list and a prose line under one label](https://github.com/andromarces/agent-loops/pull/2007)
- [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md)
- Implementation:
  - Fold: `foldEmptyLabelLists` in `src/lib/report.mjs`
  - Rendered rule: `reportBlock` in `src/prompts/rules.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/prompts/rules.test.mjs`, `tests/role/finish.abort.test.mjs`, and `tests/runtime.require-accept.test.mjs`
- [ADR Index](README.md)
