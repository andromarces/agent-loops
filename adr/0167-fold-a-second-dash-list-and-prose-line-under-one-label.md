# 0167. Fold a second dash list and a prose line under one closing-block label

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md). The replaced part is the "prose between two lists" item of decision 3. The other decisions stay in force, and so does every other rejection of decision 3.

## Date

2026-11-18

## Context

Issue #2005 recorded a Claude worker report with two `Why:` dash lists and a prose line between them. `parseReportBlock` at `ffaf28d0` returned null for that shape, so the parent read `raw`.

A probe at `ffaf28d0` replayed the six shapes from the issue. The plain list, the list and prose pair, and the blank line and list all parsed. The list and second list, the full issue shape, and the list and prose and list without blank lines returned null.

The issue offers a fold or a prompt bar. The fold follows [ADR 0140](0140-fold-every-closing-block-list-level.md), which folds every list level and every one-blank-line shape that #1917 reported.

The second review round found a third run through a prose lead. This ADR now states the whole unit sequence under one label.

## Decision

1. **Accept one explicit unit sequence under a label.** The value takes at most one dash run directly under the label or after one blank line. One more dash run can follow after one blank line. Plain prose leads follow, each with its dash run directly under it or after one blank line.
2. **Count every dash run.** A prose lead's dash run counts. At most two runs join one value. A third run, a prose chain past two runs, and every other list shape leave a dropped list, so the block is unparseable.
3. **Apply the fold once.** The shared parse in `src/lib/report.mjs` serves the dispatch envelope, interactive `role finish --require-accept`, and headless `runLoop` with `requireAccept` true.
4. **Keep every other rejection.** A decorated label and a list after the reviewer `Verdict:` line stay unparseable. A prose line with a label name and a colon, a two-blank-line gap, and an ordered list under a prose line also stay unparseable.
5. **State the rule in the prompt and the docs.** `reportBlock` in `src/prompts/rules.mjs` and `docs/orchestrator/closing-block.md` state both new folds and the two-run limit.

## Consequences

- The issue #2005 shape parses, and every item of both dash lists and the prose line stays in the value.
- The replay row with no blank lines before the prose stays null, because the prose fold needs the blank line above.
- A third dash run, including a prose chain past two runs, keeps its `origin/main` refusal.
- A two-blank-line gap and a prose lead with no blank line above keep their `origin/main` refusal.
- The dispatch envelope, the interactive gate, and the headless gate read the same report, because all three use the shared parse.
- A repair turn no longer treats the second dash list as a defect that needs no content change.

### Probe

- The differential check enumerated 340 sequences of up to four units under one label. The units are a dash run, a prose lead, one blank line, and two blank lines.
- Eight sequences differ from `origin/main`. Seven are second-run shapes, and one is a prose lead with a blank-separated list.
- An extended check over 87,380 sequences of up to eight units found 1,575 differences. Every one is a second-run, prose-blank-list, or three-run shape.
- The second-round blocker shape holds two runs, a prose lead, and a third run. It returns null here and at `origin/main`.

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
