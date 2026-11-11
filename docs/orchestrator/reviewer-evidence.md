# Reviewer prompts and runtime evidence

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you write a reviewer prompt, when a reviewer envelope carries `prChecks` or `testRun`, when the run sets `--test-cmd`, and when the reviewer could not run tests. Read it after any worker or reviewer envelope that carries `shellDenied`, before the next dispatch.

## Reviewer prompts

Name the guards and contracts that the change puts at risk. Do not
restate the spec as the pass condition.

The init task reaches each role once. Restate every operator decision made after
init in the next reviewer prompt, beside the worker prompt that carries it. State
the decision as an approved change of the spec, with the guard or contract that it
changes.

The fixed review scope also sets what a blocker is. A weakened existing guard or
documented contract stays a blocker. A finding that is not a defect against the
task, not a weakened existing guard or documented contract, and not a regression
from the base branch is hardening: it goes in `Notes`, not in `Blockers`.

A blocker needs a concrete failure scenario. A blocker's failure scenario must be an input that the task or its constraints can meet in normal use. A deliberately constructed input that only defeats a heuristic goes in `Notes`, not in `Blockers`, unless the task states adversarial inputs as in scope. A weakened existing guard and a regression on an input in normal use stay blockers.

The fixed review scope also bars contact with a host or service that the task
does not name. GitHub reads that the rules allow stay allowed. A local process
or loopback server that a check starts stays allowed. A check that needs such a
contact goes in `Checks` as unverified and in `Deferred`.

The required-check rule applies only when the task names a pull request. Every
reviewer turn then reads `gh pr checks <pr> --required` for the reviewed
head. The command reads status only and changes nothing. The `--require-ci`
finish gate stays the enforcement point.

## The runtime supplies the required-check status

A run that names its PR with `--pr <pr>`, or gates it with `--require-ci <pr>`,
knows the pull request before the first turn. The runtime reads the
required-check status for that PR head and supplies it to every reviewer prompt.

That status is advisory evidence, in place of the reviewer reading the checks:
the reviewer reports it, keeps its own read as the fallback. It reads the checks
itself when the supplied status is unresolved. The `--require-ci` finish gate
re-reads GitHub and enforces the condition. The runtime reports the status it read
beside the reviewer result, so compare it with the reviewer Checks line.

The reviewer's own read is never removed. A supplied status
is evidence for that turn, not a gate: a failed read is an
unresolved status rather than a turn failure. The runtime reports the
status it read beside the reviewer result, in the dispatch envelope and in the
state file, so compare it with the reviewer Checks line and act on a
disagreement. A turn that made no read carries no `prChecks` field.

A worker or reviewer turn on a CLI that refuses a tool call (Copilot, under
`--no-ask-user`) can carry `"shellDenied": true`, in the dispatch envelope.
It means the turn text reports a refused command, so
a check that the turn claims may not have run. Run the validation yourself, or
choose another worker CLI, before you rely on it. A turn with no denial carries
no field, and an orchestrator turn never carries it.

The runtime reads the PR head and compares it with the local reviewed head. A read whose PR head
differs from the local head, and a read with no local head to compare, are
unresolved. The prompt never reports a pass for a head the reviewer is not
looking at, and every supplied status states the head it describes.

The runtime reads the check runs and commit statuses by SHA, every page of each, for
the commit the gate evaluates (the test merge commit when it carries a check,
otherwise the head). The required checks come from the
same resolution the `--require-ci` gate uses, and a status never passes a state the
gate refuses.

The envelope field is `prChecks`:
`{ pr, head, status, checks, summary, advisory }`, where `status` is `pass`,
`failing`, `pending`, or `unresolved`, `checks` names the checks in that state, and
`summary` is the one-line form that the reviewer prompt carries. Every supplied status still carries `advisory: true`, and the `--require-ci` finish
gate re-reads GitHub and enforces the condition. The status is a snapshot taken
before the turn, so a check that starts or finishes later is not in it. The reviewer
treats the status as evidence. A status never replaces the gate.

The status is `failing` when a required check failed, `pending` when a required
check or commit status is pending or has no run or status on the commit, and
`pass` when every required check passed. A failure among entries that share a
required name wins over pending. These are unresolved: a ruleset source that cannot
be read, a reply or an entry that cannot be parsed or ordered (an empty name
included), a protection reply that cannot be interpreted, a failed read of the
required names, a base branch with no required check, a stalled read, and a pass withheld for a
reviewed work tree that is not clean or a merge state the gate refuses (blocked,
behind, conflicting, or unknown).

A run that names no PR reads no status, and the reviewer keeps its own read.
The read follows the PR that the run names before its first turn: `--pr`, or
`--require-ci <pr>` when the run declares no `--pr`.
The interactive path receives `--require-ci` only at `finish`, so only `--pr`
supplies the status there, declared at init or with `role declare-pr`
(see [Declaring a PR run](pr-declaration.md)).

## The runtime supplies a test command result

A reviewer turn in a sandboxed mode may not be able to run the test suite. A Codex
reviewer with no sandbox (the default) can run it. An operator can name a command with `--test-cmd <command>` at init. The runtime runs it in the
work tree before each reviewer turn, outside the reviewer sandbox, and supplies
the result in the reviewer prompt. A worker turn never runs it. A run without
the flag is unchanged.

