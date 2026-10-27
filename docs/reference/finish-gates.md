# Finish gates

Part of [Child dispatch](role.md). The gate conditions, their refusal order, and the `noRequiredChecks` pass are in [Finish gates](../orchestrator/finish-gates.md) of the orchestrator guide. This page states the absence rule of the `--require-ci` gate, which the user docs and the orchestrator guide must state the same way. The reply shapes and their classes are in [ADR 0012](../../adr/0012-establish-the-absence-of-a-required-check.md).

The rule for the pass on a branch with no required check is one allowlist, and it fails closed. Each required-check configuration source is classified by what its reply proved. The classes are absent, has-contexts, empty, and unknown.

- Absent, the only class that lets a finish pass, has exactly one reply per source. For repository rulesets it is a read of every page that returns a non-empty array whose entries all carry a documented rule type and none is a `required_status_checks` rule, and the read is paginated, so a rule on a later page is enforced rather than missed. For classic branch protection it is exactly `gh: Branch not protected (HTTP 404)`. No successful classic-protection body proves an absence, because a classic-protected branch can require reviews without requiring a check.
- Has-contexts is a reply that named at least one required check, so the per-check pass runs and enforces it.
- Empty is exactly one empty page, a successful read that found no rule, which is not a positive absence. Exactly one empty page contributes no contexts, so the per-check pass runs on the other sources and a classic-only repository whose required checks passed still finishes.
- Unknown is every other reply, including a read of no page at all, a ruleset entry whose type is not a documented rule type, an unparseable body, and every unreadable reply. An empty page inside a longer read states nothing.

A ruleset read the gate cannot interpret has the class unknown, and it refuses the finish whatever the rest of the union holds, before the per-check pass. The anomalous page sequences are a read of no page at all, two or more empty pages, and an empty page beside a page that holds rules.

A ruleset-only branch reaches the absence path, because both sources state the outcome. A branch with no ruleset at all does not, because its read is one empty page, and a classic-protected branch that requires reviews but names no check does not either.

A private GitHub Free-plan repository still refuses a declared `--pr` run, because the plan allows no rule read and the reply is classified unknown. Such a repository must omit `--pr` (issues #336 and #286, refused up front by #1092).
