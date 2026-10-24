# 0047. Give each Codex turn a private temporary directory

## Status

partially-superseded

Superseded by [ADR 0049: Pin the machine-wide roots for every child turn](0049-pin-the-machine-wide-roots-for-every-child-turn.md). ADR 0049 pins the three roots for every worker and reviewer spawn, so decision 2 no longer applies to a Codex child only. Every other decision of this ADR remains in force.

## Date

2026-10-19

## Context

The Codex CLI leaves two empty `.tmpXXXXXX` directories in its temporary directory on every `exec` turn (issue #955). A probe with `codex exec` showed them in the `danger-full-access` and `read-only` modes. They pile up in the OS temporary directory.

Several parts of the runtime key machine-wide state on `os.tmpdir()`. These are the runs root, the test-slot directory, the session records, and the installer check of a package-runner root. A new temporary directory for the child must not split that state.

## Decision

1. **Private directory.** Every Codex turn (worker, reviewer, orchestrator) runs with `TMPDIR`, `TEMP`, and `TMP` set to `al-XXXXXX`. `mkdtemp` creates it under the inherited temporary directory. The name stays short (issue #903). A failed creation warns, and the turn uses the inherited directory.
2. **Host state stays shared.** The runtime pins `AGENT_LOOP_RUNS_ROOT`, `AGENT_LOOP_TEST_SLOTS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` for the child. Each gets the path that the parent resolves. A value that the user set wins. Session records had no override, so this ADR adds `AGENT_LOOP_SESSION_RECORDS_ROOT`.
3. **Installer check.** The runtime lists the inherited temporary directories in `AGENT_LOOP_INHERITED_TMPDIR`, as a JSON array of absolute paths. JSON cannot split a path that holds the platform list delimiter. The parent resolves every entry against its own working directory, and forwards `unusable` for a held value that it cannot resolve. The installer check of a yarn dlx or bunx root compares against `os.tmpdir()` and that list. A value that is present but is not a valid list makes the installer refuse every root. The refusal holds in a turn and in a nested turn.
4. **Identity.** The runtime records the device and inode of the directory when it creates it.
5. **Removal.** After the turn, on every outcome, a helper process (`src/lib/turn-tmpdir-remove.mjs`) removes the directory. It holds the parent, and then the directory, as its working directory. It acts on a path only when the device and inode match the recorded ones. It checks at the start, at the chdir, and before the final `rmdir`. It refuses any other directory and deletes nothing.
6. **Bound.** `execBounded` ends the helper at 30 s, by SIGTERM and then SIGKILL, or `taskkill` on Windows. `killTreeOnExit` registers it for the end of the process. A refused, failed, timed-out, or killed helper warns. It never fails the turn.
7. **Approved limit (repository owner, 2026-10-19, issue #955): two ownership windows.** It narrows decision 5, which acts only on the directory that the runtime created. A same-user swap can still land in two windows. The first lies between `mkdtemp` and the identity read. The second lies between the final identity check and the `rmdir`. The second window loses at most an empty replacement directory. The runtime adds no more machinery for them, because Node cannot close them portably.

## Consequences

- A Codex turn leaves no entry in the inherited temporary directory. A concurrent process never loses one.
- A command that the child runs sees the private directory as its temporary directory. The runtime removes what it wrote there.
- A directory nested below the target can still be swapped during the delete, because Node has no directory-handle delete.
- A replacement between the final identity check and the `rmdir` loses at most an empty directory. `rmdir` fails on a directory that holds an entry, and Node cannot name the directory by handle.
- A replacement between `mkdtemp` and the identity read is recorded as the directory. The name is random, and Node cannot create a directory and read its identity in one call.
- The identity check relies on the device and inode that the platform reports. It is not verified on Windows (issue #709). A mismatch refuses and leaves the directory in place.
- A removal that the helper refuses or cannot finish leaves the directory and logs a `warn` line.

Live verification (issue #710). Two Codex reviewer turns ran through `role dispatch --role reviewer --reviewer codex` on `main` at `eb84f61` (after `f70247d`), with codex-cli 0.164.0-alpha.12, Node v26.8.1, and Windows 11 10.0.26220. The default reviewer mode ran with no sandbox. The parent set `TMP`, `TEMP`, and `TMPDIR` to a fresh empty directory outside the repository and set no `AGENT_LOOP_*` root. Before the first turn the directory was empty. After it, the directory held only `agent-loops`, the host state of the run. It held no `.tmp*` or `al-*` entry, and the same listing held after the second turn. Inside each turn `agent-loop test-slot` ran a command that printed its environment. `TMP`, `TEMP`, `TMPDIR`, and `os.tmpdir()` were `<inherited>\al-Vqip7x`. `AGENT_LOOP_TEST_SLOTS_ROOT`, `AGENT_LOOP_RUNS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` were the `<inherited>\agent-loops\...` paths that the parent resolves. The slot file `slot-0.lock` was in `<inherited>\agent-loops\test-slots`, and `<inherited>\al-Vqip7x\agent-loops\test-slots` did not exist.

Live verification of package managers (issue #710). One Codex worker turn ran through `role dispatch --role worker --worker codex` on `main` at `46f8689`, with codex-cli 0.165.0-alpha.1, Node v26.8.1, and Windows 11 10.0.26220. The disposable repository was a new directory under the system temporary directory with three subdirectories, each holding a `package.json` with the dependency `ms` 2.1.3. Inside the turn the child wrote its `TMPDIR`, `TEMP`, and `TMP` to a file: all three were `<inherited>\al-WRYh69`. It then ran `npm --version` (12.2.1) and `npm install` in `pkg-npm`, and `bun --version` (1.3.8) and `bun install` in `pkg-bun`, each with exit code 0. `yarn` is not on PATH on this machine. The child recorded `yarn not found`, ran no `yarn install`, and installed no yarn, so yarn is **not run** and the item stays open for it. After the turn, `<inherited>\al-WRYh69` no longer existed, and the inherited directory held no `al-*` or `.tmp*` entry apart from the `al-wt` directory of the harness. In `node_modules`, `pkg-npm` held no link of any kind. In `pkg-bun`, the four files of `ms` were hard links to the Bun cache (`%LOCALAPPDATA%\.bun\install\cache\ms@2.1.3@@@1`), and no symlink or junction existed. No file under `node_modules` named `al-WRYh69`. `require('ms')` worked from both directories after the turn. Result: `npm install` and `bun install` leave no link into the removed directory. Not covered: yarn, other OSes, and a Codex turn that sets the Bun cache or `BUN_TMPDIR` inside the private directory.

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
