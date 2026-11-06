# 0074. Report the side that changed in localFilesDiffer

## Status

partially-superseded

Partially superseded by [ADR 0075](0075-report-a-copied-source-that-changed-inside-a-turn-window.md) and [ADR 0078](0078-record-a-hand-refresh-of-a-copied-local-file.md).

- Decision 5's action for `changed: "source"`: superseded by [ADR 0075](0075-report-a-copied-source-that-changed-inside-a-turn-window.md). When `localSourceChangedInTurn` names the path, the parent reports it under `open` and asks the user before a refresh.
- Decision 2's init-hash compare and decision 3's init-hash comparison: superseded by [ADR 0078](0078-record-a-hand-refresh-of-a-copied-local-file.md). Both sides are compared with the stored hash, which a recorded refresh updates.
- Decision 5's source action: superseded by [ADR 0078](0078-record-a-hand-refresh-of-a-copied-local-file.md). That action names `role refresh-local`.

The rest remains in force:

- Decision 1, the init hash write.
- Decision 3, except the init-hash comparison.
- Decision 4, the report shape.
- Decision 5's action for `changed: "copy"` and for a source that no turn window names.

## Date

2026-11-05

## Context

ADR 0018 copies ignored local files into a linked run work tree. `localFilesDiffer` names a copy that differs from its source after init. The name does not say which side changed. A source change needs a manual copy refresh, while a copy change is a rule breach. The parent cannot read a secret file to decide. Issue #1501 records an observed `.env` case.

## Decision

1. **Init hash.** The init stores a SHA-256 hash of each copied file in the run state as `localFilesCopiedSha256`. The hash never reaches an envelope, a log line, or an error text.
2. **Side report.** A later dispatch compares each source and copy with its init hash. The envelope lists `localFilesDiffer` as `{path, changed}` entries, absent when neither side changed. `changed` is `source`, `copy`, or `both`.
3. **Fail closed.** A legacy state with no hash field or a malformed hash value reports `unknown`. `unknown` never means no change. A side counts as changed when it is missing, unreadable, or its hash differs from the init hash. A path with both sides changed reports `both`, and only a path that both sides prove unchanged is left out.
4. **Report shape.** Paths keep the redaction and 20-entry cap of the other path fields. The plain-list shape changes, and the docs state the new shape.
5. **Actions.** The docs and the headless prompt tell the parent to refresh the copy for `source` and to report a breach under `open` for `copy`.

## Consequences

- A parent can act on the reported side without reading the file.
- A legacy state reports every copied path as `unknown` once. The parent refreshes or re-inits.
- The state file grows by one hash per copied file, never by content.
- A source that changes and returns to the init bytes is not reported.
- A copy that a turn changes and restores is not reported.

## Alternatives

1. **Two lists**: rejected. One list with a side keeps each path and its cause together.
2. **Report the side from source and copy alone**: rejected. A turn can change both to the same bytes.
3. **Treat a legacy state as unchanged**: rejected. It cannot prove the side, so it fails closed.

## Authors

Andro Marces

## Links

- [Issue #1501](https://github.com/andromarces/agent-loops/issues/1501)
- [Pull request #1503](https://github.com/andromarces/agent-loops/pull/1503)
- Implementation: `hashCopiedLocalFiles` and `findLocalFileChanges` in `src/lib/local-files.mjs`, the init hash and envelope report in `src/role/dispatch.mjs`
- Documented in [Local files in a linked work tree](../docs/reference/harness-entry-points.md#local-files-in-a-linked-work-tree), [Local files copied into the work tree](../docs/orchestrator/local-files-copy.md), and the headless orchestrator prompt in `src/prompts/orchestrator.mjs`
- Extends [ADR 0018](0018-copy-local-files-into-a-linked-run-work-tree.md)
- [ADR Index](README.md)
