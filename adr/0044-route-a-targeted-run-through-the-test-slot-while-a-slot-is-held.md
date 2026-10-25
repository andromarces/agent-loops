# 0044. Route a targeted run through the test slot while any slot is held

## Status

accepted

Partially supersedes [ADR 0040: Run the test command in a test slot and route child full suites through the wrapper](0040-run-the-test-command-in-a-test-slot.md). ADR 0040 decision 6 tells a child turn to run a targeted test file directly. This ADR tells it to run the file through the wrapper with `--if-held`, which stays direct while all slots are free. Every other decision of ADR 0040 holds.

## Date

2026-10-18

## Context

A direct targeted run holds no slot, so its load is not counted (ADR 0040, issue #872). Issue #921 repeated the slot experiment on Windows, a host with 16 logical CPUs. Every full suite failed in both arms, with 15 s timeouts in each. The arm with one slot still failed, and a direct targeted run overlapped each failing suite. The result points to load outside the slot. The maintainer chose option 2 of the issue on 2026-10-18.

## Decision

1. **`--if-held` flag.** `agent-loop test-slot --if-held` runs the command directly, with no slot and no wait, while no slot file under the slot directory is held by a live owner. While any slot is held, it waits for a slot and runs as a slot holder, as without the flag. The check reads the slot files once, with `lockHeld`, and takes no lock. A missing slot directory holds no slot. A stale slot is not held.
2. **Held means any.** One held slot is enough, whatever `--slots` says, so a targeted run under any load is throttled by the same count and wait bound as a full suite.
3. **Unchanged.** The wait bound (`--wait`, `AGENT_LOOP_TEST_SLOT_WAIT`, 1800 s default), exit 75 reported as unresolved, the nested marker, and the quoting guard are unchanged. A path that cannot be quoted in every shell keeps a direct targeted run of at most 10 files, and a broader run relies on the required CI checks, as before. The 10-file bound of a targeted run stays.
4. **Prompt rule.** `testSlotRule` tells each worker and reviewer turn to run a targeted test file through the wrapper with `--if-held`, and a full suite through the plain wrapper. One command form serves both: the turn adds `--if-held` after `test-slot` for a targeted run.
5. **Documented limit.** A targeted run that starts while all slots are free holds no slot, so a slot holder can start beside it. Closing that gap needs a registration that slot holders count, which this ADR does not add.
6. **No load generator, no process that outlives the turn (issue #934).** The same rule text bars a CPU or memory load generator, a busy loop, and a detached or background process that can outlive the turn, and names the required CI checks as the evidence under load. The rule adds a bar and changes no earlier decision, so it stays in this ADR. The cause was a #927 worker that started 64 busy loops per run from a script with no trap. An interrupted run left the loops running, all 16 CPUs stayed at 100 %, and the editor of the maintainer crashed. The runtime cannot clean up after this, because the crash also ended the `role dispatch` process.
7. **Direct importers inside the bound (issue #1078).** A targeted run covers the test files that mirror the changed source files first, then the test files of the direct importers of a changed source file, at most 10 test files in total and never a whole directory. The 10-file bound of decision 3 stays. A test of a caller can break while every mirror file passes, as in PR #1076, where only CI found 9 failures. The rule adds a permitted scope and changes no earlier decision, so it stays in this ADR. Indirect importers and a broader run keep the plain wrapper or the required CI checks.

## Consequences

- Under load, an edit loop waits as a slot holder, up to the wait bound. This removes the unthrottled targeted load that the Windows result shows.
- While all slots are free, an edit loop has no wait and no slot.
- A targeted run that holds a slot can delay a full suite of another run.
- The limit of decision 5 stays: the check is a snapshot, so a targeted run and a slot holder can overlap.
- A worker or reviewer cannot test timing under synthetic load. The required CI checks give that evidence.
- The runtime `--test-cmd` is unchanged. It already runs in a slot.
- Verified on macOS 27.2 (Darwin 27.2.0, arm64) and Node v26.12.0, on the direct path with all slots free (issue #708, probe on 2026-10-19). The slot directory held no slot file before each run. A command that wrote one line to each stream and exited 7 gave wrapper exit 7. The stdout line reached the wrapper stdout. The stderr line reached the wrapper stderr, between the wrapper log lines.
- Signals, same probe: the command started a `sleep 600` child. One `SIGINT` and one `SIGTERM`, each sent to the wrapper PID only, gave wrapper exit 130 and 143. The process table listed the wrapper, a command shell, and the `sleep` before each signal. None of the three PIDs was alive after the wrapper ended. The slot directory held no slot file during or after each run. The wrapper log named the end of the command as `signal SIGKILL`.

## Alternatives

1. **Route every targeted run through the slot (issue option 1).** Not taken. An edit loop would wait behind a full table, and a targeted run would hold a slot that a full suite then waits for, even when the host is idle.
2. **Keep the direct targeted run and document the risk (issue option 3, ADR 0040).** Not taken. The Windows result shows timeouts under parallel runs with a direct targeted run overlapping each one.
3. **Register direct targeted runs so slot holders count them.** Not taken. It needs new shared state and stale handling for a gap that the maintainer accepted.
4. **Make `--if-held` hold the table lock during the check.** Not taken. A held table lock would not close the gap, because the direct run holds no slot after the check.

## Authors

Andro Marces

## Links

- [Issue #921](https://github.com/andromarces/agent-loops/issues/921)
- Partially supersedes [ADR 0040: Run the test command in a test slot and route child full suites through the wrapper](0040-run-the-test-command-in-a-test-slot.md)
- [ADR 0039: Gate full-suite test runs with a machine-wide test slot](0039-machine-wide-test-slot.md)
- [PR #928](https://github.com/andromarces/agent-loops/pull/928)
- [PR #939](https://github.com/andromarces/agent-loops/pull/939)
- [PR #1084](https://github.com/andromarces/agent-loops/pull/1084) (decision 7, closes [issue #1078](https://github.com/andromarces/agent-loops/issues/1078))
- Related issues: #848, #872, [#934](https://github.com/andromarces/agent-loops/issues/934), [#1078](https://github.com/andromarces/agent-loops/issues/1078)
- Implementation:
  - Source: `holdTestSlot` and `parseTestSlotArgs` in `src/lib/test-slot.mjs`, `testSlotRule` in `src/prompts/report.mjs`
  - Tests: `tests/lib/test-slot.test.mjs`, `tests/prompts/report.test.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/reference/usage.md` (Test slot)
- [ADR Index](README.md)
