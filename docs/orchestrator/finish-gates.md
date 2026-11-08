# Finish gates

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a `finish` is refused, and before you end a run with `--require-accept` or `--require-ci`.

A marked `role finish` still exits `0`. Read the marker in the envelope or the
state file.

Two opt-in gates apply to `work-first` and `review-first` only. The interactive `role
finish` names every condition above the `--require-ci` gate, and a later `finish`
can report a `--require-ci` condition that the first refusal did not name. The
conditions are checked in this order: the marker condition, then the `review-only` reviewer-turn condition, then
`--require-accept`, then the declared-PR gate condition, then `--require-ci`. The
`role finish` command checks the same conditions in the same order, except the
`review-only` condition, which it cannot reach, and except `--require-ci`, which it
checks only after every other condition passes. A refusal from `role finish` never lists a
`--require-ci` condition beside another condition.

The interactive `role finish` command throws as soon as any condition above the
gate refused, so on that path a refused `finish` never reaches the gate and never
reads GitHub.

The gate checks its own local conditions first, and only then reads GitHub. Those
local conditions are exactly two.

The gate refuses with no GitHub call when the latest reviewer turn has no reviewed
state. That case includes a worker turn after the last review. The gate also
refuses when the reviewed work tree is not clean. Every other condition it checks needs a read to settle it, the PR head comparison
included. In `review-only`, each flag fails with a clear error.

- `--require-accept`: refuse unless the latest turn is a reviewer accept with a
  `Checks` line, the reviewed snapshot is exact, and the current snapshot is
  exact with the same `head` and `digest`. The `head` and `digest` comparison
  detects a change to an uncommitted state at the same commit. A worker turn
  after the last review resets the accept, so the refusal names that turn order
  and the reviewer accept on the current state that must come before `finish`.
- `--require-ci <pr>`: refuse unless the PR head equals the reviewed `head`, the
  reviewed tree is clean, the PR is not behind its base under a strict rule, has no
  merge conflicts, the merge state is one the gate can read and is not blocked, and
  every required check passed on the commit GitHub evaluates. GitHub evaluates the
  test merge commit when that commit has a check run or a commit status, and the
  head commit otherwise. A required check run passes with the conclusion
  `success`, `skipped`, or `neutral`; a required commit status passes with the
  state `success`. When a check run and a commit status share a required name,
  both must pass, and a pending or missing check fails. Required contexts come
  from repository rulesets, classic branch protection, and
  `gh pr checks --required`. A context qualified by
  an app (a ruleset `integration_id` or a classic-protection `app_id`) is
  satisfied only by a check run from that app, and an unqualified copy of that
  name is dropped.
  - A base branch whose
    required-check sources each state that it holds no required check has no check to
    wait for: the gate then passes on the PR head, the clean reviewed tree, and the
    merge state, and records that no required check exists, in `noRequiredChecks` in the
    envelope and the state file here. The record appears on an accepted finish only, so
    a refused finish never reports an absence.
  - The rule for that pass is one allowlist, and it fails closed. Each required-check
    configuration source is classified by what its reply proved. A ruleset read the gate
    cannot interpret has the class unknown, and it refuses the finish whatever the rest of
    the union
    holds, before the per-check pass; that is a failed or partial page, a ruleset read that the runtime cannot account for page by page (no 2xx status block, a body that is not one JSON value, or more than 100 pages; a `Link` target on another host is an error, not an unknown source), an anomalous page sequence, which is no page at all, two or more empty pages,
    or an empty page beside a page that holds rules, and an unlisted or malformed rule type.
    A ruleset read of exactly one empty page is neither of those: its class is empty, a
    successful read that found no rule, so it contributes no contexts
    and the per-check pass runs on the other sources, so a
    classic-only repository whose required checks passed still finishes.
    Otherwise a finish passes on the absence only when no source named a required
    check and no source is unknown, so both sources must have stated the outcome, and
    an unknown classic-protection source keeps the empty-union refusal with the reason
    naming it. The classes are absent,
    has-contexts, empty, and unknown, and each one applies on both the normal and the
    relaxed path.
  - Absent, the only class that lets a finish pass, has exactly one reply per source.
    For repository rulesets it is a read of every page that returns a non-empty array
    whose entries all carry a documented rule type and none is a
    `required_status_checks` rule, which is the read of a branch that has no
    required-status-check rule; the read is paginated by page number, 100 rules per page, and never
    follows a reply-supplied `Link` URL, so a rule on a later page is enforced rather than
    missed, and a read the runtime cannot account for every page of is unknown. For classic branch protection it is exactly
    `gh: Branch not protected (HTTP 404)`, one trailing line break aside, which the
    endpoint writes only to a caller that can read protection. No successful
    classic-protection body proves an absence, so a readable body that names no check
    is unknown. Has-contexts is a reply that named at least one required check, so the
    per-check pass runs and enforces it. Empty is exactly one empty page: a successful
    read that found no rule, which contributes no contexts and is not a positive absence,
    so the empty-union refusal names it on the relaxed path.
  - Unknown is every other reply, including a ruleset read of no page at all,
    a ruleset entry whose type is missing or is not a documented
    rule type, a malformed or unparseable body, an empty page inside a longer read,
    and every unreadable reply.
  - A branch reaches the absence path where both sources state the outcome, so a
    ruleset-only branch does, while a branch with no ruleset at all does not, because
    its read is one empty page, and empty is not absent, and an empty page inside a
    longer read states nothing, and neither does a
    classic-protected branch that
    requires reviews but names no check. GitHub documents that the ruleset read
    returns active rules only, so a rule in a ruleset whose enforcement is `disabled`
    or `evaluate` never appears in it and never affects the classification.
  - `gh pr checks --required` is never classified and never establishes the absence. It
    lists only the checks that already reported, so it can name a required check and
    it cannot prove one is absent, and on a base branch with no required check it
    prints nothing, which is the same silence as a read failure. The gate takes
    required names from its stdout whatever the exit status, so a non-zero exit whose
    stdout holds that JSON still contributes names, and only a stdout that is not a
    JSON array of named checks contributes none. It is an independent source.
  - A rate-limit or SSO 403 fails the run by design. The exception to ruleset readability is
    a private repository on the GitHub Free plan, where the plan does not allow the
    rule at all.
  - A Free-plan 403 leaves each endpoint with no required contexts, and it is
    classified unknown rather than empty, so the empty-union refusal names it. A private GitHub
    Free-plan repository still refuses a declared run, so such a repository must omit
    `--pr`, which leaves the #286 gap in place. Init with `--pr` and `role declare-pr` refuse that case up front, so the parent does not learn of it at
    `finish`.
  - Repository rulesets are readable with read access on a repository whose plan allows
    the rule, so a token without repository admin still gates through repository rulesets
    and through `gh pr checks --required` while the classic-protection source stays
    unknown. A required check that never started cannot escape the gate: the per-check
    pass refuses it when a source names it, and the blocked-merge-state refusal covers
    it when no source names it. A blocked merge state refuses after the per-check
    pass, so a refusal for a named check keeps its name, and each refusal names the
    failed condition. The gate cannot tell a missing check from an unmet
    review or another required rule, so a repository with required approvals also
    refuses until they are met, and a branch that states it has no required check still
    refuses while its merge state is blocked. This gate needs the `gh` CLI.
