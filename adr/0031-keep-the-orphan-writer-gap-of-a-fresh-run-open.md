# 0031. Keep the orphan writer gap of a fresh run open

## Status

accepted

## Date

2026-10-10

## Context

ADR 0029 refuses `--continue-from` when a live process names the session id of a Claude role. Issue #673 asks how a fresh run in the same work tree can find a live child of an earlier run, and how to find a holder that does not carry the id in its command line. A fresh run holds no earlier session id, so the id match of ADR 0029 cannot apply. The orphan is the `claude` child of a hard-killed runtime (ADR 0027, issue #627).

Two mechanisms were examined. Both need the link between a process and the work tree, or between a process and an earlier run.

- **Process working directory.** Probed on Windows 11 Pro 10.0.26220, PowerShell 7.6.6, Claude Code 2.1.296, Node v26.8.1. `Win32_Process` has no working-directory property, and no command line of a `claude` process on this host contains the path of the work tree. The runtime passes the work tree through the `cwd` option of `exec`, not through an argument (`src/agents/claude.mjs`). POSIX offers `/proc/<pid>/cwd` on Linux and `lsof -d cwd` on macOS. Neither is verified here, because this host is Windows. The Windows route reads the PEB of each process through native calls, which this repository has no code for.
- **Record of earlier session ids.** After a hard kill the transcript is not written, because the loop writes it at exit. The session record of ADR 0027 exists only for an in-tree transcript and binds to that transcript, which a fresh run does not name. A record per work tree needs a new store outside the tree, a write before every Claude turn, and a removal rule. A hard kill skips the removal, so stale entries accumulate and a pid or id match cannot tell them from live ones without the process-table read of ADR 0029.

## Decision

1. The runtime adds no detection of a live orphan for a fresh run. The gap that ADR 0029 lists stays open.
2. The runtime adds no match on a holder that omits the id from its command line, for the same reason: no portable field links such a process to a session or a work tree.
3. A run that sees an orphan, or suspects one, relies on the operator. The operator lists `claude` processes with `-p` and `--session-id` or `--resume` in their command line, ends or waits for the stale ones, and runs again.
4. Reopen this decision when one of these holds:
   - Claude Code prints the working directory or the work tree in the command line of a headless child.
   - Windows and POSIX both expose a process working directory through one call that the repository can run without native code.
   - A per-work-tree run lock gains a live-child field that a hard kill cannot leave stale (ADR 0020 liveness check).

## Consequences

- The reproduction of issue #647 with a fresh run, not `--continue-from`, still lets the orphan write to the tree after the reviewer reports a clean tree.
- No new state store, no new process-table read, and no new platform branch.
- Not verified: `/proc/<pid>/cwd` on Linux and `lsof -d cwd` on macOS. The ADR does not depend on them, because a Windows-only gap would still leave the asymmetry that the repository avoids.
- The probe covered one Windows host. It does not prove that no Windows build exposes a working directory, only that `Win32_Process` on this build does not.

## Alternatives

1. **Match the working directory of each process**: rejected for now. No Windows field exists, and the POSIX tools are not verified and differ between macOS and Linux.
2. **A registry of session ids per work tree**: rejected for now. It adds a store, a pre-turn write, and a stale-entry rule, and it still needs the process-table read to tell live from stale.
3. **Refuse a fresh run when any headless `claude` process runs on the host**: rejected. A run in another work tree, or an unrelated headless use, would block the run, and the refusal could not name the work tree.
4. **End the orphan found by a broad match**: rejected by ADR 0017 item 4 and ADR 0029 decision 7.

## Authors

Andro Marces

## Links

- [Issue #673](https://github.com/andromarces/agent-loops/issues/673)
- [Issue #647](https://github.com/andromarces/agent-loops/issues/647)
- [ADR 0029: Refuse --continue-from while a live process holds a Claude session](0029-refuse-continue-from-while-a-live-process-holds-a-claude-session.md)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR Index](README.md)
