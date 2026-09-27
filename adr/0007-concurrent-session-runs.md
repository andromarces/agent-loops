# 0007. Concurrent role runs from one parent session

## Status

accepted

## Date

2026-09-27

## Context

One interactive parent session could drive only one `agent-loop role` run at a
time. `writeSessionIndex` wrote a single path at `<root>/sessions/<parent-session>`
and overwrote it on each init, `readStateForSession` read that one path, and
`decideParentGuard` evaluated only that state. Two init calls from one session in
two work trees both succeeded, and the second entry replaced the first, so one
run stayed active while the guard returned `allow`: a fail-open gap. The
one-run-per-session rule existed only as a prompt rule in
`docs/orchestrator-instructions.md` (#212).

## Decision

1. Init writes one entry per run at
   `<root>/session-runs/<parent-session>/<cwd hash>`, named after the state
   directory, with the state file path as content. Simultaneous inits in
   different work trees write different files, so no entry is lost and no
   session-level lock is needed. Re-init in the same work tree overwrites its
   own entry, serialized by the per-cwd `state.lock`.
2. The reader unions the new directory with the legacy single-path
   `<root>/sessions/<parent-session>` file. Init never writes the legacy file: a
   legacy entry whose run is active still denies, and one whose run is terminal
   allows. The `<root>/session-runs` directory name avoids a file-versus-directory
   conflict at the legacy path.
3. No pruning. Entries stay until the runs root is removed. Pruning at init can
   race a concurrent init in another work tree and delete a live entry, which
   opens a fail-open gap.
4. The guard denies when any readable entry resolves to a state with
   `parentSession` equal to the hook session id and a non-terminal lifecycle;
   otherwise it allows. A missing, unreadable, or corrupt entry or state file is
   skipped, so one corrupt record never hides another active run and never denies
   on its own.
5. No run cap. Each run keeps its own `--max-steps` budget.
6. `role dispatch` stays blocking. The instructions describe interleaved and
   background dispatch across the runs of one session.

## Consequences

- One parent session can fan out one worker-reviewer loop per issue.
- The guard reads a directory per session id instead of one file, so a session
  with many runs pays one read per entry.
- The legacy index file stays readable; a workspace written before the new
  format keeps its parent guarded.
- A run whose legacy index entry an earlier init overwrote before this upgrade
  stays unguarded; the upgrade cannot recover an entry that is already gone.
  Runs started after the upgrade register their own entry and are unaffected.
- A run's entry stays valid across archives because the state file path per work
  tree is constant.
- The one-run-per-session prompt rule is replaced by a per-work-tree rule.
- This amends [ADR 0006](0006-require-parent-session-for-interactive-runs.md)
  only in the index shape it implies; the requirement to pass `--parent-session`
  stands, so ADR 0006 stays `accepted`.

## Alternatives

1. **Keep one entry and add a session-level lock**: serializes init and still
   supports one run per session. Rejected; it does not fan out.
2. **Prune terminal entries at init**: removes dead entries, but races a
   concurrent init in another work tree and can delete a live entry. Rejected.
3. **Cap runs per session**: adds a setting without a safety gain. Rejected.

## Authors

Andro Marces

## Links

- [Issue #212: Support concurrent role runs from one parent session](https://github.com/andromarces/agent-loops/issues/212)
- [PR #226: feat: support concurrent role runs from one parent session (#212)](https://github.com/andromarces/agent-loops/pull/226)
- [ADR 0006: Require a parent session id for interactive runs](0006-require-parent-session-for-interactive-runs.md)
- [ADR Index](README.md)
