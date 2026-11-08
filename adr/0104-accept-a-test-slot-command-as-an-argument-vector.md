# 0104. Accept a test-slot command as an argument vector

## Status

accepted

Partially supersedes [ADR 0039: Gate full-suite test runs with a machine-wide test slot](0039-machine-wide-test-slot.md) decision 1. That decision made the command one argument, run through the platform shell. This ADR keeps that form and adds an argument vector for two or more arguments after `--`, spawned without a shell. Every other decision of ADR 0039 holds.

## Date

2026-11-08

## Context

`agent-loop test-slot` took the suite command as one shell string and ran it in `cmd.exe` on Windows. The #1590 rule in `testSlotRule` named `cmd.exe` and told a Git Bash child to pass `bash -c '<command>'` or use absolute paths. Issue #1673 records a child that still got the quoting wrong on its first call after that rule shipped. The wrapper exited with a usage or command error, the suite never ran, and the turn spent a run to recover.

A shell string crosses two shells on Windows from Git Bash: the child's bash and the wrapper's `cmd.exe`. Each shell reads the quotes again. An argument vector crosses no shell, so no quoting step applies. The maintainer chose the vector option on 2026-11-08.

## Decision

1. **Argument vector.** Two or more arguments after `--` form an argument vector. The wrapper spawns the first argument as the executable with the rest as its arguments, without a shell.
2. **One-string form.** One argument after `--` keeps the shell-string form of ADR 0039 decision 1: the wrapper runs it in the platform shell (`/bin/sh -c`, or `cmd.exe` on Windows). A call without `--` and more than one argument, a call with no command, and a vector with an empty executable are usage errors.
3. **Unchanged contracts.** The vector keeps the slot count, the wait bound, the `--if-held` rule, the nested marker, the process-group or process-tree kill, and the exit-code mapping of ADR 0039, ADR 0044, and ADR 0046. The wrapper runs the vector in the same current directory, with stdout and stderr passed through and stdin closed, and logs no command text.
4. **Windows executable limit.** On Windows the vector must start with a real executable such as `node`, not a `.cmd` shim such as `pnpm`. The OS cannot spawn a `.cmd` file without a shell, so such a vector fails as a wrapper failure. The rule states this limit.
5. **Rule text.** `testSlotRule` in `src/prompts/rules.mjs` renders the argument-vector form and names it as the default from Git Bash on Windows. It keeps the one-string form, the platform-shell sentence, and the exit 75 report.
6. **Test.** A test covers the vector form: the parser, a run that passes a shell metacharacter unchanged and keeps the command exit code and slot release, and the rendered rule text.

## Consequences

- A Git Bash child on Windows runs a targeted test through the wrapper with no quoting step, which removes the observed failure.
- A caller that holds a command with shell operators in one string keeps the shell-string form. A caller that needs a shell pipeline must use that form, because the vector runs no shell.
- A Windows caller that names a `.cmd` shim in the vector gets a wrapper failure, not a silent shell run. The rule names the limit.
- The rendered rule text is longer. It names both forms, and the vector form is the default for Git Bash on Windows.
- The slot, wait, kill, nested, and exit-code behavior is one path for both forms, so a vector caller keeps every contract of the one-string caller.

## Alternatives

1. **Render a ready-to-run example for the detected shell with the runner path filled in (issue option 2).** Not taken by the maintainer. It depends on the target repository's runner layout and still needs shell quoting.
2. **Join the remaining arguments into the command text.** Rejected in ADR 0039 alternative 3. The calling shell removes the quotes of each argument, so a join changes the meaning of any argument with spaces or shell operators.
3. **Drop the one-string form.** Not taken. Existing callers and shell pipelines keep it, and the change adds no migration.

## Authors

Andro Marces

## Links

- [Issue #1673](https://github.com/andromarces/agent-loops/issues/1673)
- Partially supersedes [ADR 0039: Gate full-suite test runs with a machine-wide test slot](0039-machine-wide-test-slot.md) decision 1
- [ADR 0040: Run the test command in a test slot and route child full suites through the wrapper](0040-run-the-test-command-in-a-test-slot.md)
- [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md)
- [ADR 0046: Default the test slot count to one](0046-default-the-test-slot-count-to-one.md)
- [ADR 0099: Let a targeted run include tests that read a changed non-module file by path](0099-let-a-targeted-run-include-tests-that-read-a-changed-non-module-file-by-path.md)
- Related issue: #1590
- Implementation:
  - Source: `parseTestSlotArgs` and `runCommand` in `src/lib/test-slot-cli.mjs`, `testSlotRule` in `src/prompts/rules.mjs`
  - Tests: `tests/lib/test-slot.test.mjs`, `tests/prompts/report.test.mjs`, `tests/prompts/worker.test.mjs`, `tests/prompts/reviewer.test.mjs`
  - Docs: `docs/reference/usage.md`
- [ADR Index](README.md)
