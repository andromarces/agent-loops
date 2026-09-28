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
   before each reviewer turn and supplies it in the reviewer prompt. The read is
   two `gh` calls in the run's work tree, through the same injected `gh` runner
   the `--require-ci` gate uses: `gh pr view <pr> --json headRefOid` to resolve
   the head, then `gh pr checks <pr> --required --json name,bucket` to list the
   required checks.
2. The read is keyed on `--pr`, which is the PR input both paths know at
   dispatch. A run that declares no PR reads nothing. A headless run that takes
   only `--require-ci` and declares no `--pr` reads nothing, because the gate
   flag is not the declared PR input.
3. A status is reported only for the head it describes. The read compares the
   resolved PR head with the local reviewed head, which the runtime already has
   from the pre-turn snapshot. A read whose PR head differs, and a read with no
   local head to compare, are `unresolved`, so the prompt never supplies a pass
   for a head the reviewer is not looking at. Every supplied status states the
   head it describes.
4. The head and the checks are two separate calls, and the pull request can
   advance between them, so the head is read again after the checks. `gh pr
checks` reports no commit and accepts no commit argument, so a re-read is the
   only way to detect a head that moved: a head that moved is `unresolved`. This
   makes three calls per reviewer turn. A single call cannot, because the command
   exposes no field that names the commit the checks belong to.
5. Every supplied status carries `advisory: true`, and one window survives that
   re-read. A head that advances to another commit and returns between the two
   head reads leaves both reads naming the same commit while the checks describe
   the other one, and no re-read separates that case. This is an accepted gap,
   stated here, in `docs/orchestrator-instructions.md`, and in the reviewer
   prompt: the status is a report, the reviewer treats it as evidence, and the
   `--require-ci` finish gate re-reads GitHub and enforces the condition. A
   status never replaces the gate.
6. The status comes from the exit code the reviewer rules and
   `docs/orchestrator-instructions.md` already name: 0 is a pass, 8 is a pending
   check, and 1 is a failing check, a pull request with no required check, or a
   read error. Exit 1 reports failing only when the reply lists a failing
   required check, the same evidence the reviewer rule requires before it calls a
   blocker. Every other exit code is `unresolved`.
7. The reply is parsed strictly. Every listed entry must be an object with a
   non-empty string `name` and a known string `bucket`, and any malformed entry
   rejects the whole reply as `unresolved`. A lenient parse that drops malformed
   entries reports a pass whenever a pass entry sits beside a malformed one, so
   it fails open on the one input that must not pass.
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
    one turn, not a gate: `gh pr checks` lists only the checks that already
    reported, so a supplied pass covers the listed checks only.
11. The read never fails a turn. A `gh` failure, an unreadable head, a mismatched
    head, a moved head, a malformed reply, an unexpected exit code, and a
    stalled call are all `unresolved`, which the prompt rule already sends back
    to the reviewer's own read.
12. The status is reported with the reviewer result: as `prChecks` in the
    dispatch envelope and beside the response in the state file's `lastResult`,
    so a parent can compare it with the reviewer `Checks` line. The `turns`
    entry keeps the fixed shape ADR 0008 defines, so the status is not recorded
    there.
13. `--require-ci` stays the enforcement point. The supplied status changes no
    gate condition and no refusal.

## Consequences

- A reviewer whose CLI cannot reach the network sees the failing check on the PR
  head, so the run no longer needs a worker turn and a reviewer turn to learn it.
- A status is never supplied for a head the reviewer is not looking at, so a
  mismatch is unresolved rather than a pass on the wrong commit. A head that
  moves between the two reads is unresolved too, so a race cannot name one head
  for checks that belong to another.
- One window survives: a head that advances away and back within the read. Every
  status carries `advisory: true` for it, and the ceiling is one reviewer turn
  whose `Checks` line reports a pass for a commit other than the reviewed head.
  The `--require-ci` gate re-reads GitHub, so the run still cannot finish on a
  false pass.
- The parent can compare two independent reads of the same status, so a
  disagreement between the runtime and the reviewer is visible.
- Every reviewer turn in a declared-PR run costs three `gh` calls, the head, the
  check list, and the head again. All are status reads that change nothing, and
  the reviewer prompt already asks the reviewer to make the second.
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
   Measured live against this repository. Rejected; the head is re-read after the
   checks instead.
8. **Trust the first head read and let the reviewer's own read catch a race**:
   the prompt already keeps the reviewer's read as the fallback, so a race
   resolves to the reviewer reading the checks itself. Rejected for the supplied
   status: the reviewer's read is the fallback for an unresolved status, and a
   status that misnames its own head is worse than no status, so the race is
   refused in the runtime where it happens.
9. **Read the check runs for the exact commit through
   `gh api repos/{owner}/{repo}/commits/{sha}/check-runs`**: the endpoint takes a
   commit, so it closes every window, including the one a re-read cannot. It
   reports every check run on that commit rather than the required ones, so the
   required-name source would have to be rebuilt from repository rulesets and
   classic protection, which is `checkCi`'s own resolution. Rejected; duplicating
   the gate's resolution here would drift from the one read that enforces, and
   the window it closes is a misreported `Checks` line on one reviewer turn in a
   run whose finish the gate still refuses or passes on the real condition.

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
