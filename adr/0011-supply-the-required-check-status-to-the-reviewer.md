# 0011. Supply the required-check status to the reviewer from the runtime

## Status

superseded

Superseded by [ADR 0024: Supply the required-check status to the reviewer for every run that names a PR](0024-supply-the-required-check-status-for-a-named-pr.md). ADR 0024 restates the decisions of this ADR that still hold and replaces the `--pr` keying of the read (decision 2) with the PR a run names through `--pr` or a headless `--require-ci`.

## Date

2026-09-28

## Context

Since issue #313, the fixed reviewer scope asks every reviewer turn whose task
names a pull request to read `gh pr checks <pr> --required` and to report a
failing required check as a blocker. The read depends on the reviewer: a
reviewer whose CLI cannot reach the network, for example a sandboxed `codex`
reviewer, can only report the status as unresolved, and the `--require-ci` gate
refuses the finish on the real condition. A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception, as ADR 0019 states. The run then spends a worker turn and
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

1. A run that declares a PR reads the required-check status for the reviewed
   commit before each reviewer turn and supplies it in the reviewer prompt. The
   read goes through the same injected `gh` runner the `--require-ci` gate uses,
   and reuses the gate's required-context resolution (`requiredContexts`) and
   per-context judgment (`evaluateContext`). It reads the pull request once,
   then the repository, the rulesets, the classic protection, and the check runs
   and commit statuses of `commits/{head}` for the reviewed head (item 4).
2. The read is keyed on `--pr`, which is the PR input both paths know at
   dispatch. A run that declares no PR reads nothing. A headless run that takes
   only `--require-ci` and declares no `--pr` reads nothing, because the gate
   flag is not the declared PR input. Every prompt statement about the supplied
   read is therefore conditional on `--pr`: a gated run that declares no PR gets
   the gate claim without any statement about a status read, because the runtime
   makes none and the prompt must not describe a read that never happens.
3. A status is reported only for the head it describes. The read compares the
   resolved PR head with the local reviewed head, which the runtime already has
   from the pre-turn snapshot. A read whose PR head differs, and a read with no
   local head to compare, are `unresolved`, so the prompt never supplies a pass
   for a head the reviewer is not looking at. Every supplied status states the
   head it describes.
