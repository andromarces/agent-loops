# 0012. Establish an absent required check from a source that states it

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

An earlier draft of this ADR treated three replies as naming the absence: a
source that was read, the exact Free-plan 403, and `Branch not protected` (404) on
the classic endpoint. Read-only probes rejected that. Two of those three replies
leave a source empty without proving anything about the branch, and a gate that
reads them as an absence passes a pull request whose required checks it never
saw:

- `Not Found` (404) is what a token without repository admin receives, and it
  cannot tell an unprotected branch from a protected one it may not read. Both
  `Resource not accessible` 403s refuse before the branch is read at all.
- The Free-plan 403 names the plan, not the branch, and it is written the same
  way for a branch that exists and one that does not, so it says nothing about
  whether a required check exists. It is also the reply the private Free-plan
  repository that motivated the issue gives, so treating it as an absence is
  precisely the case that has to be right.

A read-only probe measured all three on `sindresorhus/slugify`, a repository with
no required check: repository rulesets read `[]`, classic protection answered
`Not Found` (404), and `gh pr checks --required` printed nothing at all and exited
non-zero. Every configuration source therefore left the gate empty, and none of
them stated that the branch has no required check. A fourth reply behaves the same
way: `gh pr checks --required` lists only the checks that already reported, so on
a branch with no required check its silence is the same silence as a read
failure, and no read of it can prove an absence.

