# 0071. End the Codex reviewer command tree on POSIX after a parent signal

## Status

accepted

Partially supersedes [ADR 0034: Keep the Codex reviewer descendant gap after a parent end](0034-keep-the-codex-reviewer-descendant-gap-after-a-parent-end.md) (decisions 1, 2, and 5). ADR 0034 is `partially-superseded`, because its decisions on detection before a turn and on the operator check still hold.

## Date

2026-11-02

## Context

Issue #1326 repeats the probe of issue #708 on macOS 27.2 (arm64), with Node v27.0.0-alpha.0.0.0, codex-cli 0.166.0, and repository head `4145e480`. A `SIGTERM` of the headless parent ended the Codex CLI, but not the reviewer command tree.

The probe recorded eleven descendant pids before the signal. The Codex CLI ran in group 4246. A command tree (`/bin/zsh`, `sh ./check.sh`, `sleep 60`) ran in its own group 5175.

No Codex pid was alive 1.5 s after the signal. The command tree stayed alive, and `orphan-write-rev.txt` appeared 60.157 s after the signal.

The runtime starts the Codex child with `killDescendants: true` (`src/lib/exec.mjs`). Execa sends the signal to the process group of the child. A process that left that group never receives the signal, and the child does not learn the group ids of its descendants.

## Decision

1. The Codex adapter marks its child with `treeEnd` on the `exec` call (POSIX only). Every other adapter keeps its current behavior, and so does the Windows path with `taskkill /T`.
2. On the first `SIGINT`, `cancelOnSigInt` walks the tree before `controller.abort()`. The abort kills the process group of the child. A descendant that left that group is linked only while the child lives.
3. On the second `SIGINT`, the force path walks the tree before `killLiveTrees()`. The exit stays 130, and the final write and the transcript do not change.
4. On `SIGTERM`, a listener walks the tree, removes itself, and re-sends `SIGTERM`. The parent still ends by `SIGTERM`, so the shell observes 143 (ADR 0033).
5. The walk reads `ps -eo pid=,ppid=,lstart=` once. It selects the rows whose parent chain reaches a live child pid. A second read drops a pid that is gone or whose start stamp changed, so a reused pid is never signaled (ADR 0020).
6. Each remaining row receives `SIGKILL`, so a descendant that traps `SIGTERM` cannot outlive the walk. The signal path of the parent stays the same for every other process.
7. Only the live children that registered `treeEnd` are roots. A process of another run is not in the parent chain of a root, so it is never signaled.
8. Each table read is bounded at 2 s and is ended with `SIGKILL` past the bound. A failed, timed-out, or unparseable read ends the walk with no kill. Every error is caught, so a failed walk never fails the parent exit. A parent end waits at most two reads, about 4 s, plus the kill calls.
9. The tests are POSIX only where the path needs a POSIX signal. A `SIGTERM` integration test starts a parent that runs a detached command tree through `exec` with `treeEnd`. Further tests cover the first and the second `SIGINT`, a second tree, and a changed start stamp. They also cover a failed read, a reparented process, and a hanging `ps` that must end at the read bound. The `SIGINT` exit and transcript assertions stay as documented.

## Consequences

- A descendant of the Codex child that left its process group but kept its parent chain now ends with the parent. This closes the write of the issue #1326 probe.
- These gaps stay. A descendant that left the group and lost its parent chain, for example reparented to pid 1, is not found. A `SIGKILL` of the parent runs no handler. A pid reused between the second read and the signal is a small window. A process that a descendant starts after the walk is not found.
- A failed or bounded table read skips the end. The operator check of ADR 0034 decision 4 therefore stays in force for these gaps.
- A non-Codex adapter and the Windows path behave as before. The group signal of execa is unchanged on every path.
- Probe evidence covers a `SIGTERM`, one `SIGINT`, and two `SIGINT` of the real CLI process. Each run had a detached command tree and an unrelated process. In every run the tree and the Codex child ended, the unrelated process stayed alive, and no orphan write appeared. The `SIGINT` runs exited 130 with the transcript error `Interrupted by SIGINT`.
- The cost is two synchronous `ps` reads per parent signal, bounded as in decision 8. A host without `ps` on `PATH` skips the end.

## Alternatives

1. **Send `SIGKILL` to the process group only**: rejected. The probe tree was in its own group, so the signal never reached it.
2. **Take a periodic snapshot of the descendants of the child**: rejected. It costs a repeated table read, and it still races a descendant that starts or reparents between reads.
3. **Use a Linux subreaper or a cgroup for the child**: rejected. Node exposes no API for either, and macOS is the host of the probe.
4. **Signal every process of a matching name**: rejected. It ends the processes of other runs on the host (ADR 0007, ADR 0032 decision 4).
5. **Detect and end the tree on the next run**: rejected. The runtime would signal a process that it did not start in this run (ADR 0031 decision 7).
6. **Keep the gap of ADR 0034**: rejected. The probe shows a command that writes after a clean review, so the smaller risk is the bounded walk at the parent end.

## Authors

Andro Marces

## Links

- [Issue #1326: End the Codex reviewer command tree on POSIX after a parent signal](https://github.com/andromarces/agent-loops/issues/1326)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [ADR 0034: Keep the Codex reviewer descendant gap after a parent end](0034-keep-the-codex-reviewer-descendant-gap-after-a-parent-end.md)
- [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- Implementation: `src/lib/exec-tree.mjs`, `src/lib/sigint.mjs`, `src/lib/exec.mjs`, and `src/agents/codex.mjs`.
- Tests: `tests/lib/exec-tree.test.mjs`, `tests/lib/sigint.test.mjs`, and `tests/agents/codex.test.mjs`.
- [ADR Index](README.md)
