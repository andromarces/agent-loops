# 0010. Supply the required-check status to the reviewer from the runtime

## Status

accepted

## Date

2026-09-28

## Context

Since issue #313, the fixed reviewer scope asks every reviewer turn whose task
names a pull request to read `gh pr checks <pr> --required` and to report a
failing required check as a blocker. The read depends on the reviewer: a
reviewer whose CLI cannot reach the network, for example a sandboxed `codex`
reviewer, can only report the status as unresolved, and the `--require-ci` gate
refuses the finish on the real condition. The run then spends a worker turn and
another reviewer turn to learn a status the runtime could have read.

The runtime could not supply that status, because it did not know the pull
request before `finish`. ADR 0009 added `--pr <pr>` as the run's PR input at
init, on both the headless command line and the interactive init call, so the
number is now known before the first turn.

Issue #320 asks for the second option of issue #313, which was left out of scope
there: supply the status to each reviewer prompt when the run carries a PR
input, and report the status the runtime read so a parent can compare it with
the reviewer `Checks` line.

## Decision

1. A run that declares a PR reads the required-check status for that PR head
   before each reviewer turn and supplies it in the reviewer prompt. The read
   is `gh pr checks <pr> --required --json name,bucket` in the run's work tree,
   through the same injected `gh` runner the `--require-ci` gate uses.
2. The read is keyed on `--pr`, which is the PR input both paths know at
   dispatch. A run that declares no PR reads nothing. A headless run that takes
   only `--require-ci` and declares no `--pr` reads nothing, because the gate
   flag is not the declared PR input.
3. The supplied status is added to the reviewer prompt as two lines inside the
   existing required-check group, so it applies only under the pull request
   condition and never narrows the guard rules above it. The first line names the
   PR and the status. The second states that the reviewer's own read stays the
   fallback, is preferred when the supplied status is unresolved, and any
   difference between the two goes in `Checks`.
4. The reviewer's own read is never removed. The supplied status is evidence for
   one turn, not a gate: `gh pr checks` lists only the checks that already
   reported, so a supplied pass covers the listed checks only, and the read
   reflects the PR head on GitHub rather than the local reviewed head.
5. The read never fails a turn. A `gh` failure, a non-zero exit with no listed
   check, and an unparseable or empty reply are all an `unresolved` status, which
   the prompt rule already sends back to the reviewer's own read.
6. The status is reported with the reviewer result: as `prChecks` in the
   dispatch envelope and beside the response in the state file's `lastResult`, so
   a parent can compare it with the reviewer `Checks` line. The `turns` entry
   keeps the fixed shape ADR 0008 defines, so the status is not recorded there.
7. `--require-ci` stays the enforcement point. The supplied status changes no
   gate condition and no refusal.

## Consequences

- A reviewer whose CLI cannot reach the network sees the failing check on the PR
  head, so the run no longer needs a worker turn and a reviewer turn to learn it.
- The parent can compare two independent reads of the same status, so a
  disagreement between the runtime and the reviewer is visible.
- Every reviewer turn in a declared-PR run costs one `gh pr checks` call. It is
  a status read that changes nothing, and it is a read the reviewer prompt
  already asks the reviewer to make.
- The status is a point-in-time read, taken before the turn. A check that starts
  or finishes after it is not reflected, which is why the reviewer keeps its own
  read and reports a difference.
- A run that declares no PR gains nothing and loses nothing: the reviewer's own
  read is the only read, as before.
- A declared-PR run whose reviewer CLI can reach the network now reads the status
  twice, once in the runtime and once in the reviewer. The prompt tells the
  reviewer to report the supplied status rather than read again, so the second
  read happens only when the reviewer needs the fallback.

## Alternatives

1. **Keep the reviewer read only and let the reviewer prompt name the PR**:
   that is the behavior since #313 and the reason for this issue. Rejected; a
   reviewer without network can only report unresolved.
2. **Gate on the supplied status instead of keeping the `--require-ci` gate**:
   the supplied status covers only the listed checks and no merge state, so it
   cannot replace the gate. Rejected; the gate stays the enforcement point.
3. **Refuse the reviewer turn when the status read fails**: a read failure is
   not a verdict on the work, and the reviewer turn would end for a reason
   outside the run's reach. Rejected; the read fails closed to `unresolved`.
4. **Record the supplied status in the `turns` entry too**: it would grow the
   fixed entry shape ADR 0008 defines. Rejected; `lastResult` and the envelope
   carry it, and the requirement is a comparison, not a history.

## Authors

Andro Marces

## Links

- [Issue #320: Put the runtime-read required-check status into each reviewer prompt when the run has a PR input](https://github.com/andromarces/agent-loops/issues/320)
- [Issue #313: Show required-check status to the reviewer before it accepts a PR head](https://github.com/andromarces/agent-loops/issues/313)
- [Issue #302: Require a PR input on every run so an omitted unresolvedCompare marker cannot read as verified](https://github.com/andromarces/agent-loops/issues/302)
- Implementation: `readRequiredChecks` in `src/lib/ci-gate.mjs`, `runtimeReadLines` in `src/prompts/reviewer.mjs`, the read and the `prChecks` result field in `runChild` in `src/runtime.mjs`, the dispatch wiring and the `prChecks` envelope field in `src/role.mjs`; tests in `tests/lib/ci-gate.test.mjs`, `tests/prompts/reviewer.test.mjs`, `tests/runtime.test.mjs`, and `tests/role.dispatch.test.mjs`; documented in `docs/orchestrator-instructions.md` and `README.md`
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR Index](README.md)