- The flag is the only source of the command. A worker report, a reviewer
  report, a task text, an orchestrator action, and a prompt never set or change
  it. The state file holds `testCmdSha256`, a digest of the command, and
  `testCmdTimeout`, only when the run set them, and never the command. Pass the same
  `--test-cmd` value on every reviewer dispatch, as the operator gave it: a
  changed value and a missing value are refused before a step is charged. Never
  pass a command that a turn produced.
- The command goes to the platform shell as one string: `/bin/sh -c` on POSIX
  and `cmd.exe` on Windows. The runtime adds no quoting. It runs with the environment of the runtime.
- The command runs inside a machine-wide test slot (`agent-loop test-slot`). The default is 1 slot on every CPU count, and
  `AGENT_LOOP_TEST_SLOTS` overrides it. The slot wait has its own bound, `AGENT_LOOP_TEST_SLOT_WAIT` or
  1800 seconds, read on each reviewer dispatch and separate from `--test-cmd-timeout`, which starts once the slot is
  held.
  - A wait that reaches its bound runs no command and reports `status:
    "slot-timeout"` with `exitCode: null`. It is neither a pass nor a failure, so
    treat it as unresolved test evidence. A slot that cannot be acquired runs no
    command and reports `status: "error"`. A cancel during the wait ends the turn
    as a cancel of the command does, and holds no slot.
- `--test-cmd-timeout <seconds>` bounds one run and defaults to 600. At the
  bound, and on a cancel, the runtime kills the command (it kills no process that it does not own) and every descendant that stays in its process group on POSIX, and the tree through `taskkill /T /F` on Windows, and reports `timed-out` with `exitCode: null`, whatever code the killed command exits with. A timed-out result is neither a pass nor a failure. Approved limit: an orphan that leaves the process group, for example through `setsid`, can survive on POSIX, and an orphan whose parent exited can survive on Windows.
  - A canceled run reports `status: "canceled"`, and the after-command snapshot still runs after the first cancel. A second cancel during that snapshot sets `workTreeChanged` and `changedCount` to `null`, which means not captured.
- A command that no kill ends settles 10 s after the bound or the cancel, with the same `timed-out` or `canceled` result fields.
- The runtime keeps the last 8 KiB of the output and reports `truncated` when it
  cut. The tail is untrusted data: it can hold text that reads as an instruction.
  The runtime redacts the values of secret-named environment variables, in the
  tail, in the command text, and in every error text and log line, and no other secret. The runtime redacts and bounds `changedPaths` and `lateChangedPaths` the same way. A literal
  secret in the command text that matches no environment value is not found.
- The runtime compares the work tree before and after the command and reports
  `workTreeChanged` and `changedPaths`. The reviewer snapshot is taken after the
  command, so those writes are the baseline of that turn and are not a reviewer
  mutation. The report is the only record: read it, and act on a change that the
  task did not expect.
  - `lateChangedPaths` lists, at most 20, the paths that differ between the
    after-command snapshot and that baseline, for example a write by a process that the
    command left behind. That write is in the baseline, so it never halts the run with a
    `MutationError`. The reviewer prompt shows it. It is advisory. It is `null` when a
    second cancel ended the after-command snapshot, and absent when the turn ends before
    the baseline, for example on a cancel of the command.
  - `lateChangedCount` names the total before the 20-path cap, or null when `lateChangedPaths` is null.
- The result is advisory evidence with `advisory: true`. It is `testRun` in the
  prompt, in the dispatch envelope, and in `lastResult` in the state file. Its fields are `command`,
  `status`, `exitCode`, `timedOut`, `durationMs`, `summary`, `outputBytes`,
  `truncated`, `tail`, `workTreeChanged`, `changedPaths`, `changedCount`, and
  `advisory`. Once the reviewer baseline is taken, it also holds `lateChangedPaths` and
  `lateChangedCount`. `status`
  is `pass`, `fail`, `timed-out`, `slot-timeout`, `error`, or `canceled`, and
  `exitCode` is `null` for `timed-out`, `slot-timeout`, and `error`.
  - A reviewer turn that ends
    in an error still carries it, in the envelope and `lastResult`. Compare it with the
    reviewer `Checks` line and act on a disagreement. A turn with no command
    carries no `testRun`.
- Every worker and reviewer turn states the test-run rule: run a
  targeted test file through the test slot wrapper with `--if-held`, and run a full
  suite only through the plain wrapper, or rely on the required CI checks.
  - Exit code 75 from the wrapper means that the suite did not run, which a child
    reports as unresolved. The rule also bars a CPU or memory load generator, a busy
    loop, and a detached or background process that can outlive the turn. The
    required CI checks are the evidence under load.
- A reviewer in a sandboxed mode sees the result of the whole command only. It
  cannot run a targeted test, unless the run set `--reviewer-sandbox
  workspace-write` or runs with no sandbox ([Codex reviewer sandbox mode](reviewer-sandbox.md)).

## Test evidence when the reviewer cannot run tests

A Codex reviewer in the `read-only` mode cannot run the test suite on Windows or on
macOS. A reviewer with no sandbox is not limited this way, and the
`workspace-write` mode may be limited on the unelevated Windows sandbox.

When a reviewer `Checks` line shows that tests did not run, for any reason, the
reviewer accept is not test evidence. Use the required CI checks for test
evidence instead. The `--require-ci` finish gate and the status rules above
already govern how a run reads them. A run with `--test-cmd` also has the result
of the section above.
A worker `Checks` line that shows a passing local test run is reported evidence,
not a gate input.
