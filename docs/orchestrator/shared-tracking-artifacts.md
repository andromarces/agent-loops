# Shared tracking artifacts

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you dispatch several runs in one repository.

Workers of runs in one repository can each create the
same tracking issue, for example a repository's singleton verification-checklist
issue, because the repository rules say to add to the open issue or open it if
none exists. Two workers that reach that step close together both find none and
both open one. The parent cannot write to GitHub, so a duplicate costs a later
worker turn to merge.

- Before dispatch, name every shared tracking artifact that a run can create, such
  as the issues that the repository rules treat as one per target.
- Assign the creation of each artifact to one run. Tell the other runs to add to
  it only after it exists, and never to create it.
- An artifact that already exists needs no assignment. Name it in each worker
  prompt, so no run creates another.

## Several runs at once

One parent session can drive several runs, one per work tree. Each run registers
a session entry keyed by the work tree. A second run in a different work tree
does not replace the first. The parent-edit guard stays engaged while any
session run is non-terminal.

- Interleave: dispatch one turn per run in turn, and read each envelope before
  the next dispatch. This works in every harness.
- Background: run each dispatch as a background shell command where the harness
  supports it, and read each envelope when it completes.

Every command for a run passes that run's `--cwd`. Each run ends with its own
`finish` or `abort`, and the guard releases only after every run is terminal.

Runs on one host share the test slot table, whose default count is 1 (ADR 0046).
A targeted test run with `--if-held` waits while any slot is held (ADR 0044). A
reviewer turn can then wait behind a full suite of another run. That wait, or
exit 75 from the wrapper, can leave a reviewer turn with no local test run. The
required CI checks are then its only test evidence, as
[Reviewer prompts and runtime evidence](reviewer-evidence.md) states. A parent
that starts concurrent runs can raise `AGENT_LOOP_TEST_SLOTS` before the first
dispatch, but 2 slots overloaded both measured hosts (ADR 0046).

## Concurrent edits of one issue body

Two workers of concurrent runs in one repository can edit the body of the same issue.
Each worker reads the body, adds an item, and writes the whole body back.
A write replaces the whole body, so two writes that overlap can drop the item of one run.

- Tell each worker of a concurrent run to read the body right before the write, with `gh issue view <n> --json body -q .body`.
- The worker changes only the target lines, writes the body, then reads the body again.
- The worker restores any item that the read before the write held and the read after it lacks.
- State the limit in each worker prompt: this narrows the race and does not remove it.
  A third write that lands between the two reads stays unseen.
  Assign the body edit to one run when a loss must not happen.

## Sequential identifiers

Workers of runs in one repository can each take the same sequential identifier, such as the next ADR number, a migration number, or a changelog entry. Each worker reads the base branch, finds the same next free number, and uses it. Each reviewer accepts its own branch, because each branch is consistent alone. The collision shows only at merge or in a later worker report.

- Before dispatch, name every sequentially numbered artifact that more than one run can create, such as an ADR or a migration.
- Reserve a distinct number for each run in its worker prompt. Tell the worker to use that number and no other.
- When a run needs one that was not foreseen, the parent assigns the number before the worker creates the file. Otherwise the worker reports the number that it took, and the parent checks it against the other active runs before the reviewer turn.
- Two branches that each add an index row, for example in `adr/README.md`, still conflict at merge. Name that pair in the finish summary under `open`.
