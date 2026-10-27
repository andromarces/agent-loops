# Codex reviewer sandbox mode

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when the run uses a Codex reviewer, sets `--reviewer-sandbox`, or halts on a reviewer mutation.

## The Codex reviewer sandbox mode

A Codex reviewer turn runs with no sandbox by default, with
`sandbox_mode="danger-full-access"` ([ADR 0038](../../adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md),
which partially supersedes [ADR 0019](../../adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md)), and with the app connectors off
(`features.apps=false`, issue #496). It can run the test suite and
`gh pr checks`. An operator can choose a sandbox at init with
`--reviewer-sandbox read-only` or `--reviewer-sandbox workspace-write`. The
older `--reviewer-workspace-write` stays as an alias of `--reviewer-sandbox
workspace-write`. The flag needs `--reviewer codex`, and any other reviewer is
refused at init.

The mode table is in
[Codex reviewer sandbox mode](../reference/reviewer-safety.md#codex-reviewer-sandbox-mode).

- Only reviewer turns change. Every orchestrator turn keeps `read-only`, every
  worker turn gets no reviewer input, and the other four adapters keep their
  invocations. The runtime mutation check still wraps every reviewer turn in
  every mode.
- In the two sandboxed modes, network access stays off for the shell commands that
  the sandbox runs. The runtime sets it explicitly for `workspace-write`, because
  the mode takes network from the user Codex config otherwise. A user Codex
  execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception, as
  ADR 0019 states. The limit covers shell commands only. It does not block
  model-side tools such as Codex `web_search`, or any other channel outside the
  sandbox. With no sandbox, no such rule applies, because no sandbox exists to skip.
- The reviewer prompt gains one note that states the actual mode. The reviewer
  still must not change a tracked file or an untracked file that Git does not
  ignore, including a cache file, must not change Git state, and must not write to
  a remote. The file-change rule has the same scope in every mode: a test, build,
  or probe is allowed when every write goes to an ignored path or to a temporary
  file outside the repository, so the reviewer runs the test suite instead of
  waiting for permission (issue #837). The reviewer puts probe and test output
  under an ignored path inside the repository first, such as an ignored cache
  directory. It uses a temporary path outside the repository only when no
  ignored path fits (issue #885). The reviewer keeps that output path short and
  does not set `TMP`, `TEMP`, or `TMPDIR` to a deep path for a test runner,
  because a long temporary path can fail a Windows test runtime with an internal
  error (issue #903). The worker prompt has no scratch-redirect rule, so it needs
  no such guidance. The prompt names no repository path, because the
  `workspace-write` prompt must stay free of a repository-specific path. The reviewer removes each temporary
  file or directory that it created outside the repository before the closing
  block, and names any that it could not remove in `Notes` (issue #865). It also removes each file or directory that it created under an ignored path inside the repository, and names any that it could not remove in `Notes`. When the turn has a runtime scratch folder, the reviewer leaves that folder out of this removal, because the runtime removes it (issue #997). It keeps output that a later step needs, such as a coverage report that the task asks for, and names it in `Notes` (issue #906). A change to a cache file that Git does not
  ignore is a reviewer mutation. The mutation check is unchanged. The headless initial
  prompt tells the orchestrator the mode, and says that its own turns stay
  read-only. A reviewer that is not Codex has no mode, and its prompts name none.
- The runtime creates one scratch folder for each reviewer turn at `.agent-loop/rev/<id>` under the work tree root. The prompt names that folder as the first place for probe and test output. The folder holds its own `.gitignore` with `*`, so it needs no rule in the target repository, also in a linked work tree. The runtime removes the folder after the post-turn snapshot, on every turn outcome, and never follows a link or a junction inside it. It refuses and logs a warning when `.agent-loop` or `.agent-loop/rev` is a link. A failed removal logs a warning and never fails the run (issue #920, ADR 0042).
- A reviewer turn runs no dependency install, repair, or update, and starts no command that installs, such as a test runner that installs when it finds no usable `node_modules` (`vp` does). An install writes to the shared package store outside the repository and reaches every work tree that links it, and the mutation check does not see that write (issue #1026). A probe of old source avoids the install: the reviewer copies the repository, links the dependency directory of the work tree (`node_modules` in a Node project) into the copy (a junction on Windows, a symlink elsewhere), and runs the tool there. When the copy cannot link `node_modules`, the reviewer reports the probe as unresolved in `Checks`. The reviewer prompt names no tool or directory, because it fits any repository. The worker preamble states the same rule for a worker probe that copies the repository. The rule is advisory, and the runtime does not detect a breach.
- A cache that a tool writes to its own default location, such as a test runner cache under an ignored path or a compile cache in a temporary directory, is not reviewer output. The reviewer prompt tells the reviewer to leave it in place, to report it in no `Notes` line, and never to delete an entry that it cannot show its turn created. The prompt names no tool, because it fits any repository (issue #1171). The prompt chose this over a rule to turn the cache off with a tool flag, because a flag differs by tool and some tools have none. When a reviewer `Notes` line still reports a refused cleanup of such a cache, or a cache entry that existed before the turn, do not carry that line into `open`. The cache is not a finding. A refused cleanup of an entry that the turn created outside a tool cache, for example a probe file that the reviewer wrote, still goes into `open` under the `Notes` rule. The rule is advisory, and the runtime does not detect a breach.
- The runtime pins `AGENT_LOOP_RUNS_ROOT`, `AGENT_LOOP_TEST_SLOTS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` to the paths that it resolves for every worker and reviewer turn, on every adapter, unless the user set them (issue #970, ADR 0049). A `TMP`, `TEMP`, or `TMPDIR` override inside the turn cannot move the test-slot directory, so the machine-wide slot limit holds. The runtime also sets `npm_config_logs_max=0` for those turns, so npm writes no debug log to its cache, unless the user set `npm_config_logs_dir` or `npm_config_logs_max` (issue #995, ADR 0049).
- Each Codex turn runs with a private temporary directory under the inherited one, set through `TMPDIR`, `TEMP`, and `TMP`. The Codex CLI leaves two empty `.tmp*` directories there on every turn (issue #955, ADR 0047). The runtime removes them with the directory after the turn. The reviewer prompt tells the reviewer to build a temporary path from the directory that those variables name when one is set, and never to write a literal path to the system temporary directory, because the removal covers only the private directory. The runtime lists an entry that appears directly in the inherited directory during a reviewer turn as `inheritedTmpdirEntries`, and deletes none (issue #1024). `AGENT_LOOP_SESSION_RECORDS_ROOT` overrides the default `<os tmpdir>/agent-loops/session-records`.
- The runtime lists the inherited temporary directories in `AGENT_LOOP_INHERITED_TMPDIR`, as a JSON array of absolute paths, for the installer check of a package-runner root. The parent resolves every entry before it forwards the list, and forwards `unusable` for a value that it cannot resolve. A value that is present but is not a valid list makes the installer refuse every root. A helper process removes the turn directory only when its device and inode match the recorded ones, and ends at a 30-second bound. A replacement between the final check and `rmdir` loses at most an empty directory, because Node has no directory-handle delete.
- Choose the mode at init, and never change it later. The state file holds
  `reviewerSandbox` (`none`, `read-only`, or `workspace-write`) for a Codex reviewer
  only. A later call may repeat the
  flag or omit it, which reads the stored value. Any other value is refused with
  `cannot be changed after init`, in either direction. A headless
  `--continue-from` run keeps the mode of the earlier run, and a flag that names
  another mode is refused. No turn sets it.
- A state file or a transcript from before ADR 0038 has no recorded mode. It gets
  `workspace-write` when it held `--reviewer-workspace-write`, and `read-only`
  otherwise. It never gets the no-sandbox mode.
- Required-check reads with no sandbox: the runtime still supplies the status
  first. When the orchestrator is `codex`, `copilot`, or unnamed, a headless run
  with `--require-ci` now tells the orchestrator that the reviewer turns do the
  wait, because a no-sandbox Codex reviewer keeps shell network. A waiting
  orchestrator (`claude`, `agy`, `opencode`) still runs `agent-loop role
  wait-checks`, whatever the reviewer mode. A sandboxed Codex reviewer with a
  non-waiting orchestrator stays on the gate rule. The `--require-ci` finish gate
  is the only read that enforces.
- The mutation check is detection only. With no sandbox, or in `workspace-write`,
  a reviewer edit succeeds, the run halts with a `MutationError`, exit 1, and the
  runtime does not revert it. The snapshot does not see a write to an ignored
  file, a write outside the repository, or a remote write. The rule against
  remote writes (issue #422) is advisory. An operator who needs containment
  chooses a sandboxed mode, or runs the reviewer in an external sandbox with no
  credential for the remote. Read the accepted gaps in
  [Codex reviewer sandbox mode](../reference/reviewer-safety.md#codex-reviewer-sandbox-mode)
  and
  [Safety trade-off of the no-sandbox mode](../reference/reviewer-safety.md#safety-trade-off-of-the-no-sandbox-mode)
  before you rely on a mode.
- A reviewer `Checks` line that shows a local test run is the reviewer's own
  report. Compare it with `testRun` and with the required CI checks.
