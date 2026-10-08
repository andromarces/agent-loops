# 0027. Save the session id of an in-tree transcript outside the work tree

## Status

accepted

Supersedes [ADR 0016: Resume the session of a failed first turn, with a fallback to a new session](0016-resume-a-failed-first-turn-with-a-fallback.md). The decisions of ADR 0016 that still hold are restated below. One changes: a headless run whose `--transcript` is inside the Git work tree now saves the session id before an orchestrator or reviewer first turn. ADR 0016 left that crash gap open.

## Date

2026-10-08

## Context

ADR 0016 keeps the session of a failed first turn. For Claude, the adapter passes a pre-assigned UUID with `--session-id`. The headless loop writes that id to the `--transcript` file before the CLI starts (issue #564). A parent crash during the turn then leaves a transcript that `--continue-from` resumes after an ownership check.

The orchestrator turn and the reviewer turn run under the mutation check. The check snapshots the whole Git work tree, not only `--cwd`. A write to a transcript inside that tree, during the turn, fails the check. ADR 0016 therefore skipped the write for that layout and logged a warning. Issue #581 asks to close that gap. The check must stay exact for every other path.

Two directions were weighed. The first exempts the transcript path from the check. The second writes the record outside the work tree. A first implementation of the exemption failed review, because every way to name the exempt path had a flaw:

- A path text that equals a sentinel entry, `<index>` or `<HEAD>`, hid an index change or a commit.
- A path that names a submodule hid every change inside the submodule.
- A path that differs only in case from the file on disk caused a false failure on a case-insensitive file system.
- A transcript inside a submodule made the outer snapshot dirty and caused a false failure.

## Decision

1. Each adapter reads the session id from the output when the CLI printed one. It keeps the id on the role state on every failure path of a first turn. The paths include a non-zero exit, a timeout, and a response-validation failure after the id was read. Claude and opencode select the first truthy id. Codex selects the `thread_id` of its first `thread.started` event. Copilot selects the id of its last result event. agy selects the `conversation_id` of its one result object. The selected id must be a non-empty string, or the turn fails. A failed turn never changes the id of a resumed session. Every adapter except agy keeps the resumed id or raises `resumeMismatchError` on a different one. agy adopts the `conversation_id` of its successful result and, when it differs from the resumed id, logs a warning and sets `state.conversationReplaced`. Issue #396 and the README define the follow-up turns for that mark.
2. The Copilot adapter keeps the id that the result event of a failed first turn reports. It never keeps the pre-assigned id, because a failed turn that reports no id does not show that a session exists.
3. The Claude adapter passes a pre-assigned UUID with `--session-id` on every first turn. It keeps the id when the turn fails, unless the failed output reported another id. A resumed turn passes no `--session-id`. A first turn that the CLI rejects with `Error: Session ID <id> is already in use.` never keeps the id, and the adapter withdraws it through `onSessionAssigned`. The role state carries `sessionUnconfirmed` until the CLI output reports the session. The adapter resumes an unconfirmed id only after a check. A Claude Code session file for this work tree and role must carry the marker `[agent-loop session <id> role <role>]` (issue #395).
4. The Claude and Codex adapters mark a resume error with `sessionMissing` in one case only. The process must exit 1 with empty stdout and no timeout, cancel, or signal. Stderr must be the one verified line of the requested id. `runChild` then clears the id and reruns the turn once as a first turn, with no second step charged. The transcript shows two `invocation` events with the same `stepsUsed`.
5. A dispatch that ends in a cancel or a fatal guard error still persists the id that the CLI reported. The runtime writes the cleared id when the rerun fails. On the interactive path, the dispatcher writes the pre-assigned id to the state file before the CLI starts.
6. The headless loop saves the pre-assigned id of a Claude first turn before the CLI starts (issue #564). The id lives in an in-memory overlay that the end of the CLI call clears. The role state is not changed, so the adapter alone decides what a failed turn keeps.
7. The target of that save depends on the role and on the location of `--transcript`. This decision is new.
   - A worker turn runs under no mutation check. The loop writes the transcript file.
   - An orchestrator or reviewer turn with a transcript outside the work tree also writes the transcript file.
   - A transcript inside the work tree gets one write before the first turn, outside every mutation check. That write adds a top-level `runNonce`, a random UUID of this run. An orchestrator or reviewer first turn then writes a session record outside the tree. The mutation check has no exemption and no new parameter.
   - The record is the file `<tmpdir>/agent-loops/session-records/<key>.json`. The key is a digest of the identity of the transcript directory and the lowercase file name, so a case alias finds the same record.
   - The record holds only `version`, `transcript` (the key), `cwd`, `runNonce`, `transcriptSha256`, `role`, `sessionId`, and `sessionUnconfirmed` (always `true`). It holds no task text and no other transcript content.
   - `transcriptSha256` is the digest of the transcript file that the loop wrote last. Every later transcript write changes it and removes the record. A removal that fails is harmless, because a changed digest makes the record stale.
   - `runNonce` is unique to the run. Two runs can have the same task, work tree, transcript path, and transcript bytes before the nonce. The nonce makes their records differ, so a record of one run never binds to another.
   - A rejected id removes the record. The loop never writes the transcript during the turn.
   - The loop decides "inside" by file identity (device and inode) along the ancestors of the real path. A case alias, a symlink, and a directory inside a submodule all count as inside.
   - The record is untrusted input. `--continue-from` uses it only when every test passes:
     - The file is a small regular file of the current user.
     - The file is valid JSON with exactly the fields above.
     - Each string field is a string of the right form. The role is the orchestrator or the reviewer. The id and the nonce are lowercase UUID strings. A value of another type, such as an array that holds a UUID, fails.
     - The key and `cwd` equal those of this transcript.
     - `runNonce` equals the `runNonce` of the transcript.
     - The digest equals the digest of the transcript bytes now.
   - A failed test ignores the record. A mismatch other than a stale digest also logs a warning.
   - A valid record sets the id and the unconfirmed mark of one role. The role must be a Claude role with no id in the transcript. The adapter then runs the ownership check of decision 3 before the id resumes. A record cannot clear the mark or skip the check.
   - The loop saves nothing before the turn and logs a warning in two cases. The record location is inside the work tree, or the work tree root cannot be read.

## Consequences

- A parent crash during a Claude orchestrator or reviewer first turn leaves a record that `--continue-from` resumes, whatever the location of the transcript. This meets issue #581.
- The mutation check is unchanged for every path. The four flaws of the exemption do not exist, because there is no exempt path.
- The record is not in the transcript file. A reader that opens only an in-tree transcript after a crash sees the state before the turn. Only `--continue-from` reads the record.
- A clean-up of the temporary directory, or a reboot that clears it, loses the record. The crash gap then stays open for that run.
- A foreign or crafted record cannot supply an id. A record of another user, transcript, work tree, run, or older transcript state is ignored.
- A same-user process can still forge a valid record, because it can also edit the transcript. The ownership check still requires a session file with the marker of this work tree and role.
- An in-tree transcript is written once before the first turn and holds `runNonce`. A transcript outside the work tree keeps its earlier shape. A run that fails before any turn leaves the in-tree file with exit code 1 and no error text.
- Not verified: Windows file system behavior, and the record that a real process kill leaves. The tests simulate a kill by restoring the files that a turn had on disk.
- Separate processes that share one transcript path have no write coordination. Each write is atomic and the last one wins.

## Alternatives

1. **Exempt the transcript path from the mutation check**: rejected. The exempt path is compared as text with the status paths and the sentinel entries. A sentinel name, a submodule path, and a case alias each fail. A guard with one exception needs a proof for every path form. A record outside the tree needs none.
2. **Compare the hash of the transcript content instead of its path**: rejected. It keeps the exemption and its path forms.
3. **Write the record beside the transcript with a hidden name**: rejected. It is inside the work tree, so the check covers it.
4. **Skip the write and log a warning, as ADR 0016 did**: rejected. It leaves the gap that issue #581 reports.
5. **Store a full copy of the transcript as the record**: rejected in review. It copies the task text out of the transcript. It also lets a record replace the roles and the mark that the transcript holds. The record now holds the id and its binding only.
6. **Store the record in the install home**: rejected. The home is user scope and has its own lock (ADR 0025). The temporary directory already holds the run state of the interactive path.

## Authors

Andro Marces

## Links

- [Issue #564](https://github.com/andromarces/agent-loops/issues/564)
- [Issue #581](https://github.com/andromarces/agent-loops/issues/581)
- [Pull request #585](https://github.com/andromarces/agent-loops/pull/585)
- Supersedes [ADR 0016: Resume the session of a failed first turn, with a fallback to a new session](0016-resume-a-failed-first-turn-with-a-fallback.md)
- Implementation: `src/lib/session-record.mjs`, `onSessionAssigned` in `src/cli.mjs`, and `readContinuation` in `src/lib/continuation.mjs`. Documented in `README.md`.
- [ADR Index](README.md)
