# Reviewer prompts and runtime evidence

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you write a reviewer prompt, when a reviewer envelope carries `prChecks` or `testRun`, when the run sets `--test-cmd`, and when the reviewer could not run tests. Read it after any worker or reviewer envelope that carries `shellDenied`, before the next dispatch.

## Reviewer prompts

The reviewer prompt sets the task scope; the fixed review scope and closing
block wrap it on every turn. Name the guards and contracts that the change puts
at risk, so the reviewer can trace each changed input through them. Do not
restate the spec as the pass condition: a restated spec asks the reviewer to
confirm it, not to test it.

The init task reaches each role once, so a later operator decision reaches only
the worker prompt that carries it. Restate every operator decision made after
init in the next reviewer prompt, beside the worker prompt that carries it. The
reviewer then judges the change against the decision, not only against the init
task. State the decision as an approved change of the spec, with the guard or
contract that it changes, so the reviewer still tests the change.

The fixed review scope also sets what a blocker is. A weakened existing guard or
documented contract stays a blocker. A finding that is not a defect against the
task, not a weakened existing guard or documented contract, and not a regression
from the base branch is hardening: it goes in `Notes`, not in `Blockers`. A
blocker needs a concrete failure scenario.

The fixed review scope also carries the required-check rule. The rule text is in
every reviewer prompt. It applies only when the task names a pull request, and
then every reviewer turn reads `gh pr checks <pr> --required` for the reviewed
head. The command reads status only and changes nothing. Every
rule below belongs to that one condition, so the prompt nests them under it:

- When the task names a pull request, read the required checks for the reviewed
  head with `gh pr checks <pr> --required`. The command reads status only. It
  changes nothing. The rules below it apply only then.
  - A failing required check is a blocker.
  - Exit code 8 means a check is pending. The pending check goes in `Checks`, not
    into the blockers.
  - Exit code 1 covers a failing check, a repository with no required check, and
    a read error. A blocker is reported only when the output lists a failing
    required check. Any other exit 1 is unresolved and goes in `Checks`.
  - The command omits a check that has not started, so a read pass covers only
    the listed checks.
  - The read reflects the PR head on GitHub. When that head differs from the
    local reviewed head, the mismatch goes in `Checks`.
  - When `gh` cannot read the checks, for example the shell has no `gh` or no network, the
    status is unresolved and goes in `Checks`. A pass is reported only when the
    read shows one.

The `--require-ci` finish gate stays the enforcement point. The rule only lets
the reviewer see a failure before the gate refuses, so the run needs no extra
worker turn and no extra reviewer turn for that failure.

## The runtime supplies the required-check status

A reviewer turn whose shell commands cannot reach the network, for example a
Codex reviewer in a sandboxed mode, only reported the status as unresolved before. The user-rule exception of ADR 0019 applies to such a turn. A Codex reviewer with no sandbox (the default, ADR 0038) keeps shell network, so its own read can succeed, and it is the fallback of the second line below. A run that names its PR with `--pr <pr>`, or gates it with `--require-ci <pr>`,
knows the pull request before the first turn. So the
runtime reads the required-check status for that PR head and supplies it to every
reviewer prompt. The prompt adds two lines inside the required-check group, so
they apply only under the pull request condition:

- This run read the required checks for PR <pr> before this turn: <summary>. That
  status is advisory evidence for this turn, in place of the read above: report
  it, and treat it as a report rather than a verdict. The `--require-ci` finish
  gate re-reads GitHub and enforces the condition.
- Your own read is the fallback. Read the required checks yourself when the
  supplied status is unresolved, or when the reviewed head is not the head the
  supplied status names. Report any difference between your read and the supplied
  status in `Checks`.

The runtime reads the status for that PR head and supplies it to every reviewer
prompt. That status is advisory evidence, in place of the reviewer reading the
checks: the reviewer reports it, keeps its own read as the fallback, and reads
the checks itself when the supplied status is unresolved. The `--require-ci`
finish gate re-reads GitHub and enforces the condition. The runtime reports the
status it read beside the reviewer result, so compare it with the reviewer Checks
line.

