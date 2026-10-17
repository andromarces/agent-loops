# 0040. Run the test command in a test slot and route child full suites through the wrapper

## Status

accepted

Partially supersedes [ADR 0017: Run an operator test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md). ADR 0017 runs the command before every reviewer turn. This ADR runs it only inside a machine-wide test slot, and adds the `slot-timeout` result for a command that did not run. Every other decision of ADR 0017 holds.

Partially superseded by [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md). ADR 0044 changes the targeted-run part of decision 6: a targeted run goes through the wrapper with `--if-held`.

## Date

2026-10-15

## Context

Several `agent-loop` runs can share one host, in one project or in several. The runtime `--test-cmd` and the test runs that worker and reviewer turns start themselves run unthrottled, so parallel runs oversubscribe the host and full suites time out (issue #848). ADR 0039 adds the machine-wide test slot and the `agent-loop test-slot` wrapper, which help only the runs that go through them.

## Decision

1. **Slot.** The runtime runs `--test-cmd` inside a test slot of ADR 0039. It calls the slot module (`holdTestSlot` in `src/lib/test-slot.mjs`) directly and spawns no wrapper. The slot count, the slot directory, the stale recovery, and the approved limits are those of ADR 0039, through the same environment variables.
2. **Wait bound.** The slot wait has its own bound, `AGENT_LOOP_TEST_SLOT_WAIT` or 1800 s, separate from `--test-cmd-timeout`. The command bound starts once the slot is held. A wait that reaches its bound runs no command and gives `testRun.status` `slot-timeout`, with `exitCode: null`, `workTreeChanged: false`, and `advisory: true`. It is neither a pass nor a failure.
3. **Fail closed.** A slot that cannot be acquired, for example an unwritable slot directory or an invalid environment value, runs no command and gives `status: "error"` with the reason in `summary`.
4. **Cancel.** A cancel during the wait holds no slot afterward and throws the cancel of today, which carries a `canceled` result whose summary states that the command did not run.
5. **Nested marker.** The command runs with the marker of ADR 0039, so a `--test-cmd` that calls the wrapper runs at once in the slot of the runtime. A runtime that starts under a live marker runs the command at once.
6. **Prompt rule.** Every worker turn preamble and every reviewer turn states: run a targeted test file directly, and run a full suite only through the test slot wrapper, or rely on the required CI checks. The wrapper command names the Node binary and the CLI script of the running process, in the shell forms of the `role wait-checks` command, so it works where `agent-loop` is not on PATH. A path that cannot be quoted in every shell leaves only the CI checks. Exit code 75 is reported as unresolved. The headless and role paths render both prompts through `runChild`, so they give the same text.

## Consequences

- Runs on one host that use `--test-cmd` no longer run their commands beyond the slot count, and child turns that follow the rule share the same count.
- A busy host can delay a reviewer turn by up to the slot wait bound, and a `slot-timeout` reviewer turn has no test evidence from the runtime.
- The prompt rule is advisory. The runtime does not detect a child full suite that skips the wrapper.
- A failed slot release after the command logs an error and keeps the result. The slot stays held until the runtime process exits, when the stale-owner rules reclaim it.

## Alternatives

1. **Spawn `agent-loop test-slot` around the command.** Rejected by the maintainer. A direct call keeps the runtime result statuses and needs no exit-code mapping.
2. **Bound the wait by `--test-cmd-timeout`.** Rejected. The wait and the run measure different things, and a long wait would cut the run short.
3. **Run the command unthrottled when the slot cannot be acquired.** Rejected. It defeats the slot on the host that most needs it.
4. **A new `--test-cmd-slot-wait` flag.** Not taken. The environment variable of ADR 0039 already sets the wait, and a flag would add state for the role path to store and check.

## Authors

Andro Marces

## Links

- [Issue #848](https://github.com/andromarces/agent-loops/issues/848)
- [ADR 0017: Run an operator test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR 0039: Gate full-suite test runs with a machine-wide test slot](0039-machine-wide-test-slot.md)
- Partially superseded by [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md)
- Implementation:
  - Source: `runTestCmd` in `src/lib/test-cmd.mjs`
  - Source: `holdTestSlot` and `testSlotOptions` in `src/lib/test-slot.mjs`
  - Source: `testSlotRule` and `cliCommandForms` in `src/prompts/report.mjs`
- [ADR Index](README.md)
