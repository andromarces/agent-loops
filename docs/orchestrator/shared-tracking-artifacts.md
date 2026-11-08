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
