# 0042. Remove the reviewer scratch folder in the runtime

## Status

accepted

## Date

2026-10-17

## Context

The reviewer prompt tells the reviewer to remove the output that it wrote under an ignored path (issue #906). A Codex reviewer cannot always do that, because its automatic approval review can refuse the delete command. The output then stays in the target work tree, for example `.wrangler` folders, test cache folders, and pnpm junctions. No runtime step removed it (issue #920).

## Decision

1. **One folder per reviewer turn.** Before the turn, the runtime creates `<work tree root>/.agent-loop/rev/<id>`, with an 8-character hex id. The path stays short (issue #903). The reviewer prompt names the folder as the first place for probe and test output, and states that the runtime removes it. A worker turn and the task-only reviewer turn get none.
2. **Ignore rule inside the folder.** The folder holds a `.gitignore` that contains `*`. That rule ignores the folder and the `.gitignore` itself. The choice needs no change to the target `.gitignore` or to `.git/info/exclude`, and it holds in a linked work tree, where `.git` is a file. Git lists no directory whose files are all ignored, so the mutation check sees none of it.
3. **Order.** The runtime creates the folder before the before-snapshot. It removes the folder after the after-snapshot, in a `finally` around the mutation check. The folder is ignored, so neither snapshot lists it. The removal can neither read as a reviewer mutation nor hide one. A write to any other ignored path is still no mutation.
4. **Every outcome.** The removal runs after an ok turn, a handled error, a cancel, a detected mutation, and a snapshot failure.
5. **No link following.** The removal uses `fs.rm` with `recursive` and `force`. It unlinks a symbolic link or a Windows junction as an entry and never follows it. Nothing outside the folder is deleted. The runtime then removes the empty `rev` and `.agent-loop` folders with a plain `rmdir`, which fails on a folder that holds another entry.
6. **Failure is soft.** A failed creation logs a warning at `warn`, and the turn runs with the earlier prompt wording. A failed removal logs a warning at `warn` and never fails or halts the run.
7. **Kept rule.** The `Notes` rule of issue #906 stays for output outside the scratch folder.

## Consequences

- A reviewer that cannot delete leaves no scratch output when it writes to the named folder.
- Output outside the folder still depends on the reviewer. The runtime does not remove it.
- A reviewer that replaces `.agent-loop` or `.agent-loop/rev` with a link can make the removal follow that parent link. The runtime does not check parent folders.
- A repository that tracks a file under `.agent-loop/rev` can show a change during a turn.
- A removal on Windows junctions is not yet verified on Windows. The checklist of issue #709 holds that item.

## Alternatives

1. **A folder outside the repository, in the OS temp directory.** Not taken. A Codex reviewer often cannot delete there, and a sandboxed turn can lack write access there (issue #885).
2. **A line in `.git/info/exclude`.** Not taken. It changes the shared Git directory of every linked work tree, and the path differs when `.git` is a file.
3. **A line in the target `.gitignore`.** Not taken. It changes a tracked file.
4. **Remove all ignored output.** Rejected. It deletes `node_modules` and any output that a later step needs.

## Authors

Andro Marces

## Links

- [Issue #920](https://github.com/andromarces/agent-loops/issues/920)
- Related issues: #865, #885, #903, #906
- [ADR 0038: Run the Codex reviewer with no sandbox by default](0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)
- Implementation:
  - Source: `src/lib/reviewer-scratch.mjs`, `runChild` in `src/child-turn.mjs`, `reviewerPrompt` in `src/prompts/reviewer.mjs`
  - Tests: `tests/lib/reviewer-scratch.test.mjs`, `tests/child-turn.reviewer-scratch.test.mjs`, `tests/prompts/reviewer.test.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/reference/reviewer-safety.md`
- [ADR Index](README.md)