4. The check runs and commit statuses are read by SHA, every page, for the commit
   the gate evaluates (the test merge commit when it carries a check, otherwise the
   head), so the status describes that commit whatever the pull request head does
   during the read, and never passes a state the gate refuses. The gate reads
   every page of the commit statuses too, so the two reads see the same entries. A head that moves from A to B and back to A cannot put the checks of
   B in the status (issue #349). This replaces the head re-read around `gh pr
   checks`, which reports no commit and could not separate that case.
5. Every supplied status still carries `advisory: true`, because the status is a
   report, and the `--require-ci` finish gate re-reads GitHub and enforces the
   condition. The commit binding is exact, but the status is a snapshot taken
   before the turn, so a check that starts or finishes later is not in it. The
   reviewer treats the status as evidence. A status never replaces the gate.
6. The status comes from the per-context judgment the gate uses. A failing
   required check makes the status `failing`. A failure among entries that share a
   required name, for example a check run and a commit status, or an earlier run
   beside a pending one, wins over pending. Otherwise a pending check or commit
   status, or a required check with no run or status on the commit, makes it
   `pending`. Otherwise it is `pass`.
   The read is stricter than the gate where it can be, and each of these is
   `unresolved`: a ruleset read that settles nothing, an empty set of required
   contexts, a failed read of the required names (any exit other than 0, or 1 or 8
   with a non-empty list, or the exact `no required checks reported` answer), a
   reviewed work tree that is not clean, a merge state the gate refuses (BLOCKED,
   BEHIND, DIRTY, UNKNOWN, or a value the gate does not know) when every required
   check passed, a check-run or commit-status
   reply that is not the paginated shape, an entry the judgment cannot read or
   order (an empty name or context, or an id or a timestamp that is missing or not
   a date), a classic
   protection reply whose shape cannot be interpreted, and a ruleset or protection
   source that answers success with a body that is not JSON. A malformed reply
   never reads as a pass. The gate keeps its lenient reads of an entry, so the
   read can report unresolved where the gate passes, and never the reverse.
7. `checks` names the required contexts the status covers, with the app id for an
   app-qualified context.
8. The read is bounded in time, and the bound terminates the child, so a `gh`
   that hangs cannot stall the dispatch or outlive it. A read that exceeds the
   bound is `unresolved` and never fails or halts the dispatch, because the
   status is supplied evidence and the reviewer keeps its own read.
9. The supplied status is added to the reviewer prompt as two lines inside the
   existing required-check group, so it applies only under the pull request
   condition and never narrows the guard rules above it. The first line names the
   PR and the status. The second states that the reviewer keeps its own read as
   the fallback, is preferred when the supplied status is unresolved, and any
   difference between the two goes in `Checks`. `docs/orchestrator-instructions.md`
   and the headless orchestrator prompt state the rule in the same words, and a
   test reads both to keep them from drifting.
10. The reviewer's own read is never removed. The supplied status is evidence for
    one turn, not a gate: it is a pre-turn snapshot, so a check that starts or
    finishes later is not in it.
11. The read never fails a turn. A `gh` failure, an unreadable head, a mismatched
    head, an unreadable ruleset source, an empty set of required checks,
    and a stalled call are all `unresolved`, which the prompt rule already sends back
    to the reviewer's own read.
12. The status is reported with the reviewer result in three places, so a parent
    can compare it with the reviewer `Checks` line on either path: as `prChecks`
    in the dispatch envelope, beside the response in the state file's
    `lastResult`, and in the headless result prompt the orchestrator receives
    after a reviewer turn, rendered beside the response and the reviewed state.
    A result with no read carries no `prChecks` field, so a turn that made no
    read cannot be read as one that did. The `turns` entry keeps the fixed shape
    ADR 0008 defines, so the status is not recorded there.
13. The prompt wording a run does not need stays unchanged. A run that declares
    no PR gets the `origin/main` lines verbatim, including the gate line that
    calls the gate the only check read, because that run makes no supplied read
    and the qualification would describe one. Only a declared run's lines are
    reworded, so the rewording cannot reach a run this decision does not touch.
14. `--require-ci` stays the enforcement point. The supplied status changes no
    gate condition and no refusal.

## Consequences

- A reviewer whose CLI cannot reach the network sees the failing check on the PR
  head, so the run no longer needs a worker turn and a reviewer turn to learn it.
- A status is never supplied for a head the reviewer is not looking at, so a
  mismatch is unresolved rather than a pass on the wrong commit. The checks
  are read by commit SHA, so a head that moves, even away and back, cannot name
  one head for checks that belong to another (issue #349).
- Every status keeps `advisory: true`, because it is a report and the
  `--require-ci` gate re-reads GitHub and enforces the condition. The status is a
  pre-turn snapshot of the head commit.
- The parent can compare two independent reads of the same status, so a
  disagreement between the runtime and the reviewer is visible.
- Every reviewer turn in a declared-PR run costs more `gh` calls than the former
  three: the pull request, the repository, the ruleset and protection sources,
  the required names, and the check runs and statuses of the commit. All are
  status reads that change nothing.
- A stalled `gh` cannot hold a dispatch open, because the read is bounded and the
  bound terminates the child.
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
5. **Reuse `checkCi` for the supplied status**: it needs a reviewed state and
   applies gate conditions, so it would report a refusal where the prompt needs
   a status. Rejected; the read is a separate, evidence-only function that shares
   the `gh` runner.
6. **Read the check list and infer the head from it**: `gh pr checks --json`
   reports no commit, so the head needs its own read. Rejected; the head read is
   what makes a mismatch detectable at all.
7. **Ask `gh pr checks` for a commit SHA**: it takes a pull request, a URL, or a
   branch, and reports `no pull requests found for branch "<sha>"` for a commit,
   so the check results cannot be bound to the reviewed commit in one call.
   Measured live against this repository. Rejected; the check runs are read by
   SHA through `gh api` instead.
8. **Re-read the head around `gh pr checks`**: the first design of issue #320. It
   detects a head that moved once, and it cannot detect a head that moved away and
   back. Superseded by item 4 of the decision (issue #349).
9. **Rebuild the required-name source for the read**: the read would drift from
   the gate. Rejected; the read calls the gate's `requiredContexts` and
   `evaluateContext`.

## Authors

Andro Marces

## Links

- [Issue #320: Put the runtime-read required-check status into each reviewer prompt when the run has a PR input](https://github.com/andromarces/agent-loops/issues/320)
- [Issue #313: Show required-check status to the reviewer before it accepts a PR head](https://github.com/andromarces/agent-loops/issues/313)
- [Issue #302: Require a PR input on every run so an omitted unresolvedCompare marker cannot read as verified](https://github.com/andromarces/agent-loops/issues/302)
- Implementation: `readRequiredChecks` in `src/lib/ci-gate.mjs`, `runtimeReadLines` in `src/prompts/reviewer.mjs`, the read and the `prChecks` result field in `runChild` in `src/runtime.mjs`, the dispatch wiring and the `prChecks` envelope field in `src/role.mjs`; tests in `tests/lib/ci-gate.test.mjs`, `tests/prompts/reviewer.test.mjs`, `tests/runtime.test.mjs`, and `tests/role.dispatch.test.mjs`; documented in `docs/orchestrator-instructions.md` and `README.md`
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- Superseded by [ADR 0024: Supply the required-check status to the reviewer for every run that names a PR](0024-supply-the-required-check-status-for-a-named-pr.md)
- [ADR Index](README.md)
