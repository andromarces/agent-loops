# 0120. Take an operator focus and keep every actionable finding

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0109: Coordinate reviewer audits and consolidated issue creation](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md). These parts are replaced:

- Decision 4's reviewer goal, which asks for defects only and one finding per actionable defect.
- Decision 6's rule that the consolidation worker "drops a finding that is not a defect against the revision".

Every other decision, consequence, and acceptance check of ADR 0109 stays in force. In particular, the frozen revision, the read-only reviewer turn and its mutation check, the gate that waits for every audit, the runtime-owned issue write, the dedupe rules, the frozen issue set, and the store rules are unchanged.

## Date

2026-11-09

## Context

ADR 0109 fixed one goal for every reviewer: report actionable defects. An operator can ask for a different review, for example refactoring, cleanup, documentation, code organization, outdated direct dependencies, or test cost. Such a request is lost today. Reviewers look for defects only, and a non-defect finding that a reviewer still reports can be dropped at consolidation. The audit must accept the operator focus, carry it through a retry, and keep every finding that someone can act on.

## Decision

### 1. `batch audit start` accepts one focus source

`agent-loop batch audit start` accepts `--focus <text>` and `--focus-file <path>`. They mirror `--task` and `--task-file` of the single-task loop. The two flags are mutually exclusive. An empty or blank focus text, and a focus file with empty or blank content, are usage errors that exit 2 before any store, work tree, or child exists.

`batch audit resume` and `batch audit approve` accept neither flag. Either flag on those commands is a usage error that exits 2 and writes nothing.

### 2. A supplied focus is the only reviewer goal

When a focus is supplied, the audit prompt replaces its defect-only goal with the focus text. The focus is the only goal of each reviewer turn. The reviewer safety rules stay unchanged: the turn is read-only, it makes no remote write, and the `reviewerPrompt` wrapper rules still apply.

Without a focus, each reviewer reports any item someone can act on, defects included, with no defect-only wording.

### 3. Consolidation keeps every actionable item

The consolidation worker merges duplicate findings and keeps every item someone can act on that any reviewer reported, even an item outside the focus. It drops only duplicates. It holds no rule that drops a finding because it is not a defect. The rule does not read "a defect or an improvement", because a finding can be actionable and be neither.

### 4. The focus is stored and reused

The audit record stores the resolved focus. `batch audit resume` reruns a failed reviewer with the stored focus, and `batch audit approve` uses it for consolidation. `batch audit status` shows it. Neither command accepts a focus flag, so a retry cannot change the goal of an audit.

### 5. The agent-session path and the reference docs name the flags

The audit paragraph of `docs/orchestrator-instructions.md`, the `Reviewer audits` section of `docs/reference/usage.md`, and the `batch audit` lines of `src/help.mjs` name `--focus` and `--focus-file`.

## Consequences

- An operator can direct one audit at a non-defect concern without a second command or a manual prompt.
- A reviewer that reports an actionable item outside the focus keeps it, so the issue set is not narrowed by the consolidation step.
- A retry of a focused audit keeps its goal from the store, so the operator does not repeat the focus and cannot change it halfway.
- An empty focus is refused before a run, so a reviewer can never receive an empty goal.
- An audit created before this change has no stored focus and reads as an unfocused audit.

## Alternatives

1. **Add a second free-text prompt after the audit prompt.** Rejected. It would compete with the only goal, and the reviewer safety wrapper already owns the other rules.
2. **Keep the defect goal and add the focus as a hint.** Rejected. A reviewer would still prefer defects, and the operator request would stay advisory.
3. **Let `resume` and `approve` take a new focus.** Rejected. A retry would change the goal of an audit whose successful reviewers ran with the earlier goal.
4. **Drop non-actionable findings at consolidation.** Rejected. The runtime cannot separate a weak finding from a valid non-defect item, and a dropped finding leaves no record.

## Owner decisions

1. Focus input is `--focus <text>` and `--focus-file <path>` on `batch audit start` only, mutually exclusive, with blank text refused.
2. A supplied focus is the only reviewer goal. With no focus, the goal is any item someone can act on.
3. Consolidation keeps every actionable item that any reviewer reported, even outside the focus, and drops only duplicates.
4. `resume` and `approve` take no focus flag and always use the stored focus.

## Authors

Andro Marces

## Links

- [Issue #1750: Let batch audit start take an operator focus and keep every actionable finding](https://github.com/andromarces/agent-loops/issues/1750)
- [PR #1752: Let batch audit start take an operator focus and keep every actionable finding](https://github.com/andromarces/agent-loops/pull/1752)
- [ADR 0109: Coordinate reviewer audits and consolidated issue creation](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md)
- [Implementation: audit supervisor](../src/batch/audit.mjs)
- [Implementation: audit arguments](../src/batch/audit-args.mjs)
- [Implementation: audit prompts](../src/batch/audit-prompts.mjs)
- [Implementation: batch command](../src/batch/cli.mjs)
- [Implementation: help text](../src/help.mjs)
- [Tests: audit coordination](../tests/batch/audit.test.mjs)
- [ADR Index](README.md)
