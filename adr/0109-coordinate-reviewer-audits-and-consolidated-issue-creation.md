# 0109. Coordinate reviewer audits and consolidated issue creation

## Status

partially-superseded

## Superseded by

[adr/0118-remove-a-finished-audit-work-tree-and-store.md](0118-remove-a-finished-audit-work-tree-and-store.md)
partially supersedes this ADR. These parts are replaced:

- Owner decision 2, "Keep the audit work tree. No cleanup rule is added in milestone 2."
- The decision 3 sentence "The work tree is kept for inspection; this milestone adds no removal
  rule."
- The decision 10 sentence "The runtime never retries a failed reviewer or a failed
  consolidation, never resumes an issue creation whose read is uncertain, and never deletes an
  audit or its work tree."
- The decision 13 entry "Removal of the audit work tree or its store."
- The consequence sentence "The audit work tree stays on disk for inspection, so each run costs
  one checkout until the owner removes it."

Every other decision, consequence, and acceptance check stays in force.

## Supersedes

This ADR partially supersedes [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md):

- Decision 16's entry that reviewer audit coordination and consolidated issue creation are deferred to milestone 2. The capability is now defined.
- The Context sentence that lists reviewer audit coordination as out of scope for milestone 1. Milestone 1 stays standalone, and its acceptance checks still pass without this ADR.

Decisions 1 to 15 of ADR 0106 stay in force. In particular, the foreground command, the explicit settings, the store outside every work tree, the write-on-change rule, the failure isolation, and the claim and work-tree rules are unchanged. This ADR reuses the frozen-set rule of decision 3 for the issue set that an audit creates; it does not change the batch selection of milestone 1.

## Date

2026-11-09

## Context

A batch runs selected issues to completion (ADR 0106). Before a batch can select issues, an owner sometimes needs a review of one project revision that produces issues. Several reviewers should audit that revision, and their findings should become issues without duplicates. No command coordinates that today.

The pieces exist. A reviewer turn is read-only and runs under a mutation check ([ADR 0019](0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md), [ADR 0038](0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)). A worker turn is the writable role. `gh issue list` and `gh issue create` are ordinary remote operations. The batch already owns a foreground supervisor, a checkpoint under the runs root, atomic writes, and a cancellation path ([ADR 0033](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md), [ADR 0049](0049-pin-the-machine-wide-roots-for-every-child-turn.md)).

The missing decision is the audit protocol: one revision, independent reviewers, a gate that waits for every requested audit, one consolidation turned into issues, duplicate detection against open and closed issues, a paused state for a failed audit or an owner approval of partial results, and a frozen issue set.

## Decision

### 1. One foreground `agent-loop batch audit` command owns an audit run

The command family is:

- `agent-loop batch audit start ...` starts an audit run and prints its id.
- `agent-loop batch audit status [--audit <id>]` reads one audit or lists the local audits, newest first, and writes nothing.
- `agent-loop batch audit resume --audit <id>` retries the reviewers and the consolidation that failed, then continues creation.
- `agent-loop batch audit approve --audit <id>` records the owner's approval of the partial results of a failed audit, then consolidates and creates from the audits that succeeded.

`start`, `resume`, and `approve` print progress on stderr and one JSON summary on stdout. There is no daemon, no detached supervisor, and no process that outlives the command on a normal exit. The exit code is 0 when the issue set is created, 1 when the run pauses at a failed audit or consolidation, stops as `needs-owner` at a changed checkout, or meets an uncertain remote write, 2 for a refused setting or a refusal before any state write, and 130 when SIGINT ends the run.

### 2. The skill resolves the request; the runtime validates it

The entry-point skill passes every value as a flag and shows the resolved settings before it starts. `agent-loop batch audit start` requires:

- `--repo <dir>`, the main work tree of the target repository. A linked work tree is refused, and the refusal names the main work tree.
- `--reviewer <cli>`, repeated at least twice. The order is the audit order. A duplicate kind is allowed when the models differ, because the requested audits are distinct when their settings differ.
- `--worker <cli>`, the consolidation worker.

It accepts `--reviewer-model` and `--reviewer-effort` after each `--reviewer`, which set the model and effort of the most recent reviewer; a model or effort before the first reviewer is a usage error. It accepts `--worker-model`, `--worker-effort`, `--base`, `--work-tree-root`, `--timeout`, `--reviewer-sandbox`, and `--reviewer-workspace-write`. `--base` defaults to the remote default branch and is refused when `origin/<base>` does not exist. The remaining values keep the headless defaults, and every supplied value is validated by the same parser the headless command uses.

