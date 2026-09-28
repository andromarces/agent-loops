# 0008. Keep the turn history in the state file

## Status

accepted

## Date

2026-09-28

## Context

An `agent-loop role` run left no per-turn record on disk. The state file held
only `lastDispatch` and `lastResult`, and every dispatch overwrote both, so after
a finished run nothing showed which turns ran, which verdicts they returned, or
when they ran. A review of the #305 run for PR #307 (10 turns, three reviewer
rejects, one accept that CI then blocked, and a finish) had to rebuild each turn
from the parent harness conversation log (#312).

`--transcript <file>` already records one `result` event per turn, but it is a
per-call flag and the state file does not store it. An orchestrator must pass
the same path on every `dispatch` and `finish` call, and
`docs/orchestrator-instructions.md` never mentions the flag, so an orchestrator
following the instructions records nothing.

## Decision

1. Every `agent-loop role` dispatch appends one entry to a `turns` array in the
   state file, whether or not `--transcript` was passed. The entry holds the
   turn's identity, not its text: `role`, `status`, `verdict` (the parsed
   reviewer verdict, `null` for every other turn), `head` (the head a reviewer
   turn reviewed, `null` otherwise), and `at`.
2. Exactly one entry exists per charged step. `status` is `ok`, `error`, or
   `interrupted`. An entry is appended when a dispatch records its result, when
   a child fails, and when the recovery call records the turn a crash left in
   `dispatched`. The last of these runs no child and charges no step: it records
   the already-charged turn the crashed call never recorded, so the history stays
   complete across recovery. It takes the role and time from that turn's
   `lastDispatch`, because the recovery call's `--role` need not be the role that
   ended uncertainly, and it records no verdict and no head, because no child
   result was ever observed.
3. A resumed turn is charged and recorded once on its own, so the uncertain turn
   and the resumed turn are two distinct entries, not the uncertain one twice.
4. Report and response text stay out of the entry. `lastResult` keeps the full
   last response; the history keeps only the fields a later review needs.
5. Size bound: one entry per charged step, and a dispatch past `maxSteps` is
   refused before it runs, so the array holds at most `maxSteps` fixed-shape
   entries. The recovery entry does not consume a step of its own; it accounts
   for the step the crashed call already charged, so the bound still holds.
   No truncation or pruning rule is needed because the step budget already caps
   the count.
6. The accepted `--max-steps` range is 1 to `Number.MAX_SAFE_INTEGER`
   (9007199254740991). The shared integer readers in `src/lib/args.mjs` accept a
   safe integer only, so the headless CLI and the role subcommand refuse the same
   values. Above that range an integer double has no room for `value + 1`: a
   step counter would stop advancing and the bound above would hold for no
   accepted value.
7. `verdict` is parsed from a reviewer turn's own closing block, so it cannot be
   inferred from process success. The state file is the only place the history
   lives; `--transcript` stays a per-call per-event log and is not the history.
8. A state file written before this field starts with an empty history, so a run
   that began on an earlier version keeps working.

## Consequences

- A finished, aborted, or halted run shows every turn on disk, so a later review
  reads the run instead of the parent conversation log.
- The state file grows by one small entry per turn, bounded by `maxSteps`.
- A `--max-steps` value above `Number.MAX_SAFE_INTEGER` is now refused by both
  the headless CLI and the role subcommand, where it was previously accepted.
  Any caller that passed such a value must lower it; no realistic run needs more
  than `Number.MAX_SAFE_INTEGER` steps.
- `docs/orchestrator-instructions.md` documents the history, so an orchestrator
  following the instructions reads it after compaction or restart.
- A turn's response text is still only in `lastResult` and, with
  `--transcript`, in that file. Full text for an earlier turn is not on disk by
  default; `--transcript` remains the opt-in path for it.
- Nothing else reads `turns`: the parent guard still evaluates `lifecycle` and
  `parentSession` only.

## Alternatives

1. **Record `--transcript` at init and append to it on later calls**: one flag
   covers the run, but it changes a per-call flag into a run-level contract,
   needs a stored path plus a create-if-absent rule, and writes a second file
   beside the state file. Rejected; the state file is already per run and is
   archived with the run.
2. **Write a default transcript beside `state.json` and archive it with the
   state file**: keeps full per-turn text, but the size is then unbounded by any
   step count because each child response is arbitrary, and archiving has to
   rename a second file. Rejected; the history is meant to be identity, not
   text.

## Authors

Andro Marces

## Links

- [Issue #312: Keep a turn history for a role run without a per-call --transcript flag](https://github.com/andromarces/agent-loops/issues/312)
- [PR #325: feat: keep a per-run turn history in the state file (#312)](https://github.com/andromarces/agent-loops/pull/325)
- Implementation: `recordTurn` in `src/role.mjs`; tests in `tests/role.turn-history.test.mjs`; documented in `docs/orchestrator-instructions.md` and `README.md`
- [ADR 0007: Concurrent role runs from one parent session](0007-concurrent-session-runs.md)
- [ADR Index](README.md)
