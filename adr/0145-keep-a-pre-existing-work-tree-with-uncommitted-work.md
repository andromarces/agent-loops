# 0145. Keep a pre-existing work tree that holds uncommitted work

## Status

accepted

## Date

2026-11-15

## Context

The orchestrator instructions said that the parent creates and owns the run work
tree, and that it removes that work tree when the run ends. A user can pass a
pre-existing linked work tree as `--cwd`, for example to review a fix that the
parent already wrote there. A `review-first` or `review-only` run that accepts
with no worker commit leaves that change uncommitted. A parent that followed the
removal rule ran `git worktree remove --force`, which discarded the only copy of
the change (issue #1932).

ADR 0018 copies ignored local files of the main work tree into a linked `--cwd`
at init. Those copies belonged to the run work tree, so their lifetime followed
the removal rule. ADR 0073 locks a linked `--cwd` for an active run and releases
it at a terminal lifecycle.

## Decision

1. The parent removes only the work tree that it created for this run.
2. A work tree that the parent did not create for this run stays. So does a work
   tree that holds uncommitted or unpushed work that the run did not create.
3. The parent keeps such a work tree until the work is committed or the user
   decides, and reports it under `open` in the finish summary.
4. The local files that init copied into a kept work tree stay until the work
   tree is removed.
5. Each parent text states the rule: `docs/orchestrator-instructions.md` states
   the exception and the `open` report, `docs/orchestrator/local-files-copy.md`
   states the exception and the copy lifetime, and
   `docs/orchestrator/work-tree-removal.md` names the exception in its opening
   condition.

## Consequences

- A run over a pre-existing linked work tree keeps that work tree after it ends,
  so a reviewed but uncommitted change survives. The user decides the later
  removal.
- A copied local file of a kept work tree is not deleted on its own.
- A work tree that the parent created keeps the existing removal step of
  `docs/orchestrator/work-tree-removal.md`.
- No runtime behavior changes. The cleanup is a parent step, and the runtime
  cannot attribute uncommitted work to a run.
- The finish summary names the kept work tree under `open`, so it does not claim
  a removal that did not happen.

## Alternatives

1. **Keep the unconditional removal rule.** Rejected. The observed run lost the
   only copy of a change, and the rule gave the parent no exception to apply.
2. **Remove the work tree in the runtime.** Rejected. The cleanup stays a parent
   step, and the runtime cannot attribute uncommitted work to a run.
3. **Keep the work tree whenever the run made no commit.** Rejected. A run that
   created the work tree and changed nothing has nothing to keep, so the existing
   removal step applies.

## Authors

Andro Marces

## Links

- [Issue #1932](https://github.com/andromarces/agent-loops/issues/1932)
- [Pull request #1951](https://github.com/andromarces/agent-loops/pull/1951)
- [ADR 0018: Copy untracked local files into a linked run work tree](0018-copy-local-files-into-a-linked-run-work-tree.md)
- [ADR 0073: Lock the work tree of an active run](0073-lock-the-work-tree-of-an-active-run.md)
- [Work tree ownership](../docs/orchestrator-instructions.md#work-tree-ownership)
- [Local files copied into the work tree](../docs/orchestrator/local-files-copy.md)
- [Removing a work tree](../docs/orchestrator/work-tree-removal.md)
- [ADR Index](README.md)