`--reviewer-sandbox` is accepted only when every requested reviewer is `codex`, because the Codex adapter is the only one that applies a mode. A duplicate or conflicting sandbox flag, an unsupported agent, model, or effort, a duplicate conflicting value, a repeated `--worker`, `--worker-model`, or `--worker-effort` with a different value, a runs root or work-tree root inside any Git work tree, and a missing required flag are refused with exit 2 before a store, work tree, or child exists.

No turn and no child supplies a setting. The runtime reads no request, selects no revision, and prompts for nothing.

### 3. One audit work tree at one frozen revision

At `start` the runtime resolves `refs/remotes/origin/<base>` to one commit SHA and records it. It creates one linked work tree at that SHA with a detached checkout:

```bash
git worktree add --detach "<work tree>" "<sha>"
```

The default work-tree root is `<repo parent>/<repo name>-audit-<audit id>`, and the audit work tree is `<root>/revision`. The root is created when missing and refused when it lies inside any Git work tree or is not a directory the audit can write. The run records the path, its canonical path, its device and inode, and the revision SHA.

Every reviewer reads that one work tree at that one SHA, whatever `origin/<base>` does later. The audit never writes a branch, a commit, or a tag. The work tree is kept for inspection; this milestone adds no removal rule.

The run may run a supplied `--setup-cmd` once in the work tree before the first reviewer, within `--setup-timeout`, as a batch setup command does. The setup command must leave the checkout clean: a tracked or unignored change stops the run as `needs-owner` with reason `work-tree-changed`, starts no reviewer, and deletes nothing. A failed setup pauses the run with reason `setup-failed`.

### 4. Every requested reviewer audits independently

Each requested reviewer runs one read-only turn in its own session, in the requested order, with the same revision, work tree, and audit task. A later reviewer never receives an earlier reviewer's session or findings. The turn runs under the reviewer mutation check, so a tracked or unignored file change, a Git state change, or a cancel fails that audit rather than becoming an issue.

The reviewer turn is the existing reviewer turn. Its prompt is built by the reviewer prompt builder, so an audit reviewer receives the test-slot rule, the secret-file restriction, the process restriction, the required-check rule, and the sandbox note of ADR 0038 and ADR 0044. The audit instructions are the task under those rules. A Codex reviewer runs with sandbox mode `none` unless the operator passes `--reviewer-sandbox`, so a read-only mode is a choice and not an accidental default.

The runtime binds every saved result to the audited revision. After each reviewer turn it reads the work tree HEAD and `git status --porcelain`. A HEAD other than the recorded revision, or a non-empty status, fails that audit and stops the run as `needs-owner` with reason `work-tree-changed`. The runtime restores nothing: it never reverts a change, and it never deletes or overwrites an owner edit or an untracked file (ADR 0019). No later reviewer runs on the changed checkout. A fatal turn error, such as a post-turn snapshot failure, stops the run before another reviewer launches. A resume reads the same evidence before it reuses a saved result; saved findings that do not name the current revision, or that were saved over a changed checkout, are discarded. The owner restores the checkout and runs `batch audit resume` again.

The audit task asks for a fenced JSON document with this shape:

```json
{ "findings": [{ "title": "...", "body": "...", "evidence": "..." }] }
```

A turn succeeds when it returns and the runtime parses at least one valid findings document, including a document with an empty array. A turn that fails to run, returns no string, or returns no valid findings document is a failed audit. The runtime records the reviewer kind, model, effort, status, error text, and parsed findings; it never treats a timeout, an error, or malformed output as an empty audit.

The runtime runs the requested turns one at a time. Concurrency is not required for independence, and a sequential pass keeps one shared work tree free of two simultaneous test runs. The machine-wide test slot is untouched: the audit itself runs no full suite, and a reviewer that runs a targeted test follows the reviewer rule of [ADR 0044](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md).

### 5. No consolidation before every requested audit succeeds

The consolidation step runs only when every requested reviewer ended `succeeded`. A failed reviewer pauses the run with status `paused` and a reason that names the reviewer, and creates no issue. The successful audits stay recorded for inspection.