`Branch not protected` (404) is the one unreadable reply that does state the
outcome. The classic endpoint writes it only to a caller that can read protection,
and it names an unprotected branch (#280, #295). A read that completes and names
no required check states the outcome for its own source, so a completed read is
the other.

## Decision

1. Each required-check configuration source, repository rulesets and classic
   branch protection, is classified by what its reply proved:
   - Absent: a read that completed and named no required check. For repository
     rulesets, a read with no applicable `required_status_checks` rule. For
     classic protection, a read with no `required_status_checks`, or the
     `Branch not protected` (404) the endpoint writes only to a caller that can
     read it.
   - Contexts: the reply named at least one required check, so the per-check pass
     runs.
   - Unknown: every other reply. That is `Not Found` (404), both
     `Resource not accessible` 403s, the Free-plan 403, any read error, and any
     body that is empty or is not the shape that endpoint returns. A reply that is
     neither an unreadable shape nor a parseable body still throws, which fails
     the run rather than reaching the gate.
2. `gh pr checks --required` is never classified. It lists only the checks that
   already reported, so it can name a required check and it cannot prove one is
   absent, and a failed read of it neither establishes nor hides a context. It
   contributes names and nothing else, as it did before.
3. An empty union of required checks refuses when any configuration source is
   unknown. The refusal is the origin/main empty-union refusal and its reason
   names each unknown source, because a parent can only fix a source it can see.
   The gate cannot tell an empty branch from a protected one this caller may not
   read.
4. An empty union over sources that each stated they hold no required check is an
   established absence. The gate then applies the same conditions it applies
   elsewhere, the merge state included, so a blocked merge state still refuses
   with a reason that names the unmet rule and not a required check. On a pass it
   reports `noRequiredChecks: true` beside the commit, so a caller can tell a
   finish that verified no check from one that verified a check.
5. The record travels the path the finish takes. A headless run emits a
   `no-required-checks` event carrying the gated `pr` and the `stepsUsed`, and
   the interactive path records `noRequiredChecks` in the finish envelope and
   beside `summary` in the state file. A finish on a base branch that does
   require a check carries no such record, so the field means the branch had none
   rather than that the gate ran.
6. The absence is recorded on an accepted finish only. The headless gate runs
   before the runtime collects the other finish conditions, so a run whose finish
   is refused by another condition has not finished and verified nothing. A
   `no-required-checks` event is therefore emitted inside the accepted-finish
   branch, after every refusal has been found absent.
7. The prompt and the interactive instructions state the outcome and its
   condition: a base branch with no required check has no check to wait for, so
   the gate passes on the PR head, the clean reviewed tree, and the merge state,
   and the run records the absence, when every required-check source stated that
   it holds none, while a source this credential cannot read leaves the gate
   refusing. The rule states what the gate checks and predicts no outcome beyond
   that.
8. Nothing else about the declaration changes. A run that declares a PR still
   needs the gate for that same PR, still refuses `unresolvedCompare`, and
   `review-only` still refuses `--pr` at init.

## Consequences

- A declared run on a base branch whose required-check sources each stated that
  they hold none ends through `finish` and never keeps the #286 gap, because the
  runtime resolves the PR head and verifies the clean tree and the merge state.
  The gate is the one place the finish is judged, so the run needs no second
  enforcement path.
- A finish that verified no check is machine-distinct from one whose checks
  passed. The `no-required-checks` event, the `noRequiredChecks` field, and the
  absence of both on a checked branch and on a refused finish are what a
  consumer reads.
- A branch with no required check can still carry another required rule, such as
  a required review, so the merge state still refuses. The relaxation covers the
  check set only.
- A caller that cannot read a required-check configuration source still refuses an
  empty union, and the reason names the source. This is stricter than an earlier
  draft of this ADR, which read the Free-plan 403 as an absence: a private
  Free-plan repository, which cannot have a required check at all, therefore keeps
  the empty-union refusal and a declared run there still cannot finish. That is
  the cost of not reading a reply about the plan as a statement about the branch.
  The relaxed path remains reachable for a caller that can read both sources and
  that reads neither a required check from them, which is the common case on a
  public repository.
- A refused finish records no absence, in either path, so the `noRequiredChecks`
  field and the `no-required-checks` event mean an accepted finish on a branch
  that stated it requires no check.
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
   silence says nothing about what the branch requires, and it is the same silence
   as a read failure.
4. **Read the Free-plan 403 as an absence because the plan disallows the rule**:
   rejected; the reply names the plan and not the branch, and it is written the
   same way for a branch that exists and one that does not, so it is a statement
   about the repository's plan rather than about its required checks. An earlier
   draft of this ADR accepted it and the read-only probe on `sindresorhus/slugify`
   is what showed the reasoning does not hold.
5. **Keep refusing, and record the reason so a parent can act on it**: the
   refusal is unchanged for an unknown source, so a parent already learns the
   condition from it. Adding a pass for the sources that stated the outcome is
   the whole change; the change here also names the source in the reason, because
   a parent can only fix a source it can name.
6. **Read the absence from the merge state alone**: rejected; the merge state
   reports blocked for an unmet required review as well as an unmet check, so it
   cannot tell a branch with no required check from a branch whose check has not
   reported.

## Authors

Andro Marces

## Links

- [Issue #336: Decide how a declared PR run finishes on a base branch with no required checks](https://github.com/andromarces/agent-loops/issues/336)
- Implementation: `readRequiredSource`, `rulesetContexts`, `protectionContexts`,
  `requiredContexts`, and the empty-union branch of `checkCi` in
  `src/lib/ci-gate.mjs`, `ciGate` and the accepted-finish branch in
  `src/runtime.mjs`, the `noRequiredChecks` record in `src/role.mjs`, the gate
  line in `src/prompts/orchestrator.mjs`; tests in
  `tests/lib/ci-gate.test.mjs`, `tests/runtime.test.mjs`,
  `tests/role.finish-abort.test.mjs`, and `tests/prompts/orchestrator.test.mjs`;
  documented in `docs/orchestrator-instructions.md` and `README.md`
- Read-only probe behind the classification, 2026-09-29, on
  `sindresorhus/slugify` (a repository with no required check): repository rulesets
  read `[]`, classic branch protection answered `Not Found` (HTTP 404), and
  `gh pr checks --required` printed nothing and exited non-zero. No source stated
  that the branch requires no check, so the empty union over that read is a
  refusal, not an absence.
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
  stays `accepted`: its decision stands, and the ceiling this ADR lifts was a
  Consequence that ADR 0009 deferred to #295 and #301.
- [Issue #301: A private Free-plan repository cannot have a required check](https://github.com/andromarces/agent-loops/issues/301)
- [Issue #295: A fine-grained PAT without Administration cannot read classic protection](https://github.com/andromarces/agent-loops/issues/295)
- [Issue #286: An omitted unresolvedCompare marker reads as a verified finish](https://github.com/andromarces/agent-loops/issues/286)
- [ADR Index](README.md)
