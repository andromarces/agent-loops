# Batch runs

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when the user asks to work several items as one batch, or when a run reports an audit or a batch decision.

When the user asks to work several items as one batch, the skill resolves the request into explicit flags. It runs one `agent-loop batch start` command. It passes every setting as a flag. The settings are the repository, the selection, the agents, models, and efforts. They also include `--max-steps`, `--loops`, the base branch, the work-tree root, and the task template.

The last settings are the setup command, the test command, the timeout, and the reviewer sandbox. It shows the resolved settings and item identities before it starts. The runtime prompts for nothing and reads no request.

A batch item is a GitHub issue, a GitHub pull request, or a free-text task. The selection is explicit `--issue <n>` entries in launch order. It is also one `--from-audit <audit id>` for the frozen issue set of a finished audit, or one `--items-file <path>` JSON list. The runtime adds no selector such as "all open pull requests". The skill lists the pull requests itself and turns each one into a `pr` item. Each item carries `work-first`, `review-first`, or `review-only`.

The default is `work-first` for an issue and a task, and `review-first` for a pull request. An item carries its own `task` text when it has one, which replaces the template for that item only.

Turn a mixed request such as "work on every item of my local list, and review every open PR" into one `--items-file` list. Give each local item `{ "kind": "task", "text": "<the task>", "id": "<short-slug>" }`. Give each pull request `{ "kind": "pr", "number": <n>, "mode": "review-only" }` when the request is a review. Otherwise leave the default `review-first` when worker corrections are needed. Keep a GitHub issue as `{ "kind": "issue", "number": <n> }`.

A task item needs a unique slug id. Its branch, work tree, claim, checkpoint, and resume identity use it.

When the user asks to work the issues of a finished audit, read the audit with `agent-loop batch audit status --audit <id>`. Pass `--from-audit <id>` instead of `--issue` or `--items-file`. Run it only when the status is `created`. A paused or `needs-owner` audit is refused, and the audit command never starts a batch.

A pull request item runs on its head branch in every mode. Before launch the batch checks that the head equals the head frozen at start. It skips the item as `pr-head-moved` otherwise. A closed or merged pull request is `pr-closed`. A head in another repository is `pr-head-foreign` in a work mode and allowed in `review-only`.

In `review-only` the child gets none of `--pr`, `--require-ci`, and `--require-accept`. The loop finishes after the reviewer turn, and its report records the verdict.

Do not dispatch one `role` turn per item for a batch. The batch command owns the loops, the claims, the checkpoints, and the recovery. Use [Selecting issues for a batch](../orchestrator-instructions.md#selecting-issues-for-a-batch) to choose the issues. The runtime never selects one.

Read a batch with `agent-loop batch status --batch <id>`. Continue an interrupted batch with `agent-loop batch resume --batch <id>`. A `needs-owner` loop is not a failure and is not retried. Resolve the named local or remote state. A loop that exits 4 stops with reason `pr-head-unresolved`. Compare its pull request head with the reviewed commit, then merge or resume.

A pending decision releases its slot once no recorded child process is live. `agent-loop batch answer --batch <id> --decision <id> --option <key>` records one listed option. A blocked issue waits on a poll and launches after its blockers close, so no new start command is needed. For a decision, run `batch resume` again after the answer.

When the user asks for an audit of a project revision that produces issues, run one `agent-loop batch audit start` command. Pass the repository and one `--reviewer` per requested reviewer with its `--reviewer-model` or `--reviewer-effort`. Pass the consolidation `--worker`, the base branch, the work-tree root, the setup command, the timeout, and the reviewer sandbox. Pass the user's focus as `--focus <text>` or `--focus-file <path>` when the user gives one. The two focus flags are mutually exclusive, and an empty focus is refused. Show the resolved settings before it starts.

Do not choose a revision or select issues. Read an audit with `agent-loop batch audit status --audit <id>`, which shows the stored focus. Retry a failed audit with `batch audit resume`. Run `batch audit approve` only on the user's explicit instruction. Both reuse the stored focus and take no focus flag. An audit that stops as `needs-owner` is not retried.

Resolve the named work tree state, then run `batch audit resume`. When the user asks to remove a finished audit, run `agent-loop batch audit remove --audit <id>`. Never delete an audit work tree or store by hand.

After a batch ends, list each loop's `report.summary` items: `deferred`, `notDone`, `open`, and `notes`. List a `review-only` report's `reviewerFindings`, `reviewerBlockers`, `reviewerNotes`, and `reviewerDeferred` too. A `read` report with no finish summary also holds `lastTurnItems`. Name each loop whose `report.state` is not `read`, and name its `transcript`.

Open no issue for one of these items unless the user asks. On that request, dispatch a worker to check each item for a duplicate issue before it opens one.
