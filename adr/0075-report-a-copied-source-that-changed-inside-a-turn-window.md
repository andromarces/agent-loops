# 0075. Report a copied source that changed inside a turn window

## Status

accepted

## Date

2026-11-05

## Context

ADR 0074 gives `localFilesDiffer` a `changed` side. A source that changed after init reports `source`, and the docs then tell the parent to refresh the copy by hand. A worker turn that writes the main `.env` reports the same side as a change between two turns. The documented action would copy content that the turn wrote. The worker and reviewer prompts forbid reading or editing an ignored secret file, so that write is a rule breach that the parent must report. Issue #1504 records it.

`mainWorkTreeChanged` reads dirty, untracked, and unignored paths only, so an ignored source never appears in it.

## Decision

1. **Turn window.** Before and after each worker and reviewer turn, the runtime hashes every path of `localFilesCopied` in the main work tree. The read uses the guarded compare of ADR 0074.
2. **Report.** A path whose two hashes differ is named in that turn's envelope as `localSourceChangedInTurn`, a list of paths, redacted and capped at 20. The field is absent when no source changed, the list is empty, or the read failed.
3. **No content.** Only paths are reported. No hash or content reaches an envelope, a log line, an event, or an error text.
4. **No actor.** The field reports a change observed between two reads. The user or another process can cause it.
5. **Action.** The docs tell the parent to report the path under `open` and ask the user before a refresh. A refresh would copy content that the turn wrote.
6. **Both entry points.** The window runs in `runChild`, so the role dispatch and the headless loop both report it, for both roles.

## Consequences

- A turn that writes a copied source is attributed to that turn, before the next dispatch reads the side.
- A source that changes and returns to its previous bytes inside the window is not reported.
- A path that hashes on one side only is reported. A failed read reports no field, so the absent field proves nothing.
- The runtime reads every copied source twice per turn. A large copy adds that read to each turn.
- The field reports no actor, so the parent asks the user instead of acting.

## Alternatives

1. **Add a `turn` side to `localFilesDiffer`**: rejected. That compare runs before the next turn, not inside the turn window, so it cannot attribute the write to that turn.
2. **Add ignored paths to `mainWorkTreeChanged`**: rejected. That read runs only for worker turns, excludes ignored paths, and its action stops the run.
3. **Store only the init hash and compare once**: rejected. The window needs a hash on each side of the turn.

## Authors

Andro Marces

## Links

- [Issue #1504](https://github.com/andromarces/agent-loops/issues/1504)
- [Pull request #1507](https://github.com/andromarces/agent-loops/pull/1507)
- Implementation: `hashCopiedLocalSources` in `src/lib/local-files.mjs`, the turn window in `src/child-turn.mjs`, and the evidence field in `src/lib/turn-evidence.mjs`
- Documented in [Local files copied into the work tree](../docs/orchestrator/local-files-copy.md), the [orchestrator instructions](../docs/orchestrator-instructions.md), and [Local files in a linked work tree](../docs/reference/harness-entry-points.md#local-files-in-a-linked-work-tree)
- Extends [ADR 0074](0074-report-the-side-that-changed-in-local-files-differ.md)
- [ADR Index](README.md)
