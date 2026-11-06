# 0078. Record a hand refresh of a copied local file

## Status

accepted

Partially supersedes [ADR 0074: Report the side that changed in localFilesDiffer](0074-report-the-side-that-changed-in-local-files-differ.md). This ADR replaces decision 2's init-hash compare with a stored hash that a recorded refresh updates. It also names `refresh-local` for decision 5's source action. Decisions 1, 3, and 4, and decision 5's action for `copy`, still hold.

## Date

2026-11-06

## Context

ADR 0074 gives `localFilesDiffer` a side. A source that the parent refreshes by hand changes the copy, so every later envelope reports `both`. The rules call `copy` a turn breach and give no action for `both`. The parent cannot read a secret file to decide. Issue #1534 records the case. A refresh needs a runtime record, not a hand copy.

## Decision

1. **Command.** `agent-loop role refresh-local --cwd <dir> --path <path> --parent-session <id>` copies one copied local file over its run copy. Only the parent session runs it, on a non-terminal run, with the stored parent session id. A child role is refused.
2. **Stored hash.** The command stores the refreshed copy's SHA-256 for the named path only. Every other path keeps its stored hash. Content and hashes never reach an envelope, a log line, or an error text.
3. **Guards.** The command refuses a path that init did not copy, an absolute path, a path that leaves the work tree, a missing or unreadable side, a link at the file or a parent component, and a copy that differs from its stored hash. A refused refresh writes nothing.
4. **Meaning.** The stored hash is the last content that the runtime recorded, not only the init content. `both` means the current copy has no recorded refresh, so it stays a breach.
5. **Action.** The docs and the headless prompt tell the parent to run `refresh-local` for `changed: "source"` when no `localSourceChangedInTurn` entry names the path. A `localSourceChangedInTurn` path still needs the user before any refresh.

## Consequences

- A recorded refresh stops the repeated `both` report until a side changes again.
- A copy that a turn changed cannot be refreshed, so the breach stays reported.
- A legacy state with no hash refuses the refresh, so the parent re-inits the run.
- The state field keeps one hash per copied file and never content.

## Alternatives

1. **Document `both` only**: rejected. It leaves the parent unable to record its own refresh.
2. **Refresh on any `source` report without a command**: rejected. The runtime cannot tell a parent copy from a turn edit.
3. **Store both an init hash and a current hash**: rejected. One stored hash answers the compare, and the refresh guard checks it.

## Authors

Andro Marces

## Links

- [Issue #1534](https://github.com/andromarces/agent-loops/issues/1534)
- Implementation: `refreshLocalFile` in `src/lib/local-files.mjs`, the `refresh-local` operation in `src/role/index.mjs`, and `--path` in `src/role/args.mjs`
- Documented in [Local files copied into the work tree](../docs/orchestrator/local-files-copy.md), the [orchestrator instructions](../docs/orchestrator-instructions.md), the [role reference](../docs/reference/role.md), and the headless orchestrator prompt in `src/prompts/orchestrator.mjs`
- Extends [ADR 0018](0018-copy-local-files-into-a-linked-run-work-tree.md)
- Supersedes (partially): [ADR 0074](0074-report-the-side-that-changed-in-local-files-differ.md), decision 2's init-hash compare, and decision 5's source action
- [ADR Index](README.md)