`batch audit resume` retries only the reviewers that did not succeed. It does not rerun a successful reviewer, so the successful audits stay the same. If the retry succeeds, the run continues to consolidation.

`batch audit approve` records the owner's approval of the partial results. It then consolidates only the audits that succeeded and records the failed reviewers and the approval in the summary. An approval is bound to the exact failed reviewer set and the audited revision. A changed failed set, a changed revision, or a checkout drift discards the approval, and a new owner approval is required before any creation. An approval never applies to a failed consolidation: a consolidation with no valid result can only be retried. An approval also never revives a saved result that is not bound to the frozen revision: the runtime discards it and pauses rather than feed it to creation. The runtime never prompts for an approval and never treats silence as one.

### 6. One consolidation worker merges findings and checks the issue set

After every requested audit succeeds, or after the owner approves the partial results, one consolidation worker runs one turn. It receives:

- Every successful reviewer's findings, with the reviewer kind and any model or effort.
- The open and closed issues of the repository, read once before the turn: `gh issue list --state all --limit 1000 --json number,title,state,url`.
- The audit id and revision, so provenance is available.

The worker merges findings that describe the same defect, drops a finding that is not a defect against the revision, and returns a fenced JSON document with this shape:

```json
{ "findings": [{ "title": "...", "body": "...", "evidence": "...", "existingIssue": 12 }] }
```

`existingIssue` is the number of an open or closed issue that already covers the finding, or null when no issue covers it. The worker does not create, edit, comment on, or label an issue. The runtime owns every remote write.

A `gh issue list` that fails, returns an unreadable value, or returns exactly 1000 entries is an incomplete read, which pauses the run with reason `issue-read-incomplete` or `issue-read-failed`. The list is stored once and reused, so a retry does not change the dedupe set. The accepted limit is that an issue created by another process after that read is not seen. The runtime's own uncertain write is reconciled by the stable identity that decision 7 records before the write.

### 7. The runtime validates the consolidation and creates the issues once

The runtime parses the consolidation document and refuses it unless every entry holds a non-empty title and body, every `existingIssue` is an integer in the stored issue list, and no two entries share a title, compared case-insensitively. A malformed document or an unknown issue number pauses the run with reason `consolidation-invalid`, and creates no issue. `batch audit resume` runs the consolidation again from the stored successful audits.

For each valid entry the runtime applies these rules in order:

1. **A named existing issue.** The finding links that issue. No issue is created.
2. **An exact title match.** A stored open or closed issue whose title equals the finding title, compared case-insensitively and after trimming, covers the finding. The runtime links that issue and creates no duplicate. This check holds even when the worker named no existing issue.
3. **A new finding.** The runtime creates one issue with `gh issue create --title <title> --body <body>`.

The created body carries the finding body and evidence, the audit id, a stable `Audit-Finding` identity, and the revision SHA. The runtime writes no label, no comment, and no issue edit. A creation that fails pauses the run with reason `issue-create-failed`; the issues already created stay recorded. Before a retry creates anything, it records the stable identity before the write, then reads the issue list with bodies and adopts an issue whose body carries that identity. The identity does not depend on the current finding title, so a reworded re-audit links the same issue instead of creating a duplicate. An adopted issue is recorded once and joins the issue set that the consolidation worker checks.

### 8. The selected issue set is frozen for the run

After creation the run writes one frozen set. Each entry names the consolidated finding, the issue number, the issue URL, whether the issue existed before the run, and the reviewer kinds whose findings fed it. The run status becomes `created`.

A later `resume`, `approve`, or `status` changes no entry of that set and creates no issue. A retry cannot add a reviewer, a finding, or an issue, and it cannot remove one. The audit id and the frozen set are the record that the run produced.

### 9. The audit store is local and written only on a change

The audit store is `<runs root>/batches/audits/<audit id>.json`, where the runs root is the batch runs root of ADR 0106. The file holds the settings, the revision, the work tree identity, every reviewer result, the consolidation result, the stored issue list, each created issue, and the frozen set. It is written atomically, through a temporary file in the same directory and a rename, and only when a stored value changes. There is no heartbeat and no periodic write. `batch audit status` writes nothing, and a resume with nothing to do writes nothing.

