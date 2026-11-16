# 0165. Render the task placeholders in a per-item task text

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0121: Run issue, pull request, and free-text task items in one batch](0121-mix-issue-pull-request-and-task-items-in-one-batch.md).
The replaced part is decision 5's sentence that a `task` field "replaces the task template for that
item only", which `taskTextFor` read as verbatim text. A per-item `task` now renders the template
placeholders. Every other sentence of decision 5, and every other decision, consequence, and
acceptance check of ADR 0121, stays in force.

## Date

2026-11-16

## Context

`taskTextFor` in `src/batch/worker.mjs` returned an explicit per-item `task` verbatim. The
`--task-template` value rendered `{issue}`, `{title}`, `{branch}`, and `{repo}`, and refused an
unknown placeholder. A per-item task had neither the rendering nor the refusal.

An issue item runs on branch `batch/<batch id>/<issue>`, as `loop-records.mjs` records. The batch id
is created at `start`, so the skill cannot know it when it writes the items file. A per-item task
therefore could not name the branch that the worker must push with a named refspec, and the
orchestrator rules require `git push -u origin <branch>` and forbid a plain `git push`.

The default template names `{branch}`, so an item with no `task` was not affected. The gap appeared
when an item needed its own scope, for example a partial resolution that must say `Refs #N` instead
of `Closes #N`.

## Decision

1. **A per-item task renders the template placeholders.** It resolves `{issue}`, `{title}`,
   `{branch}`, and `{repo}` with the values and the rules of `--task-template`. `{branch}` is the
   loop branch, so an issue item receives `batch/<batch id>/<issue>`. `{repo}` is the repository of
   the batch. `{issue}` is the item number for an issue or a pull request, and the identity
   `task-<id>` for a free-text task. `{title}` is the loop title, and the item text for a free-text
   task, which has no pull request title.
2. **An unknown placeholder is refused before any state write.** A per-item task with an unknown
   placeholder exits 2 with the `--task-template` message, before any claim, work tree, checkpoint,
   or child exists. The `{issue}` requirement applies to `--task-template` only, because a per-item
   task replaces that template for its item.
3. **The reference page and the help text state the rendering.** The `Batch runs` page at
   `docs/reference/batch.md`, the batch-runs skill page, and the `batch` help text in
   `src/batch/cli.mjs` document the rendered placeholders and the refusal.

## Acceptance checks

1. A per-item task that names `{branch}` receives the loop branch of its issue item.
2. A per-item task that names `{issue}`, `{title}`, and `{repo}` receives the same values as the
   task template.
3. An unknown placeholder in a per-item task exits 2 before any state write.
4. A per-item task without `{issue}` is accepted.
5. The batch reference and the `batch --help` text state the rendering.

## Consequences

- A per-item task can name the exact branch for its named push, so the worker no longer reads the
  push target from the work tree.
- A per-item task with a literal brace pair that is not a placeholder is now refused, as the
  template already was. A task that needs such text must rephrase it.
- The rendering happens at launch, where the branch exists. The child and the transcript receive the
  rendered text.

## Alternatives

1. **Render only `{branch}` in a per-item task.** Rejected. Two placeholder rule sets would diverge,
   and an unknown placeholder would still reach the child verbatim.
2. **Render the per-item task when the items file is read.** Rejected. The batch id exists only
   after `start`, and a pull request branch is known only after the head read.
3. **Keep the per-item task verbatim and let the worker read the branch.** Rejected by issue #1998.
   The push target then came from the worker's own read, not from the runtime.

## Authors

Andro Marces

## Links

- [Issue #1998: Render template placeholders in the per-item task text of a batch](https://github.com/andromarces/agent-loops/issues/1998)
- [PR #1999: Render template placeholders in a per-item task text](https://github.com/andromarces/agent-loops/pull/1999)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0121: Run issue, pull request, and free-text task items in one batch](0121-mix-issue-pull-request-and-task-items-in-one-batch.md)
- [Implementation: headless worker](../src/batch/worker.mjs)
- [Implementation: batch command and settings](../src/batch/args.mjs)
- [ADR Index](README.md)
