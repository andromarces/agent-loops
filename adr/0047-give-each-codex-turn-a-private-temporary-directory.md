# 0047. Give each Codex turn a private temporary directory

## Status

accepted

## Date

2026-10-19

## Context

The Codex CLI leaves two empty `.tmpXXXXXX` directories in its temporary directory on every `exec` turn (issue #955). A probe with `codex exec` showed them in the `danger-full-access` and `read-only` modes. They pile up in the OS temporary directory.

Several parts of the runtime key machine-wide state on `os.tmpdir()`: the runs root, the test-slot directory, the session records, and the installer check of a package-runner root. A new temporary directory for the child must not split that state.

## Decision

1. **Private directory.** Every Codex turn (worker, reviewer, orchestrator) runs with `TMPDIR`, `TEMP`, and `TMP` set to `al-XXXXXX`, which `mkdtemp` creates under the inherited temporary directory. The name stays short (issue #903). A failed creation warns, and the turn uses the inherited directory.
2. **Host state stays shared.** The runtime pins `AGENT_LOOP_RUNS_ROOT`, `AGENT_LOOP_TEST_SLOTS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` for the child to the paths that the parent resolves. A value that the user set wins. Session records had no override, so this ADR adds `AGENT_LOOP_SESSION_RECORDS_ROOT`.
3. **Installer check.** The runtime lists the inherited temporary directories in `AGENT_LOOP_INHERITED_TMPDIR`. The installer check of a yarn dlx or bunx root compares against `os.tmpdir()` and that list, so the refusal holds inside a turn.
4. **Identity.** The runtime records the device and inode of the directory when it creates it.
5. **Removal.** After the turn, on every outcome, a helper process (`src/lib/turn-tmpdir-remove.mjs`) removes the directory. It holds the parent, and then the directory, as its working directory. It acts on a path only when the device and inode match the recorded ones, at the start, at the chdir, and before the final `rmdir`. Any other directory is refused and nothing is deleted.
6. **Bound.** `execBounded` ends the helper at 30 s, by SIGTERM and then SIGKILL, or `taskkill` on Windows. `killTreeOnExit` registers it for the end of the process. A refused, failed, timed-out, or killed helper warns and never fails the turn.

## Consequences

- A Codex turn leaves no entry in the inherited temporary directory, and a concurrent process never loses one.
- A command that the child runs sees the private directory as its temporary directory, and the runtime removes what it wrote there.
- A directory nested below the target can still be swapped during the delete, because Node has no directory-handle delete.
- A replacement that appears between the final identity check and the `rmdir` loses at most an empty directory, because `rmdir` fails on a directory that holds an entry and Node cannot name the directory by handle.
- A replacement that appears between `mkdtemp` and the identity read is recorded as the directory. The name is random, and Node cannot create a directory and read its identity in one call.
- The identity check relies on the device and inode that the platform reports. It is not verified on Windows (issue #709). A mismatch refuses and leaves the directory in place.
- A removal that the helper refuses or cannot finish leaves the directory and logs a `warn` line.

## Alternatives

1. **Remove the empty `.tmp*` directories that appeared during the turn.** Not taken. A concurrent process can own an empty directory of that name in the same window, and no guard is exact.
2. **The scratch folder `.agent-loop/rev/<id>` of ADR 0042.** Not taken. A temporary directory inside the work tree sits inside the parent Git repository, and only a reviewer turn has that folder.
3. **Report the leftover to the Codex project.** Not taken as the fix. It leaves the directories until a release.

## Authors

Andro Marces

## Links

- [Issue #955](https://github.com/andromarces/agent-loops/issues/955)
- [PR #958](https://github.com/andromarces/agent-loops/pull/958)
- Related issues: #709, #903
- [ADR 0042: Remove the reviewer scratch folder in the runtime](0042-remove-the-reviewer-scratch-folder-in-the-runtime.md)
- Implementation:
  - Source: `src/lib/turn-tmpdir.mjs`, `src/lib/turn-tmpdir-remove.mjs`, `src/lib/inherited-tmpdir.mjs`, `runCodex` in `src/agents/codex.mjs`, `temporaryRoots` in `src/install/package-root.mjs`
  - Tests: `tests/agents/codex.test.mjs`, `tests/lib/turn-tmpdir.test.mjs`, `tests/lib/turn-tmpdir.race.test.mjs`, `tests/lib/turn-tmpdir.helper-bound.test.mjs`
  - Docs: `docs/reference/architecture.md`, `docs/orchestrator-instructions.md`, `docs/reference/install.md`
- [ADR Index](README.md)