One audit lock serializes two commands on the same audit id. A command that cannot take the lock reports `paused` and writes nothing. The store is outside every repository, so it never changes a reviewed snapshot. The store is unsigned and has the trust of a batch checkpoint (ADR 0106, decision 8): every value is validated before use, and a malformed record is a refusal, not a guess.

### 10. Failure isolation, interruption, and retry

A failed reviewer, a failed setup, a failed consolidation, or a failed issue read pauses only that audit run. A changed or drifted checkout stops it as `needs-owner` and leaves every file as found. It creates no issue until a retry succeeds or the owner approves the audits that succeeded. A failed issue creation keeps every issue created before it and names the failure.

The first SIGINT aborts the audit turn, records the audit as `interrupted`, and exits 130. A turn that a signal cancels is not a success. The next `resume` reruns every reviewer that is not `succeeded`, because a read-only reviewer turn is idempotent, and it reuses the stored issue list and the stored successful audits.

The runtime never retries a failed reviewer or a failed consolidation automatically, never resumes an issue creation whose read is uncertain, and never deletes an audit or its work tree. The owner decides when to retry, approve, or remove a kept work tree.

The reliability rule of the milestone 1 implementation issue applies. A reliability failure is fixed in this milestone only when it blocks the milestone, and any other correctness defect gets its own issue.

### 11. Documentation for milestone 2

The implementation adds:

- A `Reviewer audits` subsection to the `Batch runs` section of `docs/reference/usage.md`: the command surface and settings, the frozen revision, the independent audits, the gate, the consolidation, the dedupe rules, the frozen set, the store, the statuses, and the exit codes.
- A paragraph to `docs/reference/architecture.md` that names the audit supervisor, the read-only reviewer turns, the consolidation turn, and the runtime-owned creation.
- A rule in `docs/orchestrator-instructions.md`: the skill resolves an audit request into explicit flags and runs `agent-loop batch audit start`; the runtime prompts for nothing and reads no issue selection.
- The `agent-loop batch audit` lines in `help.mjs`, with the refusals and exit codes.

README and onboarding expansion stay out of scope.

### 12. Standalone acceptance checks for milestone 2

The implementation passes these checks without milestone 3:

