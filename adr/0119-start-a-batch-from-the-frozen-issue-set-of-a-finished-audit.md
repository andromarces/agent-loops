# 0119. Start a batch from the frozen issue set of a finished audit

## Status

partially-superseded

## Superseded by

[adr/0121-mix-issue-pull-request-and-task-items-in-one-batch.md](0121-mix-issue-pull-request-and-task-items-in-one-batch.md) partially supersedes this ADR. The replaced part is decision 1's rule that `--from-audit` and `--issue` are the only two item sources; a third source, `--items-file`, is added. Every other decision stays in force.

## Supersedes

This ADR partially supersedes
[ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md):

- Decision 2's rule that `--issue <n>`, repeated at least once, is the only issue source. A
  batch now also accepts `--from-audit <id>` as its issue list.
- Decision 3's sentence that the runtime selects no issue and that the issue numbers come
  only from the skill. An explicit audit id makes the runtime read the frozen set of that
  audit; it still reads no label, milestone, project, or natural-language request.

Every other decision, consequence, and acceptance check of ADR 0106, as later amended, stays
in force.

This ADR partially supersedes
[ADR 0109: Coordinate reviewer audits and consolidated issue creation](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md):

- Decision 13's deferred entry "Automatic selection of the issues that an audit creates for a
  following batch, or automatic chaining of an audit into a batch start". The explicit
  selection is now defined. Automatic chaining stays deferred.

Every other decision of ADR 0109 stays in force. In particular, the frozen set of decision 8
remains the audit's record, and the audit command still starts no batch.

## Date

2026-11-09

## Context

ADR 0109 decision 8 freezes the issue set of a finished audit in
`<runs root>/batches/audits/<audit id>.json`. The runtime writes the `issues` array once, and
a later `resume`, `approve`, or `status` changes no entry and creates no issue.

A following batch still needs the numbers typed by hand. The owner reads them from
`batch audit status` and passes each one with `--issue`. Nothing checks that the named audit
finished, that its last issue write was reconciled, or that the audit belongs to the target
repository.

The batch already validates an explicit set, refreshes eligibility before each launch, and
freezes the set in its manifest
([ADR 0106](0106-foreground-batch-scheduling.md)). The missing decision is the source of the
set, not a new scheduler.

## Decision

### 1. `--from-audit <id>` supplies the issue list

`agent-loop batch start` accepts `--from-audit <audit id>` as an alternative to `--issue`.
Exactly one source is required. `--from-audit` with `--issue` is a usage error, as is a
command with neither. The runtime reads the audit store and uses the stored frozen set. It
still reads no label, milestone, project, or request, and it prompts for nothing.

### 2. Only a finished audit with reconciled writes qualifies

Before any claim, work tree, checkpoint, or child exists, `start` refuses with exit 2 when:

- the audit id is unknown, or its record is unreadable or malformed;
- the audit status is not `created`, which is the finished state. `running`, `paused`,
  `needs-owner`, and `interrupted` are refused and the refusal names the stored status;
- `pendingCreate` names an issue write that was not reconciled;
- a `created` entry is not in the frozen set, because the record then describes an issue
  write that the frozen set does not hold;
- the audit belongs to another repository than `--repo`;
- the frozen set is empty, holds a malformed entry, or names a duplicate issue number.

A refusal writes no batch store, claim, work tree, or child. The audit's stored status is the
only completion signal. The age of the file and the presence of an `issues` array are not
completion evidence.

### 3. The frozen set is used exactly and in stored order

The selected numbers are the `issues` array in stored order. The runtime sorts nothing, adds
nothing, drops nothing, and repeats nothing, and it refuses a duplicate instead of
deduplicating. That order is stable: ADR 0109's upsert keeps the first position of an issue,
and no later `resume`, `approve`, or `status` reorders or changes an entry.

A later audit write changes no running batch. The manifest holds the chosen set, and
`batch resume` reads the manifest, as ADR 0106 decision 3 requires.

### 4. Eligibility and every other batch rule stay

The refresh of ADR 0106 decision 6, as amended by ADR 0110 and ADR 0114, still runs before
each launch. A closed, blocked, claimed, closed-by-open-pr, not-specified, or unverified issue
of the frozen set is skipped, waits, or pauses with the same reason as any explicitly selected
issue. The loop count, claims, checkpoints, slots, GitHub reconciliation, failure isolation,
and cleanup are unchanged.

### 5. No automatic chaining

An audit never starts a batch. After a `created` audit, the owner runs one deliberate
`batch start --from-audit <id>` command. ADR 0109's deferred "automatic chaining" stays
deferred: the audit command starts no batch and the batch command starts no audit.

### 6. Documentation

The implementation adds:

