# 0012. Establish an absent required check from an allowlisted source reply

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
non-zero. The ruleset reply recorded there is a read of no page at all, so it is
`unknown` and refuses, while a read of exactly one empty page is `empty` and does
not. Either way every configuration source left the gate empty, and none of
them stated that the branch has no required check. A fourth reply behaves the same
way: `gh pr checks --required` lists only the checks that already reported, so on
a branch with no required check its silence is the same silence as a read
failure, and no read of it can prove an absence.

A second round of probes rejected a wider reading still. A reply that is one step
from the recognized shape is not a statement about the branch either: a ruleset
body that is JSON but not an array, an array carrying an entry that is not a
well-formed rule, an entry with no `type` field, a `required_status_checks` rule
that names no check, a body that is empty or is not JSON, and a classic-protection
body that is readable but carries no `required_status_checks` all reached
`noRequiredChecks: true`. A readable classic-protection body that names no check
cannot be an absence, because a classic-protected branch can require reviews
without requiring a check, so the body does not say the branch is unprotected.
The same probes found the absence path passing a missing merge state, which the
per-check path never allows.

The rule that survives is an allowlist. A source counts as a positive absence only
for one exact reply per source, and every other reply settles nothing. The cost is
stated in Consequences: the private Free-plan repository, which motivated the
issue, is not among the branches the declaration reaches.