1. **Settings.** Fewer than two reviewers, a missing worker, an unsupported agent, model, or effort, an orphan reviewer model, a duplicate conflicting sandbox flag, and a work-tree root inside a Git work tree each exit 2 before any store, work tree, or child exists.
2. **One revision.** Two or more reviewers read the same recorded SHA in one work tree, and a later move of `origin/<base>` changes neither the SHA nor the work tree.
3. **Independent audits.** Each reviewer runs in its own session, and a later reviewer receives no earlier reviewer's findings.
4. **The gate.** Two reviewers run and no consolidation and no issue creation starts until both succeed. One failed reviewer leaves the run `paused` with no issue.
5. **Retry and approval.** `resume` reruns only the failed reviewer and then consolidates. `approve` consolidates only the successful audits, records the owner decision, and creates the issues of those audits.
6. **Dedupe.** A finding with a named existing issue links it and creates no issue. A finding whose title equals an open or closed issue links that issue even when the worker named none. Two reviewers' duplicate findings become one issue.
7. **Freeze.** After creation, `resume`, `approve`, and `status` change no frozen entry and create no issue. A retry of a partial creation adopts its earlier write before it creates the rest.
8. **No-op writes.** A status read changes no store mtime. A resume with nothing to do writes nothing.
9. **Failure isolation.** A failed issue read, a malformed consolidation, and a failed creation each pause with the named reason and write no partial frozen set.
10. **Platforms.** The audit runs its store and work-tree reads on Windows, macOS, and Linux. A target that a check cannot run is recorded in the matching shared verification checklist (#707, #708, #709, or #710), never in a new issue.

### 13. Deferred capabilities

Milestone 2 does not provide, and does not depend on:

- An in-batch decision request, a loop-slot release, owner-merge continuation, and notifications (milestone 3, issue #1711).
- Automatic selection of the issues that an audit creates for a following batch, or automatic chaining of an audit into a batch start.
- Issue creation from a worker-controlled `gh` call. The runtime owns every remote write.
- A merged or combined validation run.
- Removal of the audit work tree or its store.
- README and onboarding expansion.

## Consequences

- An owner can audit one revision with several reviewers, get one issue per finding, and never get a duplicate of an open or closed issue.
- A failed audit, a failed read, or a malformed consolidation creates no issue and leaves a resumable record. The owner chooses a retry or approves the partial audits.
- The audit work tree stays on disk for inspection, so each run costs one checkout until the owner removes it.
- The issue list is read once, so an issue created by another process after that read is outside the dedupe. Within the stored list, the worker's match and the exact-title check link an existing issue; the owner's review remains the protection for a later issue.
- The frozen set is local. A later run is a deliberate second command, and no state of the first run blocks it.
- A reviewer that changes the checkout fails that audit and stops the run as `needs-owner`, leaving every file as found. A saved result that does not name the current revision is discarded, and an owner approval is discarded when the failed set, the revision, or the checkout changes, so a changed checkout cannot feed issue creation.
- An issue adopted from a pending write carries the stable identity recorded before the write and is marked as created by this run, not as a pre-existing issue. A reworded re-audit links the same issue.
- The accepted limit: an issue that another process creates with the same body marker between the read and the create is not distinguished from this run's own pending write. The identity is a random value recorded before the write, so a collision needs a deliberate edit of the issue body, and the recorded provenance and the owner's review remain the protection.

## Alternatives

1. **Let a worker create the issues directly.** Rejected. A child would choose the remote write, the duplicate check would be advisory, and a retry could repeat a create. The runtime-owned create is testable and idempotent.
2. **Run each reviewer as a full headless loop.** Rejected. An orchestrator turn adds no audit value, costs steps, and gives the reviewer a second session that can act. One read-only reviewer turn is the whole audit.
3. **Create issues as each audit finishes.** Rejected. It violates the gate: a later failed audit could reveal that the issue set was never complete.
4. **Re-audit every time the consolidation fails.** Rejected. The audits are independent evidence and a consolidation is a pure function of them. A retry reruns the failed step only.
5. **Match duplicates by fuzzy search per finding.** Rejected. A search query is non-deterministic across providers and can miss a closed issue. The stored issue list and an exact-title rule are deterministic; the consolidation worker supplies the semantic match.
6. **Approve a failed consolidation.** Rejected. There is no partial result to approve, and an empty consolidation would silently create nothing.
7. **Store the audit inside the repository.** Rejected for the reason ADR 0106 rejects a batch checkpoint there: it changes the reviewed snapshot and adds run state to the delivery.
8. **Re-fetch `origin/<base>` at every retry.** Rejected. The revision is frozen at the start, so a retry audits the same code and the frozen set stays meaningful.

## Owner decisions

1. **No automatic retry.** A failed audit, consolidation, or creation waits for `resume` or `approve`.
2. **Keep the audit work tree.** No cleanup rule is added in milestone 2.
3. **One issue per consolidated finding.** A finding that several reviewers report becomes one issue, and a finding that an existing issue covers becomes a link, not a duplicate.

## Authors

Andro Marces

## Links

- [Issue #1710: Coordinate reviewer audits and issue creation](https://github.com/andromarces/agent-loops/issues/1710)
- [PR #1731: Coordinate reviewer audits and issue creation](https://github.com/andromarces/agent-loops/pull/1731)
- [Issue #1709: Implement foreground batch scheduling](https://github.com/andromarces/agent-loops/issues/1709)
- [Issue #1711: Release loop slots on owner decisions, resume after owner merges, and notify](https://github.com/andromarces/agent-loops/issues/1711)
- [Issue #707: Verification checklist: Linux](https://github.com/andromarces/agent-loops/issues/707)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [Issue #709: Verification checklist: Windows](https://github.com/andromarces/agent-loops/issues/709)
- [Issue #710: Verification checklist: live runs](https://github.com/andromarces/agent-loops/issues/710)
- [Implementation: audit supervisor](../src/batch/audit.mjs)
- [Implementation: batch command](../src/batch/cli.mjs)
- [Tests: audit coordination](../tests/batch/audit.test.mjs)
- [ADR 0019: Opt in to a workspace-write sandbox for the Codex reviewer](0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md)
- [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md)
- [ADR 0038: Run the Codex reviewer with no sandbox by default](0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)
- [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md)
- [ADR 0049: Pin the machine-wide roots for every child turn](0049-pin-the-machine-wide-roots-for-every-child-turn.md)
- [ADR 0095: Report inherited temporary directory names as diagnostics, not open items](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md) (decision 16's milestone 2 entry superseded)
- [ADR Index](README.md)
