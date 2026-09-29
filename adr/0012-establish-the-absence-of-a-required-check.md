# 0012. Establish the absence of a required check instead of refusing it

## Status

accepted

## Date

2026-09-29

## Context

ADR 0009 made `--pr <pr>` the run's PR input, so a run that states its PR can
only end through the `--require-ci <pr>` gate for that same PR. Its Consequences
recorded the ceiling that made that unusable on some repositories: `checkCi`
refuses an empty union of required checks, and a private GitHub Free-plan
repository cannot have a required check at all, because the plan does not allow
the rule that would require one (#301). A declared run there could never finish
and ended only through `abort`, so the only available choice was to omit `--pr`,
which kept the #286 gap the declaration was meant to close.

The issue named two ways out. Refusing `--pr` at init when the base branch has no
required check keeps the gap open for exactly the repositories that have no way
to add one, and it needs a GitHub read on the init call, which is a snapshot
that a later branch-protection change invalidates. The second option, letting the
declared run finish through a gate that verifies the PR-head compare, the clean
tree, and the merge state, closes the gap and keeps the gate the single place
where the finish is judged.

The obstacle is that an empty union carries two meanings. It can mean the base
branch has no required check, or it can mean a configuration source this caller
could not read, which may hold a required check the caller never saw. The empty
union refused both, so it could not become a pass without also reading an
unreadable source as an absence.

Three replies to a required-check configuration source already separate the two
cases, and the code documented them without acting on the difference. The
Free-plan 403 states that the plan does not allow the rule that would require a
check, so no required context can exist (#301). `Branch not protected` (404) is
written by the classic endpoint only to a caller that can read it, so it names
the absence on a branch with no classic protection, where `Not Found` (404) is
the same status for a caller that cannot (#280, #295). Every other unreadable
reply leaves the source unknown.

## Decision

1. A required-check configuration source reports whether the caller can tell
   what it holds, beside the contexts it yields. A source that was read is
   known. A source whose reply names the absence is known: the exact Free-plan
   403, and `Branch not protected` on the classic protection endpoint. Every
   other unreadable reply leaves the source unknown.
2. `gh pr checks --required` never decides the absence. It lists only the checks
   that already reported, so it can name a required check and it cannot prove one
   is absent, and a failed read of it neither establishes nor hides a context. It
   contributes names and nothing else, as it did before.
3. An empty union of required checks refuses when any configuration source is
   unknown, with the reason it already gave. The unreadable-source refusal
   therefore keeps its meaning: the gate cannot tell an empty branch from a
   protected one this caller may not read.
4. An empty union over known sources is an established absence. The gate then
   applies the same conditions it applies elsewhere, the merge state included, so
   a blocked merge state still refuses with a reason that names the unmet rule
   and not a required check. On a pass it reports `noRequiredChecks: true` beside
   the commit, so a caller can tell a finish that verified no check from one that
   verified a check.
5. The record travels the path the finish takes. A headless run emits a
   `no-required-checks` event carrying the gated `pr` and the `stepsUsed`, and
   the interactive path records `noRequiredChecks` in the finish envelope and
   beside `summary` in the state file. A finish on a base branch that does
   require a check carries no such record, so the field means the branch had none
   rather than that the gate ran.
6. The prompt and the interactive instructions state the outcome: a base branch
   with no required check has no check to wait for, so the gate passes on the PR
   head, the clean reviewed tree, and the merge state, and the run records the
   absence. The rule states what the gate checks and predicts no outcome beyond
   that.
7. Nothing else about the declaration changes. A run that declares a PR still
   needs the gate for that same PR, still refuses `unresolvedCompare`, and
   `review-only` still refuses `--pr` at init.

## Consequences

- A declared run on a private Free-plan repository, or on any base branch with
  no required check, ends through `finish` and never keeps the #286 gap, because
  the runtime resolves the PR head and verifies the clean tree and the merge
  state. The gate is the one place the finish is judged, so the run needs no
  second enforcement path.
- A finish that verified no check is machine-distinct from one whose checks
  passed. The `no-required-checks` event, the `noRequiredChecks` field, and the
  absence of both on a checked branch are what a consumer reads.
- A branch with no required check can still carry another required rule, such as
  a required review, so the merge state still refuses. The relaxation covers the
  check set only.
- A caller that cannot read a required-check configuration source still refuses an
  empty union. A non-admin token against a classic-protected branch is unchanged,
  and the Free-plan 403 is the one unreadable reply that now establishes an
  absence, because the plan does not allow the rule that would require a check.
- A branch whose protection changes between the finish and a later read is
  judged at each finish. The gate reads the branch on every finish, so a
  repository that adds a required check stops passing the absence path on the
  next finish.
- A base branch that has no required check yields no check runs to read, so the
  absence path skips the check-run and commit-status reads the per-check pass
  needs. The gate makes fewer GitHub calls on that path.

## Alternatives

1. **Refuse `--pr` at init when the base branch has no required check**: the
   option the issue names first. Rejected; it closes nothing for the repository
   that motivated the issue, because such a repository cannot add a required
   check, and it moves the read to init, where the answer is a snapshot that a
   later protection change invalidates while the finish remains the place the gate
   is judged.
2. **Let the empty union pass on any credential**: rejected; an unreadable source
   may hold a required check this caller never saw, so the gate would pass a
   pull request whose required checks it never read. That is the fail-closed
   property the empty-union refusal was written for (#280, #295).
3. **Infer the absence from `gh pr checks --required` reporting nothing**:
   rejected; that command lists only the checks that already reported, so its
   silence says nothing about what the branch requires.
4. **Keep refusing, and record the reason so a parent can act on it**: the
   refusal is unchanged for an unknown source, so a parent already learns the
   condition from it. Adding a pass for the known case is the whole change.
5. **Read the absence from the merge state alone**: rejected; the merge state
   reports blocked for an unmet required review as well as an unmet check, so it
   cannot tell a branch with no required check from a branch whose check has not
   reported.

## Authors

Andro Marces

## Links

- [Issue #336: Decide how a declared PR run finishes on a base branch with no required checks](https://github.com/andromarces/agent-loops/issues/336)
- Implementation: `readRequiredSource` and the empty-union branch of `checkCi` in
  `src/lib/ci-gate.mjs`, `ciGate` in `src/runtime.mjs`, the `noRequiredChecks`
  record in `src/role.mjs`, the gate line in `src/prompts/orchestrator.mjs`;
  tests in `tests/lib/ci-gate.test.mjs`, `tests/runtime.test.mjs`,
  `tests/role.finish-abort.test.mjs`, and `tests/prompts/orchestrator.test.mjs`;
  documented in `docs/orchestrator-instructions.md` and `README.md`
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
  stays `accepted`: its decision stands, and the ceiling this ADR lifts was a
  Consequence that ADR 0009 deferred to #295 and #301.
- [Issue #301: A private Free-plan repository cannot have a required check](https://github.com/andromarces/agent-loops/issues/301)
- [Issue #295: A fine-grained PAT without Administration cannot read classic protection](https://github.com/andromarces/agent-loops/issues/295)
- [Issue #286: An omitted unresolvedCompare marker reads as a verified finish](https://github.com/andromarces/agent-loops/issues/286)
- [ADR Index](README.md)
