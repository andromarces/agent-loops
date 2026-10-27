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