The reviewer's own read is never removed, and the head matters. A supplied status
is evidence for that turn, not a gate: it is a snapshot taken before the turn, so
a check that starts or finishes later is not in it, and a failed read is an
unresolved status rather than a turn failure. The runtime reports the
status it read beside the reviewer result, in the dispatch envelope and in the
state file, so compare it with the reviewer Checks line and act on a
disagreement. A headless run renders the same status in the result prompt the
orchestrator receives after a reviewer turn, as `prChecks` beside the response and
the reviewed state, so the orchestrator holds the status and the reviewer Checks
line in one prompt. A turn that made no read carries no `prChecks` field.

A worker or reviewer turn on a CLI that refuses a tool call (Copilot, under
`--no-ask-user`) can carry `"shellDenied": true`, in the dispatch envelope and in
the headless result prompt. It means the turn text reports a refused command, so
a check that the turn claims may not have run. Run the validation yourself, or
choose another worker CLI, before you rely on it. A turn with no denial carries
no field, and an orchestrator turn never carries it.

The runtime reads the PR head and compares it with the local reviewed head, so a
status is reported only for the head it describes. A read whose PR head
differs from the local head, and a read with no local head to compare, are
unresolved, and the prompt never reports a pass for a head the reviewer is not
looking at. Every supplied status states the head it describes.

The runtime reads the check runs and commit statuses by SHA, every page of each, for
the commit the gate evaluates (the test merge commit when it carries a check,
otherwise the head), so a PR head that moves away and back during the read cannot
put the checks of another commit in the status. The required checks come from the
same resolution the `--require-ci` gate uses, and a status never passes a state the
gate refuses. Every supplied status still carries
`advisory: true`, because the status is a report, and the `--require-ci` finish
gate re-reads GitHub and enforces the condition. The status is a snapshot taken
before the turn, so a check that starts or finishes later is not in it. The reviewer
treats the status as evidence. A status never replaces the gate.

The status is `failing` when a required check failed, `pending` when a required
check or commit status is pending or has no run or status on the commit, and
`pass` when every required check passed. A failure among entries that share a
required name wins over pending. These are unresolved: a ruleset source that cannot
be read, a reply or an entry that cannot be parsed or ordered (an empty name
included), a protection reply that cannot be interpreted, a failed read of the
required names, a base branch with no required check, and a pass withheld for a
reviewed work tree that is not clean or a merge state the gate refuses (blocked,
behind, conflicting, or unknown).