`Branch not protected` (404) is the one unreadable reply that states the outcome.
The classic endpoint writes it only to a caller that can read protection, and it
names an unprotected branch (#280, #295). A ruleset read that is a non-empty array
of well-formed rules carrying no required-status-check rule is the other.

Two more replies were accepted as an absence and are not. An empty ruleset array
is the same reply for a branch no ruleset applies to and for a caller or endpoint
that enumerates no rule for that branch, and the reply carries nothing that tells
those apart. And `Branch not protected` was matched as an unanchored search, so
the same text inside another error, or beside a second line, read as an absence;
it is now compared as a whole reply.

Two shapes were examined and left as they are. An earlier draft of this ADR gave
the wrong reason for the first, and the correction is recorded here.

- A ruleset whose `enforcement` is `disabled` or `evaluate`. GitHub's
  [branch-rules documentation](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
  states that the endpoint returns active rules only, and that rules in rulesets with
  `evaluate` or `disabled` enforcement are not returned. An earlier draft of this ADR
  claimed the reply carried no enforcement field, so such a rule would be read as a
  required context and over-refuse. That was wrong: the rule never appears in the
  reply, so there is nothing to misread and no over-refusal follows. The corrected
  reason does not change any classification, so the code is unchanged. One
  consequence is worth keeping: a rule that is not enforced cannot require a check,
  so its absence from the reply is correct evidence rather than a gap.
- A rule that applies to the branch by a name pattern or by `~DEFAULT_BRANCH`. The
  documentation states the same for branch conditions: every active rule that applies
  to the branch is returned regardless of the level it is configured at, so the
  reply is already the list GitHub filtered for that branch, and a rule that reaches
  it applies.

## Reply shapes and their class

One list, so a review can check the code against it. The class column carries the
outcome the code returns, written in the same lower-case words the code constants
hold: `absent` is `ABSENT`, `has-contexts` is `HAS_CONTEXTS`, `empty` is `EMPTY`,
and `unknown` is `UNKNOWN`. The two configuration sources are the only ones that
carry a class. `gh pr checks --required` is never classified: it contributes names
and no outcome, so no reply of it names a class.

Two ruleset replies are both an empty result and only one of them is `empty`. A read
of exactly one empty page is a successful read that found no rule, so it is `empty`:
it contributes no contexts and does not refuse. A read of no page at all is a read
that returned nothing, which is the same reply for a branch no ruleset applies to and
for a caller or endpoint that enumerates no rule, so it is `unknown` and refuses. A
second empty page is the same anomalous read, because GitHub stops paginating when
there is no next page, so `empty` covers the one page that states an outcome and
nothing else.

| Source                    | Class            | Reply shape and the effect on each path                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository rulesets       | absent           | Every page holds rules, every entry carries a documented rule type, and no entry is a `required_status_checks` rule. Normal path: contributes no contexts, the per-check pass runs on the other sources. Relaxed path: the positive absence                                                                                                                               |
| Repository rulesets       | has-contexts     | Some page holds a `required_status_checks` rule whose check list is a non-empty array whose entries all name a non-empty string `context`. Normal path: the per-check pass enforces those names. Relaxed path: not reached, the union is non-empty                                                                                                                        |
| Repository rulesets       | empty            | Exactly one page, and that page is empty: a successful read that found no rule. Normal path: contributes no contexts, the per-check pass runs on the other sources, so a classic-only repository finishes. Relaxed path: not a positive absence, the empty-union refusal names it                                                                                         |
| Repository rulesets       | unknown          | No page at all. Normal path: refuses. Relaxed path: refuses                                                                                                                                                                                                                                                                                                               |
| Repository rulesets       | unknown          | Two or more empty pages, or an empty page beside a page that holds rules, because GitHub stops paginating when there is no next page. Normal path: refuses. Relaxed path: refuses                                                                                                                                                                                         |
| Repository rulesets       | unknown          | An entry that is not an object, is null, is an array, has no `type`, has a `type` that is not a string, or has a `type` outside the documented rule types. Normal path: refuses. Relaxed path: refuses                                                                                                                                                                    |
| Repository rulesets       | unknown          | A `required_status_checks` rule whose check list is missing, is not an array, is empty, or holds an entry with no string `context`. Normal path: refuses. Relaxed path: refuses                                                                                                                                                                                           |
| Repository rulesets       | unknown          | A body that is empty, is not JSON, is JSON that is not the array of pages `--slurp` returns, or that holds a page which is not an array. Normal path: refuses. Relaxed path: refuses                                                                                                                                                                                      |
| Repository rulesets       | unknown          | Any non-zero exit, except an unrecognized shape, which throws. Normal path: refuses. Relaxed path: refuses                                                                                                                                                                                                                                                                |
| Classic branch protection | absent           | Exactly `gh: Branch not protected (HTTP 404)`, allowing one trailing LF or CRLF. Normal path: contributes no contexts, the per-check pass runs on the other sources. Relaxed path: the positive absence                                                                                                                                                                   |
| Classic branch protection | has-contexts     | A JSON object whose `required_status_checks` is an object that names at least one context in `contexts` or in `checks`, and every entry names one. Normal path: the per-check pass enforces those names. Relaxed path: not reached, the union is non-empty                                                                                                                |
| Classic branch protection | unknown          | A body that is empty, is not JSON, is JSON that is not an object, has no `required_status_checks`, has it as null or of the wrong type, or names no check, because a classic-protected branch can require reviews without requiring a check. Normal path: keeps the origin/main behavior, so the other sources still gate. Relaxed path: the empty-union refusal names it |
| Classic branch protection | unknown          | `Not Found` (404), either `Resource not accessible` 403, the Free-plan 403, and `Branch not protected` carrying any surrounding or extra text. Normal path: keeps the origin/main behavior, so the other sources still gate. Relaxed path: the empty-union refusal names it                                                                                               |
| Classic branch protection | unknown          | Any other non-zero exit, except an unrecognized shape, which throws. Normal path: keeps the origin/main behavior, so the other sources still gate. Relaxed path: the empty-union refusal names it                                                                                                                                                                         |
| `gh pr checks --required` | never classified | A JSON array of named checks, whatever the exit status. Normal path: the per-check pass enforces those names. Relaxed path: not reached, the union is non-empty                                                                                                                                                                                                           |
| `gh pr checks --required` | never classified | An empty array and output that is not a JSON array, which contribute no names, and a failed read. Normal path: contributes no contexts and decides no outcome. Relaxed path: never establishes an absence                                                                                                                                                                 |

## Decision

1. Each required-check configuration source, repository rulesets and classic
   branch protection, is classified by what its reply proved. The classification
   is an allowlist, so it fails closed, and `ABSENT`, the only answer that lets a
   finish pass, has exactly one reply per source:
   - Repository rulesets: a read of every page whose entries all carry a rule type
     GitHub documents, and none is a `required_status_checks` rule. The endpoint
     paginates at 30 rules per page, so the read follows every page, and a body the
     gate cannot account for every page of is unknown, or a required-status rule on
     a later page would be missed and a branch that requires a check would pass. An
     empty result is excluded, because a read of exactly one empty page is the same
     reply for a branch no ruleset applies to and for a caller or endpoint that
     enumerates no rule for that branch, so it contributes no contexts but is not a
     positive absence, and so is a read of no page at all, and so is a
     second empty page, because that sequence is not the complete result it claims
     to be. Those three are not one outcome, and the reply-shape table above gives
     each its class. A read of exactly one empty page is `empty`, which contributes
     no contexts and does not refuse, so the per-check pass runs on the other
     sources. A read of no page at all, two or more empty pages, and an empty page
     beside a page that holds rules are each `unknown`, and an unknown ruleset read
     refuses before the per-check pass, whatever the rest of the union holds. A rule
     type outside the documented list is excluded, because a type the list does not
     carry may be a required-status rule under a name the gate has not seen; the list
     is the documented one, so a future GitHub rule type makes such a read unknown,
     which refuses.
   - Classic branch protection: exactly `gh: Branch not protected` (404), which
     the endpoint writes only to a caller that can read protection, compared as a
     whole reply so no surrounding text can pass as it. No successful body proves
     an absence for this source, because a classic-protected branch can require
     reviews without requiring a check, so a readable body that names no check is
     unknown.
   - `HAS_CONTEXTS` is a reply that named at least one required check, so the
     per-check pass runs.
   - `UNKNOWN` is every other reply. That is any non-zero exit other than the
     exact `Branch not protected` 404, including `Not Found` (404), both
     `Resource not accessible` 403s, and the Free-plan 403; a body that is empty,
     is not JSON, is JSON that is not the array or object that endpoint returns,
     or is an array carrying an entry that is not a well-formed rule, including an
     entry with no `type` field or a `type` that is not a string; and a
     `required_status_checks` rule that names no check, which states neither an
     absence nor a context the gate could enforce. A non-zero reply that is not an
     unreadable shape still throws, which fails the run rather than reaching the
     gate (#280).
2. `gh pr checks --required` is never classified. It lists only the checks that
   already reported, so it can name a required check and it cannot prove one is
   absent, and a failed read of it neither establishes nor hides a context. It
   contributes names and nothing else, as it did before.
3. An empty union of required checks refuses when the classic-protection source is
   unknown. The refusal is the origin/main empty-union refusal and its reason names
   each unknown source, because a parent can only fix a source it can see. The gate
   cannot tell an empty branch from a protected one this caller may not read.
4. A required-check configuration source reply is classified as `ABSENT`,
   `HAS_CONTEXTS`, `EMPTY`, or `UNKNOWN`, and the reply-shape table above gives each
   shape its class and its effect on both paths. The ruleset source carries all
   four:
   - `ABSENT` is a non-empty read whose entries are all documented rule types and
     none is a `required_status_checks` rule. On the normal path it contributes no
     contexts and the per-check pass runs on the other sources. On the relaxed path
     it is the positive absence.
   - `HAS_CONTEXTS` is a read that names at least one required-status rule. The
     per-check pass enforces it, and the relaxed path is not reached.
   - `EMPTY` is exactly one page, and that page is empty: a successful read that
     found no rule. On the normal path it contributes no contexts and the
     per-check pass runs on the other sources, which is what origin/main did, so a
     classic-only repository whose required checks passed still finishes. It is not
     a positive absence, so the relaxed path keeps the empty-union refusal and
     names it, and the limit for a branch with no ruleset stays. A read of no page
     at all is not this outcome: the same reply answers a branch no ruleset applies
     to and an endpoint that enumerated no rule, so that read is `UNKNOWN`, which
     refuses on both paths.
   - `UNKNOWN` refuses the finish whatever the rest of the union holds, before the
     per-check pass, with a reason that names the source. It is a failed or
     partial page, a body that is empty, not JSON, not the array of pages, or holds
     a page that is not an array, an anomalous page sequence, which is no page at
     all, two or more empty pages, or an empty page beside a page that holds rules,
     and an unlisted or malformed rule type. Such a reply may carry a
     required-status rule this caller never saw, so a non-empty union from another
     source must not let the per-check pass judge only the names it saw. GitHub
     stops paginating when there is no next page, so the single empty page is the
     one empty shape that states an outcome.

   The classic-protection source carries `ABSENT`, `HAS_CONTEXTS`, and `UNKNOWN`
   only. An unknown classic-protection read keeps its origin/main behavior, so the
   per-check pass still runs on the other sources and the empty-union refusal names
   it on the relaxed path.

   Relative to origin/main, which treated every unreadable ruleset reply as an empty
   source and refused only on an unrecognized message, the change adds refusals in
   one case only: a ruleset read the gate cannot interpret, on a branch whose other
   sources named at least one required check. A classic-only repository is
   unchanged, because its ruleset read is a single empty page and not unknown.

5. An empty union over sources that each stated they hold no required check is an
   established absence. The gate then applies the same conditions it applies
   elsewhere, the merge state included, so a blocked merge state still refuses
   with a reason that names the unmet rule and not a required check. On a pass it
   reports `noRequiredChecks: true` beside the commit, so a caller can tell a
   finish that verified no check from one that verified a check.
6. The merge state is validated before either path, against the states GitHub's
   GraphQL `mergeStateStatus` reports, so the absence path applies exactly the same
   merge-state condition as the per-check path. A missing, null, empty, or
   unrecognized state refuses on both, because a state the gate cannot read is not
   a clean one. `UNKNOWN` is outside that set, because GitHub computes it lazily
   and it states no outcome either (#336 review).
7. The record travels the path the finish takes. A headless run emits a
   `no-required-checks` event carrying the gated `pr` and the `stepsUsed`, and
   the interactive path records `noRequiredChecks` in the finish envelope and
   beside `summary` in the state file. A finish on a base branch that does
   require a check carries no such record, so the field means the branch had none
   rather than that the gate ran.
8. The absence is recorded on an accepted finish only. The headless gate runs
   before the runtime collects the other finish conditions, so a run whose finish
   is refused by another condition has not finished and verified nothing. A
   `no-required-checks` event is therefore emitted inside the accepted-finish
   branch, after every refusal has been found absent.
9. The prompt, the interactive instructions, the README, and the CLI help state
   the outcome and its condition in one form: a base branch that states it has no
   required check has no check to wait for, so the gate passes on the PR head, the
   clean reviewed tree, and the merge state, and the run records the absence, when
   every required-check source stated that it holds none, while a source this
   credential cannot read, or one that returns a shape the gate cannot read, leaves
   the gate refusing. The rule states what the gate checks and predicts no outcome
   beyond that.
10. Nothing else about the declaration changes. A run that declares a PR still
    needs the gate for that same PR, still refuses `unresolvedCompare`, and
    `review-only` still refuses `--pr` at init.

## Consequences

- **A private GitHub Free-plan repository still refuses a declared `--pr` run
  under this change, so this ADR does not resolve #336 for it, and such a
  repository must omit `--pr`, which leaves the #286 gap in place.** Its
  Free-plan 403 is unknown on every required-check endpoint, because the reply
  names the plan rather than the branch and is written the same way for a branch
  that exists and one that does not, so no source there states an absence. This is
  the repository the issue was raised for, and the allowlist is why the
  declaration does not reach it.
- A branch reaches the absence path where both configuration sources state the
  outcome. A branch whose rulesets carry rules but no required-status-check rule,
  and whose classic protection answers exactly `Branch not protected`, is one such
  branch, and a ruleset-only branch is the common case: its ruleset read is a
  non-empty array of well-formed rules with no required-status-check rule, and it
  has no classic protection to report. A branch with no ruleset at all does not
  reach it, because its read is one empty page or no page, and `EMPTY` is not a
  positive absence while `UNKNOWN` refuses, and neither
  does a classic-protected branch that requires reviews but names no check.
- A declared run on such a base branch ends through `finish` and never keeps the
  #286 gap, because the runtime resolves the PR head and verifies the clean tree
  and the merge state. The gate is the one place the finish is judged, so the run
  needs no second enforcement path.
- A finish that verified no check is machine-distinct from one whose checks
  passed. The `no-required-checks` event, the `noRequiredChecks` field, and the
  absence of both on a checked branch and on a refused finish are what a
  consumer reads.
- A branch with no required check can still carry another required rule, such as
  a required review, so the merge state still refuses. The relaxation covers the
  check set only.
- A caller that cannot read a required-check configuration source still refuses an
  empty union, and the reason names the source. This is stricter than the earlier
  drafts of this ADR, which read a read-but-empty source and the Free-plan 403 as
  an absence. The allowlist is the cost: a reply one step from the recognized
  shape settles nothing, so a malformed or unfamiliar read refuses rather than
  passes.
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
- **Whether a refused finish reads GitHub is two separate facts, and the paths
  differ on the first one only.** The interactive `role finish` throws as soon as
  any condition above the gate refused, so a refused `finish` never reaches the
  gate. The headless loop evaluates every gate it owns, as origin/main did, so it
  calls the gate whenever the run carries `--require-ci` and the declared-PR
  condition did not refuse, and a finish the marker, the `review-only` condition,
  or `--require-accept` already refused still calls it. The second fact is the
  gate's own order and it is the same on both paths: `checkCi` evaluates its two
  local conditions before it reads anything, and refuses with no GitHub call when
  the latest reviewer turn has no reviewed state and when the reviewed work tree
  is not clean. Every other condition it checks needs a read to settle it, the PR
  head comparison included, because it reads the PR first. So a headless refused
  finish reads GitHub or does not depending on which gate condition it reached,
  not on the earlier conditions in its own list.

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
- Implementation: `readRequiredSource`, `classifyRulesets`, `classifyProtection`,
  `ghRequiredNames`, `requiredContexts`, and the empty-union branch of `checkCi` in
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
  refusal, not an absence. The ruleset reply recorded there is a read of no page at
  all, so it is `unknown`; a read of exactly one empty page is `empty` and refuses
  neither path.
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
  stays `accepted`: its decision stands, and the ceiling this ADR lifts was a
  Consequence that ADR 0009 deferred to #295 and #301.
- [Issue #301: A private Free-plan repository cannot have a required check](https://github.com/andromarces/agent-loops/issues/301)
- [Issue #295: A fine-grained PAT without Administration cannot read classic protection](https://github.com/andromarces/agent-loops/issues/295)
- [Issue #286: An omitted unresolvedCompare marker reads as a verified finish](https://github.com/andromarces/agent-loops/issues/286)
- [ADR Index](README.md)
