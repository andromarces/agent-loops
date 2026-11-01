# 0063. Close the limits of the abandoned turn directory removal that the process group and the record origin cover

## Status

accepted

Partially supersedes [ADR 0058: Remove the turn directory of a dispatch that died mid-turn](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md). This ADR replaces the keep conditions of decision 3, the refusal set of decision 4, and the consequence "On POSIX only the recorded child is checked". Decisions 1, 2, and 5 of ADR 0058 hold, with the addition of decision 3 below.

## Date

2026-10-29

## Context

ADR 0058 removes the turn directory of a dispatch that died mid-turn, and records four limits (issue #1216). `exec` starts every CLI with execa `killDescendants: true`. On POSIX, execa then spawns the child with `detached: true`, so the child leads its own process group and the group id is the child pid. The group id stays reserved while any member runs, so the group still names a descendant that was reparented after the child died. The ADR 0058 reason against a group check, that it needs a signal-handling change, does not hold: the group already exists and no spawn option changes.

## Decision

1. **POSIX process group.** Before the removal, a POSIX call sends signal 0 to the group of the recorded child. A group with a live member, or an error other than `ESRCH`, keeps the directory with a warning. This is an added keep condition of decision 3 of ADR 0058. The Windows process-table check is unchanged.
2. **Record origin.** The call refuses a record whose `parentReal` is not the real path of the temporary directory that the call inherited, because a turn directory is created there only. An `al-` directory elsewhere with its real device and inode is not removed. A call that runs with another temporary directory than the dispatch that died keeps the directory with a warning. This is an added refusal of decision 4 of ADR 0058.
3. **Stale record.** The dispatch clears `lastDispatch.turnTmpdir` in memory when its record write fails, so the later write of the error result saves no record of a directory that is already removed.
4. **Unrecorded child stays.** A dispatch that died between the spawn and the write of the child pid keeps its directory, and no later sweep removes it. The record holds no pid in that window, so no group id is known, and a removal by age or by name alone can delete a directory that a live child uses (ADR 0058 alternative 1).
5. **Command shell of a CLI.** A Codex shell command runs in its own process group (codex-cli 0.166.0 on macOS). The group of the dead child does not name its descendant. The removal adds no other marker: the turn ended, so its directory carries no result of the turn. Every other marker depends on the platform, and a session id can be shared with unrelated processes of the same terminal or harness. The extension option of issue #1318 is closed.

## Consequences

- A descendant that outlives a dead child in its group keeps the directory until the group ends.
  - A later call on the interrupted run re-checks the kept directory and removes it once the group ends (issue #1329).
- A group id that the OS reused for a new group after the old one ended keeps the directory, with a warning. The cost is a leaked directory, never a wrong removal.
- A descendant that leaves the group of the child, with `setsid` for example, is not found.
  - Observed on 2026-11-01 with codex-cli 0.166.0 on macOS (issue #1318). The CLI pid 38377 led group 38377, and the `sh -c` wrapper pid 39025 led group 39025 with parent 38377. The `sleep 987` descendant pid 39026 ran in group 39025. After `SIGKILL` to the dispatch and the CLI tree, pid 39026 was alive and group 38377 was empty. The saved listing was `["al-MCmHAp"]` while the turn ran and `[]` after the next dispatch. That dispatch removed the directory and logged no turn-directory warning.
- The group check runs on POSIX only. Its live check is open on issue #707 (Linux) and issue #708 (macOS).
  - macOS live check (2026-11-01, issue #708). Host: macOS 27.2 (arm64), Node v27.0.0-alpha.0.0.0, Claude Code 2.1.316, codex-cli 0.166.0, and Git 2.56.0. Repository head `4145e480`.
    - Codex turn (the item's configuration): a `role dispatch` worker turn under one fixed `TMPDIR` ran `sh -c 'sleep 60'`. The rows at the signal read `95648 95647 95643 ... role dispatch`, `95713 95648 95713 .../codex exec`, and `96875 95713 96875 sleep 60`.
    - After the kill, the t+1.5 s line of the probe timeline records the descendant alive and the CLI group empty. The row read `96875 1 96875 sleep 60`. A signal 0 to group 95713 returned ESRCH. The listings were `[]` before the turn, `["al-p4nq2h"]` during it, and `[]` after the next call.
    - The next call removed `al-p4nq2h` while pid 96875 ran, and warned only about the stale lock. The Codex child starts its shell command in its own group, so the group check does not name the descendant. The item that requires a descendant in the CLI group stays unticked.
    - Group keep check (a Claude turn): the CLI started a configured MCP server in its own group. The rows read `97170 97104 97104 sleep 987`. After the kill, the t+1.5 s line of the probe timeline records the descendant alive and the CLI group alive. The row read `97170 1 97104 sleep 987`. A signal 0 to group 97104 succeeded.
    - The next call kept `al-RpK3qR` and warned that a process in group 97104 can still run. The probe ended pid 97170 by exact pid, and a signal 0 to group 97104 then returned ESRCH. A later call ended with exit code 1 and listed `al-RpK3qR` again, so the kept directory stayed. Issue #1329 records that result.
    - `tests/lib/turn-tmpdir.test.mjs` passed on this host (9 tests). The run used the test-slot wrapper with `--if-held`.
- The dispatch that died in the unrecorded window leaves its directory for a person to delete by hand.

## Alternatives

1. **Sweep a kept directory when no process of the turn can be found**: not taken. Without a recorded pid there is no process to find (decision 4).
2. **Compare the record against the tracked set of turn directory names of the process**: not taken. A recovery call runs in a new process with an empty set.

## Authors

Andro Marces

## Links

- [Issue #1216](https://github.com/andromarces/agent-loops/issues/1216)
- [PR #1230](https://github.com/andromarces/agent-loops/pull/1230)
- [Issue #1318](https://github.com/andromarces/agent-loops/issues/1318)
- [PR #1320](https://github.com/andromarces/agent-loops/pull/1320)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [Issue #1329: Remove a kept turn directory after the group of the dead child ends](https://github.com/andromarces/agent-loops/issues/1329)
- [PR #1330](https://github.com/andromarces/agent-loops/pull/1330)
- Supersedes (partially): [ADR 0058](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md)
- Related: [ADR 0047](0047-give-each-codex-turn-a-private-temporary-directory.md), [ADR 0020](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- Implementation:
  - Source: `removeAbandonedTurnTmpdir` in `src/lib/turn-tmpdir.mjs`, `onTurnTmpdir` in `src/role-dispatch.mjs`, `killDescendants` in `exec` of `src/lib/exec.mjs`
  - Tests: `tests/lib/turn-tmpdir.test.mjs`, `tests/role.dead-turn-tmpdir.test.mjs`
  - Docs: `docs/reference/architecture.md`
- [ADR Index](README.md)
