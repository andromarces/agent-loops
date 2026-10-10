# 0031. Detect a live session holder on interactive init, keep the headless gap

## Status

accepted

## Date

2026-10-10

## Context

ADR 0029 refuses `--continue-from` when a live process names the session id of a Claude role. It lists two cases it does not find: a fresh run in the same work tree, which holds no earlier id, and a holder that does not carry the id in its command line. Issue #673 asks how a fresh run can find a live child of an earlier run in the same work tree. The orphan is the `claude` child of a hard-killed runtime (ADR 0027, issue #627).

Records that exist in the code now, read from the source:

- **Interactive `agent-loop role dispatch`.** The per-work-tree state directory is `<runs root>/<cwdHash(cwd)>` (`statePaths`, `src/lib/runstate.mjs`). Its `state.json` holds `roles.<role>.kind` and `roles.<role>.sessionId`. `onSessionAssigned` in `dispatchLocked` (`src/role.mjs`) writes the pre-assigned id to `state.json` before the CLI starts, so a hard kill leaves it. `init` over a terminal state (`halted`, `finished`, `aborted`) renames it to `state.<timestamp>.json` in the same directory (`archiveState`) and keeps it. `init` over a non-terminal state is refused. A killed turn leaves `dispatched`, so the operator runs `abort` first, which makes the state terminal.
- **Headless `agent-loop`.** `src/cli.mjs` reads and writes no run state. A Claude first turn writes its pre-assigned id only into the `--transcript` file, or into a session record outside the work tree when that transcript is inside it (ADR 0027). Both bind to the `--transcript` path. A run with no `--transcript` saves no id before the turn. A fresh run does not name the `--transcript` of an earlier run.

A working directory match was also examined. Probed on Windows 11 Pro 10.0.26220, PowerShell 7.6.6, Claude Code 2.1.296, Node v26.8.1: `Win32_Process` has no working-directory property, and no `claude` command line holds the work tree path, because the runtime passes the work tree through the `cwd` option of `exec`, not through an argument (`src/agents/claude.mjs`).

## Decision

1. A fresh `role dispatch` init, before it archives or writes any state, reads the Claude role sessions of the current and the archived state files in the work tree state directory (`readClaudeSessions`). It then runs the process-table check of ADR 0029 on those ids (`refuseHeldIds` in `src/lib/continuation.mjs`, the shared core of `refuseHeldSessions`). A live process other than the runtime that holds one of the ids refuses the init with exit 1, and the error names the role, the id, and the pid. Nothing is archived or written, and no child starts. An unreadable process table warns and lets the init continue, and a cancel ends the init with exit 130, both as in ADR 0029 decisions 4 and 6.
2. A process holds an id when an argument of its command line is exactly the id, or is `--resume=<id>`, `--session-id=<id>`, or `-r=<id>`, after the command line is split with the rules of the platform, as ADR 0029 decision 8 states. A substring match was rejected: it refused a run for a log path that held the id and for a longer token that contained it. A match on the value of a session flag alone was rejected too: it missed a quoted flag such as `"--resume" <id>` that Windows argument parsing accepts, and it narrowed the earlier `--continue-from` contract for a bare id argument. One shared function applies the rule to both checks. The check uses the kind recorded in the earlier state, not the kind of the new run. Only a Claude role whose id is a canonical UUID is checked. A work tree with no such id reads no process table.
3. The check is by the recorded id. It adds no working-directory match and no match on a holder that omits the id from its arguments.
4. The headless fresh run adds no detection. No record keyed by the work tree exists on that path. A record for it needs a new store, a write before each Claude turn, and a stale-entry rule, which this decision does not add. Reopen it when headless runs gain per-work-tree state, when Claude Code puts the working directory in the command line of a headless child, or when Windows and POSIX both expose a process working directory through one call that needs no native code.
5. The runtime does not wait for the holder and does not end it (ADR 0029 decision 7).

## Consequences

- An init after an `abort` of a hard-killed `role dispatch` run ends with exit 1 and a named holder while the orphan lives, whether its state is the current file or an archive.
- A process that carries the id as an argument for another reason also refuses the init, as in ADR 0029. The error names the pid. A process that only mentions the id inside a larger argument, for example in a log path, does not. A holder that passes the id in another form, for example through a wrapper that reads it from a file, is not found. A POSIX process table prints the arguments joined by spaces, so an argument that holds a space cannot be told from two arguments. The split can then count an id that sat inside one such argument, on the safe side.
- The cost is one process-table read per init in a work tree with an earlier Claude session, and a read of every state file of the work tree. Archives are not pruned, so the read grows with the number of earlier runs.
- The headless fresh run and a holder without the id in its command line stay unfound. An orphan of a headless run can still write to the tree.
- `--resume-interrupted` is unchanged. It resumes the kept session id of the current state without this check. ADR 0029 keeps that follow-up.
- The check and the init are not atomic. A holder that starts between them is not found.
- Verified on Windows 11 Pro 10.0.26220, Node v26.8.1: `readProcessCommands` found a live child that carried a generated UUID in its command line, by that pid, and found nothing after the child ended. The child was a `node` process, not a `claude` process. Tests cover the refusal, the archived-state case, and the no-holder case with an injected process table.
- Not verified: a real `claude` orphan of a hard-killed `role dispatch` on any platform, the Windows bound of the read, `/proc/<pid>/cwd` on Linux, and `lsof -d cwd` on macOS. The decision does not depend on the last two.

## Alternatives

1. **Match the working directory of each process**: rejected. No Windows field exists, and the POSIX tools are not verified and differ between macOS and Linux.
2. **A new registry of session ids per work tree for both paths**: rejected for now. The interactive path already holds the ids in its run state, so a registry there duplicates it. The headless path would need the store, the write, and the stale rule described in decision 4.
3. **Read only the current state file**: rejected. `init` archives a terminal state first, so a second init after the kill would not see the earlier id.
4. **Refuse a fresh run when any headless `claude` process runs on the host**: rejected. A run in another work tree would block it, and the refusal could not name the work tree.
5. **End the orphan found by the match**: rejected by ADR 0017 item 4 and ADR 0029 decision 7.

## Authors

Andro Marces

## Links

- [Issue #673](https://github.com/andromarces/agent-loops/issues/673)
- [Issue #647](https://github.com/andromarces/agent-loops/issues/647)
- [ADR 0029: Refuse --continue-from while a live process holds a Claude session](0029-refuse-continue-from-while-a-live-process-holds-a-claude-session.md)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- Implementation: `readClaudeSessions` in `src/lib/runstate.mjs`, `refuseHeldIds` in `src/lib/continuation.mjs`, and the call in `dispatchLocked` in `src/role.mjs`. Tests in `tests/role.init.test.mjs`.
- [ADR Index](README.md)