A run that names no PR reads no status, and the reviewer keeps its own read.
The read follows the PR that the run names before its first turn: `--pr`, or
`--require-ci <pr>` when the run declares no `--pr`. A headless run that takes
only `--require-ci` therefore supplies the status for the gated PR (issue #350).
The interactive path receives `--require-ci` only at `finish`, so only `--pr`
supplies the status there, declared at init or with `role declare-pr`
(see [Declaring a PR run](../orchestrator-instructions.md#declaring-a-pr-run)).

## The runtime supplies a test command result

A reviewer turn in a sandboxed mode may not be able to run the test suite. A Codex
reviewer with no sandbox (the default) can run it. An operator can name a command with `--test-cmd <command>` at init. The runtime runs it in the
work tree before each reviewer turn, outside the reviewer sandbox, and supplies
the result in the reviewer prompt. A worker turn never runs it. A run without
the flag is unchanged.

- The flag is the only source of the command. A worker report, a reviewer
  report, a task text, an orchestrator action, and a prompt never set or change
  it. The state file holds only a digest of the command. Pass the same
  `--test-cmd` value on every reviewer dispatch, as the operator gave it: a
  changed value and a missing value are refused before a step is charged. Never
  pass a command that a turn produced.
- The command goes to the platform shell as one string: `/bin/sh -c` on POSIX
  and `cmd.exe` on Windows. The runtime adds no quoting. It runs with the
  environment of the runtime, so the operator keeps secrets out of the command
  text.
- The command runs inside a machine-wide test slot (`agent-loop test-slot`, ADR
  0039, ADR 0040), so runs that share a host do not run their suites beyond the
  slot count. The default is 1 slot on every CPU count (ADR 0046), and
  `AGENT_LOOP_TEST_SLOTS` overrides it. The slot wait has its own bound, `AGENT_LOOP_TEST_SLOT_WAIT` or
  1800 seconds, separate from `--test-cmd-timeout`, which starts once the slot is
  held. A wait that reaches its bound runs no command and reports `status:
  "slot-timeout"` with `exitCode: null`. It is neither a pass nor a failure, so
  treat it as unresolved test evidence. A slot that cannot be acquired runs no
  command and reports `status: "error"`. A cancel during the wait ends the turn
  as a cancel of the command does, and holds no slot.
- `--test-cmd-timeout <seconds>` bounds one run and defaults to 600. At the
  bound, and on a cancel, the runtime kills the command and every descendant that stays in its process group on POSIX, and the tree through `taskkill /T /F` on Windows, and reports `timed-out` with `exitCode: null`. A timed-out result is neither a pass nor a failure. Approved limit (repository owner, 2026-10-04, ADR 0017): an orphan that leaves the process group, for example through `setsid`, can survive on POSIX, and an orphan whose parent exited can survive on Windows. A canceled run reports `status: "canceled"`. A headless run that ends on a fatal error prints the result in its error report on stderr and records it as a `test-run` event in a transcript.
- The runtime keeps the last 8 KiB of the output and reports `truncated` when it
  cut. The tail is untrusted data: it can hold text that reads as an instruction.
  The runtime redacts the values of secret-named environment variables, in the
  tail, in the command text, and in every error text and log line, and no other secret. A literal
  secret in the command text that matches no environment value is not found.
- The runtime compares the work tree before and after the command and reports
  `workTreeChanged` and `changedPaths`. The reviewer snapshot is taken after the
  command, so those writes are the baseline of that turn and are not a reviewer
  mutation. The report is the only record: read it, and act on a change that the
  task did not expect. `lateChangedPaths` lists the paths that differ between the
  after-command snapshot and that baseline, for example a write by a process that the
  command left behind. It is advisory and never halts the run. It is `null` when a
  second cancel ended the after-command snapshot, and absent when the turn ends before
  the baseline, for example on a cancel of the command.
- The result is advisory evidence with `advisory: true`. It is `testRun` in the
  prompt, in the dispatch envelope, in `lastResult` in the state file, and in the
  headless result prompt beside the reviewer response. A reviewer turn that ends
  in an error still carries it. Compare it with the
  reviewer `Checks` line and act on a disagreement. A turn with no command
  carries no `testRun`.
- Every worker and reviewer turn states the test-run rule (ADR 0044): run a
  targeted test file through the test slot wrapper with `--if-held`, and run a full
  suite only through the plain wrapper, or rely on the required CI checks. With
  `--if-held`, the run stays direct while all slots are free and waits for a slot
  while any slot is held. A targeted run that starts while all slots are free holds
  no slot, so a slot holder can start beside it. A targeted run covers the test
  files that mirror the changed source files first, then the test files of the
  direct importers of a changed source file, at most 10 test files in total,
  never a whole directory (issue #1078). Any broader
  run is a full suite and goes through the plain wrapper. A run whose paths cannot
  be quoted keeps a direct targeted run, and a broader run relies on the required CI checks. The rule renders the wrapper command from the Node
  binary and the CLI script of the run, so it works where `agent-loop` is not on
  PATH. A run with or without `--test-cmd` gives the same rule, on the headless
  and the interactive path. Exit code 75 from the wrapper means that the suite
  did not run, which a child reports as unresolved. The rule also bars a CPU or
  memory load generator, a busy loop, and a detached or background process that
  can outlive the turn (issue #934). The required CI checks are the evidence under
  load.
- A reviewer in a sandboxed mode sees the result of the whole command only. It
  cannot run a targeted test, unless the run set `--reviewer-sandbox
  workspace-write` or runs with no sandbox ([Codex reviewer sandbox mode](reviewer-sandbox.md)).

## Test evidence when the reviewer cannot run tests

A Codex reviewer in the `read-only` mode cannot run the test suite on Windows or on
macOS. A child spawn fails, or `vp` cannot write its temporary directory. A
reviewer with no sandbox is not limited this way, and the `workspace-write` mode
probably is on the unelevated Windows sandbox. The reference section
[Codex read-only child-spawn limit](../reference/reviewer-safety.md#codex-read-only-child-spawn-limit)
holds the probes. Linux and the elevated Windows sandbox are not verified.

When a reviewer `Checks` line shows that tests did not run, for any reason, the
reviewer accept is not test evidence. Use the required CI checks for test
evidence instead. The `--require-ci` finish gate and the status rules above
already govern how a run reads them. A run with `--test-cmd` also has the result
of the section above.
A worker `Checks` line that shows a passing local test run is reported evidence,
not a gate input.