- The `--from-audit` flag, the refusal rules, and the stored order to the `Batch runs` section
  of `docs/reference/usage.md`.
- A sentence to the batch paragraph of `docs/reference/architecture.md` that the runtime reads
  the frozen set of a created audit when the flag names one.
- A rule in `docs/orchestrator-instructions.md`: the skill passes `--from-audit` when the
  request names the issues of a finished audit, and still passes explicit `--issue` numbers
  for any other selection.
- The `--from-audit` flag and its refusal to the `agent-loop batch start` lines of
  `src/help.mjs`.

README and onboarding expansion stay out of scope.

### 7. Acceptance checks

1. A `created` audit whose frozen set is `[12, 4]` yields a batch set of exactly `[12, 4]`
   and launches in that order.
2. A paused, `needs-owner`, interrupted, running, unknown, or unreadable audit each exit 2
   before any `batches/<batch id>` directory, claim, work tree, or child exists.
3. An audit with `pendingCreate` set, or a `created` entry missing from `issues`, exits 2.
4. An audit of another repository exits 2.
5. An empty, malformed, or duplicate frozen set exits 2.
6. `--from-audit` with `--issue`, and a command with neither, exit 2.
7. A closed, blocked, or claimed issue of the frozen set gets the same skip or wait result as
   an explicitly selected issue.
8. `batch audit status` shows the frozen set, and reading the audit changes no store mtime.
9. The store read is path-only and runs on Windows, macOS, and Linux. A target that a check
   cannot run is recorded in the matching shared verification checklist (#707, #708, or #709),
   never in a new issue.

## Consequences

- The owner copies no issue number. A finished audit's set reaches a batch in one command.
- A paused or `needs-owner` audit never yields a partial set. The owner resumes or approves
  the audit first, so a batch starts only from issues that the audit's gate admitted.
- An audit that created and linked no issue cannot start a batch. The owner selects issues
  explicitly with `--issue` instead.
- A changed audit set after `start` does not change the batch. A new batch reads the new set.
- The manifest's issue list is the selection record. The batch summary does not name the
  audit id, and no audit value is written to GitHub.
- The refusal happens before the batch store exists, so a refused `--from-audit` leaves no
  checkpoint to clean up.

## Alternatives

1. **Automatic chaining: the audit starts the batch.** Rejected. A failed or partial audit
   must not launch, an owner approval is a deliberate choice, and ADR 0109 keeps chaining
   deferred. One explicit command keeps the boundary.
2. **Read `batch audit status` and type the numbers.** Rejected. It is the manual step of
   issue #1734, and a typo selects an unrelated issue.
3. **Read the audit store again at every resume.** Rejected. ADR 0106 decision 3 freezes the
   selected set in the manifest. A re-read could change a running batch.
4. **Accept the partial set of a paused or `needs-owner` audit.** Rejected. Those states mean
   an audit failed or the checkout changed, so the set is not frozen by the audit gate.
5. **Sort the frozen set by issue number.** Rejected. The stored order is the consolidation
   order and is already stable; a sort would hide the audit's decision.
6. **Read the `created` array instead of `issues`.** Rejected. `issues` is the frozen set and
   also holds linked existing issues that the run did not create.
7. **Add a GitHub label or issue comment with the batch id.** Rejected for the reason ADR 0106
   rejects a remote claim: the repository plan forbids new labels, and the local manifest is
   the record.

## Owner decisions

1. **Explicit flag, no automatic chaining.** The owner runs `batch start --from-audit`.
2. **Only a `created` audit.** No partial set from a paused or `needs-owner` audit.
3. **Stored order.** The frozen set is used as stored, with no sort and no dedupe.

## Authors

Andro Marces

## Links

- [Issue #1734: Start a batch from the frozen issue set of a finished audit](https://github.com/andromarces/agent-loops/issues/1734)
- [PR #1746: Start a batch from the frozen issue set of a finished audit](https://github.com/andromarces/agent-loops/pull/1746)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md) (decisions 2 and 3 superseded)
- [ADR 0109: Coordinate reviewer audits and consolidated issue creation](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md) (decision 13's first deferred entry superseded)
- [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md)
- [ADR 0114: Report an exit 4 batch loop as needs-owner](0114-report-an-exit-4-loop-as-needs-owner.md)
- [Issue #707: Verification checklist: Linux](https://github.com/andromarces/agent-loops/issues/707)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [Issue #709: Verification checklist: Windows](https://github.com/andromarces/agent-loops/issues/709)
- [Implementation: audit store and frozen set](../src/batch/audit.mjs)
- [Implementation: audit store](../src/batch/audit-store.mjs)
- [Implementation: batch command](../src/batch/cli.mjs)
- [Tests: audit coordination](../tests/batch/audit.test.mjs)
- [ADR Index](README.md)
