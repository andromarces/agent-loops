# Shared tracking artifacts

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you dispatch several runs in one repository.

- Before dispatch, name every shared tracking artifact that a run can create, such
  as the issues that the repository rules treat as one per target.
- Assign the creation of each artifact to one run. Tell the other runs to add to
  it only after it exists, and never to create it.
- An artifact that already exists needs no assignment. Name it in each worker
  prompt, so no run creates another.

## Concurrent edits of one issue body

- When two workers of concurrent runs can edit the same issue body, tell each worker to read the body right before the write, with `gh issue view <n> --json body -q .body`.
- The worker changes only the target lines, writes the body, then reads the body again.
- The worker restores any item that the read before the write held and the read after it lacks.
- State the limit in each worker prompt: this narrows the race and does not remove it.
  A third write that lands between the two reads stays unseen.
  Assign the body edit to one run when a loss must not happen.

## Sequential identifiers

- Before dispatch, name every sequentially numbered artifact that more than one run can create, such as an ADR or a migration.
- Reserve a distinct number for each run in its worker prompt. Tell the worker to use that number and no other.
- When a run needs one that was not foreseen, the parent assigns the number before the worker creates the file. Otherwise the worker reports the number that it took, and the parent checks it against the other active runs before the reviewer turn.
- Two branches that each add an index row, for example in `adr/README.md`, still conflict at merge. Name that pair in the finish summary under `open`.
