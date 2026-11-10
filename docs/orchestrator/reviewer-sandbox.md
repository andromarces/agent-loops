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
- A cache that a tool writes to its own default location, such as a test runner cache under an ignored path or a compile cache in a temporary directory, is not reviewer output. Output under a path that the reviewer chose for the turn, such as a directory that it set `TMPDIR`, `TEMP`, or `TMP` to, or the runtime scratch folder, stays turn output even when a tool writes it there.
  - For a reviewer `Notes` line: A refused cleanup of a tool cache in its default location is not a finding. A cache entry that existed before the turn is not a finding either. Do not carry either into `open`. Output under a path that the reviewer chose, such as its temporary directory or the scratch folder, stays turn output. A refused cleanup of that output or of a probe file that the turn created still goes into `open`. The rule is advisory, and the runtime does not detect a breach.
- Each turn runs with a private temporary directory under the inherited one, set through `TMPDIR`, `TEMP`, and `TMP`.
  - Build a temporary path from the directory that TMPDIR, TEMP, or TMP names when one is set. Never write a literal path to the system temporary directory, such as `/tmp`. The removal covers only the private directory.
- Choose the mode at init, and never change it later. The state file holds
  `reviewerSandbox` (`none`, `read-only`, or `workspace-write`) for a Codex reviewer
  only. A later call may repeat the
  flag or omit it, which reads the stored value. Any other value is refused with
  `cannot be changed after init`, in either direction. No turn sets the mode.
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
documented limits stay in force: the user execpolicy exception, and
model-side tools that the sandbox does not block.
