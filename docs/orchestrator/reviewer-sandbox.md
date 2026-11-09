# Codex reviewer sandbox mode

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when the run uses a Codex reviewer, sets `--reviewer-sandbox`, or halts on a reviewer mutation.

## The Codex reviewer sandbox mode

A Codex reviewer turn runs with no sandbox by default. An operator can choose a
sandbox at init with `--reviewer-sandbox read-only` or `--reviewer-sandbox
workspace-write`. `--reviewer-workspace-write` is an alias of
`--reviewer-sandbox workspace-write`. The flag needs `--reviewer codex`, and any
other reviewer is refused at init.

The modes, their Codex settings, the app-connector setting, and the ADRs are in
[Codex reviewer sandbox mode](../reference/reviewer-safety.md#codex-reviewer-sandbox-mode).

- Only reviewer turns change. Every orchestrator turn keeps `read-only`, and every
  worker turn gets no reviewer input. The runtime mutation check still wraps every
  reviewer turn in every mode.
- In the two sandboxed modes, shell network stays off, and a user Codex execpolicy
  rule is an exception. The limit covers shell commands only. Choose a sandboxed
  mode when the turn must not reach the network. The facts and the exception are
  in [Codex read-only network limit](../reference/reviewer-safety.md#codex-read-only-network-limit).
- The reviewer must not change a tracked file or an untracked file that Git does not
  ignore, including a cache file, must not change Git state, and must not write to
  a remote. The file-change rule has the same scope in every mode: a test, build,
  or probe is allowed when every write goes to an ignored path or to a temporary
  file outside the repository. The reviewer puts probe and test output
  under an ignored path inside the repository first, such as an ignored cache
  directory.
  - It uses a temporary path outside the repository only when no
    ignored path fits. The reviewer keeps that output path short and
    does not set `TMP`, `TEMP`, or `TMPDIR` to a deep path for a test runner.
  - The reviewer removes each temporary
    file or directory that it created outside the repository before the closing
    block, and names any that it could not remove in `Notes`. It also removes each file or directory that it created under an ignored path inside the repository, and names any that it could not remove in `Notes`. When the turn has a runtime scratch folder, the reviewer leaves that folder out of this removal. It keeps output that a later step needs, such as a coverage report that the task asks for, and names it in `Notes`.
  - A change to a cache file that Git does not ignore is a reviewer mutation. A
    reviewer that is not Codex has no mode.
- The runtime creates one scratch folder for each reviewer turn at `.agent-loop/rev/<id>` under the work tree root. The folder holds its own `.gitignore` with `*`, also in a linked work tree. The runtime removes the folder after the post-turn snapshot, on every turn outcome, and never follows a link or a junction inside it. It refuses and logs a warning when `.agent-loop` or `.agent-loop/rev` is a link. A failed removal logs a warning and never fails the run.
- A reviewer turn runs no dependency install, repair, or update, and starts no command that installs, such as a test runner that installs when it finds no usable `node_modules` (`vp` does). The mutation check does not see a write to the shared package store outside the repository. A probe of old source avoids the install: the reviewer copies the repository, links the dependency directory of the work tree (`node_modules` in a Node project) into the copy (a junction on Windows, a symlink elsewhere), and runs the tool there. When the copy cannot link `node_modules`, the reviewer reports the probe as unresolved in `Checks`.
  - The rule is advisory, and the runtime does not detect a breach.
- A cache that a tool writes to its own default location, such as a test runner cache under an ignored path or a compile cache in a temporary directory, is not reviewer output. Output under a path that the reviewer chose for the turn, such as a directory that it set `TMPDIR`, `TEMP`, or `TMP` to, or the runtime scratch folder, stays turn output even when a tool writes it there.
  - For a reviewer `Notes` line: A refused cleanup of a tool cache in its default location is not a finding. A cache entry that existed before the turn is not a finding either. Do not carry either into `open`. Output under a path that the reviewer chose, such as its temporary directory or the scratch folder, stays turn output. A refused cleanup of that output or of a probe file that the turn created still goes into `open`. The rule is advisory, and the runtime does not detect a breach.
- The runtime pins `AGENT_LOOP_RUNS_ROOT`, `AGENT_LOOP_TEST_SLOTS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` to the paths that it resolves for every worker and reviewer turn, on every adapter, unless the user set them. The machine-wide slot limit holds even with a `TMP`, `TEMP`, or `TMPDIR` override inside the turn. The runtime also sets `npm_config_logs_max=0` for those turns, unless the user set
  `npm_config_logs_dir` or `npm_config_logs_max`.
- Each turn of every adapter runs with a private temporary directory under the inherited one, set through `TMPDIR`, `TEMP`, and `TMP`. A `CLAUDE_CODE_TMPDIR` value that the user set stays. The runtime removes the
  private temporary directory after the turn.
  - Build a temporary path from the directory that TMPDIR, TEMP, or TMP names when one is set. Never write a literal path to the system temporary directory, such as `/tmp`. The removal covers only the private directory.
    - The runtime lists an entry that appears directly in the inherited directory during a reviewer turn in one post-turn read. It names the entry `inheritedTmpdirEntries`, deletes none, and treats the list as a diagnostic with no automatic `open` item.
    - `AGENT_LOOP_SESSION_RECORDS_ROOT` overrides the default `<os tmpdir>/agent-loops/session-records`.
- The runtime lists the inherited temporary directories in `AGENT_LOOP_INHERITED_TMPDIR`, as a JSON array of absolute paths, for the installer check of a package-runner root. The parent resolves every entry before it forwards the list, and forwards `unusable` for a value that it cannot resolve. A value that is present but is not a valid list makes the installer refuse every root. A helper process removes the turn directory only when its device and inode match the recorded ones, and ends at a 30-second bound. A replacement between the final check and `rmdir` loses at most an empty directory.
- Choose the mode at init, and never change it later. The state file holds
  `reviewerSandbox` (`none`, `read-only`, or `workspace-write`) for a Codex reviewer
  only. A later call may repeat the
  flag or omit it, which reads the stored value. Any other value is refused with
  `cannot be changed after init`, in either direction. No turn sets the mode.
- A state file or a transcript with no recorded mode gets `workspace-write` when
  it held `--reviewer-workspace-write`, and `read-only` otherwise. It never gets
  the no-sandbox mode.
- The mutation check is detection only. With no sandbox, or in `workspace-write`,
  a reviewer edit succeeds, the run halts with a `MutationError`, exit 1, and the
  runtime does not revert it. An operator who needs containment chooses a
  sandboxed mode, or runs the reviewer in an external sandbox with no credential
  for the remote. Read the accepted gaps in
  [Codex reviewer sandbox mode](../reference/reviewer-safety.md#codex-reviewer-sandbox-mode)
  and
  [Safety trade-off of the no-sandbox mode](../reference/reviewer-safety.md#safety-trade-off-of-the-no-sandbox-mode)
  before you rely on a mode.
- A reviewer `Checks` line that shows a local test run is the reviewer's own
  report. Compare it with `testRun` and with the required CI checks.

## A task that bars live calls

A task that bars live calls keeps the reviewer turn off the network with
`--reviewer-sandbox workspace-write` or `--reviewer-sandbox read-only`, whose
shell network is off. It keeps the copied `.env` out of the work tree with
`--no-copy-local-files`, unless the tests need the copied files. The flag rules
are in [Local files copied into the work tree](local-files-copy.md). Two
documented limits stay in force: the user execpolicy exception of ADR 0019, and
model-side tools that the sandbox does not block.
