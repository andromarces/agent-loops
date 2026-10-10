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
   - The loop decides "inside" by file identity (device and inode) along the ancestors of the real path and along the ancestors of the path as written. A case alias, a symlink, a directory inside a submodule, and a junction inside the tree all count as inside, whatever the target of the junction.
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
- This changes the transcript contract of issue #337 for one case. A transcript inside the work tree holds one more top-level field, `runNonce`. A transcript outside the work tree keeps its earlier shape. Tests assert both shapes. The README states the exception. The repository owner must approve the change at merge.
- The field is needed because no value of the transcript is unique to a run before the first turn. The transcript then holds the task, `cwd`, the options, role records with null ids, and no events. Two runs with the same inputs write the same bytes.
- An in-tree transcript is written once before the first turn. A failure that the loop catches before any turn rewrites that file with its error. A crash before any turn leaves the file with exit code 1 and no error text.
- Windows probe (issue #580). Host: Windows 11 Pro 10.0.26220, Node v26.8.1, Claude Code 2.1.295, Git 2.55.0.windows.5, repository head `339fa9f`. Each probe ran against a disposable Git repository under the temporary directory, with `haiku` for every role. One result contradicted this ADR: the junction case below (issue #613). That case is fixed.
  - Orchestrator and reviewer command: `node src/cli.mjs --orchestrator claude --worker claude --reviewer claude --orchestrator-model haiku --worker-model haiku --reviewer-model haiku --mode review-only --max-steps 3 --timeout 180 --cwd <repo> --transcript <file> --task "Probe: do nothing. Run the reviewer once, then finish."`.
  - Worker command: the same command with `--mode work-first` and the task `Probe: do nothing to files. Run the worker once with the prompt 'Reply OK. Change no file.', then run the reviewer once, then finish.` The `review-only` mode refuses a `run_worker` action, so a worker probe needs `work-first`. The `options.mode` of both worker transcripts reads `work-first`.
  - Method: a driver script ran each probe in this order. Each probe below is named as its directory in the probe log, with its own two values.
    - It spawned the parent with `spawn(process.execPath, [...])`, and then set the start time with `const t0 = Date.now();`. That line runs after the spawn call and after `await sessionRecordPath(transcript)`.
    - It polled every 25 ms for the saved id. A `-pre` probe stopped at the first poll that saw the id. A `-mid` probe stopped at the first poll that saw the id and the session file.
    - It read `msSinceStart` with `log.msSinceStart = Date.now() - t0;`. The value is the time from `t0` to that read, not from the parent spawn.
    - It read `sessionFileAtKill`, whether the session file existed at a second directory read.
    - It ran a PowerShell process query, and only then `taskkill`.
    - Both values are samples from before the query and the kill command. They are not the kill time, and the log holds no kill time.
    - A second run added `--continue-from <file>`.
  - Forced terminate, probe `a1-out-orch-FT-mid` (`msSinceStart` 4068, `sessionFileAtKill` true): `taskkill /F /T /PID <parent>` ended the parent with exit code 1. The check for a `claude.exe` that carries the session id found none (`claudeAfterKill` empty).
  - Parent-only terminate, probe `a4-out-orch-F-mid` (5705, true): `taskkill /F /PID <parent>` ended the parent only. The check found no `claude.exe` with the session id (`claudeAfterKill` empty). The log holds no time for how soon the child ended.
  - Plain terminate, probes `a3-out-orch-plain-mid` (5858, true) and `b3-in-orch-plain-mid` (5903, true): `taskkill /PID <parent>` exited 1 with `This process can only be terminated forcefully (with /F option).` The parent kept running (`parentExited` null in both). A plain `taskkill` therefore does not simulate a crash on this host. The later results of these two probes are not used.
  - Transcript outside the work tree, session file seen in the sample: the transcript held the id with `sessionUnconfirmed: true` and no `runNonce`. `--continue-from` resumed the id, cleared the mark, and ended with exit 0. This holds for the orchestrator probe `a1-out-orch-FT-mid` (4068, true) and the reviewer probe `c1-out-rev-FT-mid` (16753, true).
  - Worker outside the work tree, probe `c5-out-worker-FT-mid` (14465, true): the transcript held the worker id with the mark. The continued run dispatched no worker turn. A worker resume outside the tree is not verified.
  - Transcript outside the work tree, session file not seen in the sample: the driver stopped at the first poll that saw the saved id. The sample showed no session file. Probe `a2-out-orch-FT-pre` (989, false) kept the id and the mark. Its continued run ended with exit 1 and `Claude Code session <id> is not verified as owned by this work tree.` Probe `c4-out-rev-FT-pre` (11952, false) logged `session <id> is missing; rerunning the turn as a first turn`, wrote two `invocation` events, and ended with exit 0.
  - Transcript inside the work tree: the file held no id after the kill, held `runNonce`, and the record existed. With the session file seen in the sample, `--continue-from` resumed the record id in probe `b1-in-orch-FT-mid` (5898, true) and in probe `c2-in-rev-FT-mid` (15452, true). Both ended with exit 0. In probe `c6-in-worker-FT-mid` (14446, true), the continued run resumed the worker id from the transcript and cleared the mark.
  - Transcript inside the work tree, session file not seen in the sample: probe `b2-in-orch-FT-pre` (1066, false) gave the same `not verified as owned` error. Probe `c3-in-rev-FT-pre` (11765, false) reran the reviewer as a first turn.
  - Limit found, probe `c2-in-rev-FT-mid`: an in-tree transcript is not rewritten between turns. A kill after the reviewer first turn started therefore leaves no orchestrator id. The continued run resumed the reviewer through the record. It started a new orchestrator conversation without the earlier turns. An out-of-tree transcript keeps the orchestrator id.
  - Case, transcript name or path: an upper-case file name (`T.JSON`) resumed the in-tree record in probe `f1-in-orch-name-case` (4756, true). It also resumed the out-of-tree transcript in probe `f2-out-orch-name-case` (4818, true). A fully upper-case transcript path resumed in probe `f3-out-orch-path-case` (4814, true).
  - Case, `--cwd`: a `--cwd` that differs in case is refused before any turn. The error reads `--continue-from: the earlier run used --cwd <path>, not <path>`. Whole-path case was refused in probes `d1-in-orch-case-all` (6088, true) and `d3-out-orch-case-all` (6062, true). A lower-case drive letter (`c:` for `C:`) was refused in probes `d2-in-orch-case-drive` (5941, true) and `d6-out-orch-case-drive` (6285, true).
  - Junction as `--cwd`: a junction path used for both runs resumed the id in probe `f4-out-orch-jcwd` (5054, true). The real path in the continued run was refused by the same `--cwd` text comparison in probe `f5-out-orch-jcwd-real` (4973, true).
  - Junction as the `--transcript` directory: a junction outside the tree that points inside it used the record and resumed in probe `d4-in-orch-junction-in` (6101, true). A junction inside the tree that points outside it failed the mutation check of an orchestrator turn. The continued run of probe `d5-out-orch-junction-out` (6324, true) failed this way. The uninterrupted run `e1-junction-out-clean`, which has no kill, failed the same way on the first orchestrator turn. The loop read the file as outside the tree, because the real path is outside, and Git for Windows follows the junction and lists `jn/t.json` as untracked (issue #613). The inside test now also walks the path as written, so this layout takes the session record path. The same layout then ended with exit 0 on this host (Claude Code 2.1.295, `haiku` for every role).
  - Rename over an open transcript, probe `g1-hold-whole-run`: a file held open with `FileShare.Read`, which gives no delete share, blocked every atomic transcript write. Each write failed with `EPERM` after the bounded retry. The run warned `Failed to write transcript` three times and ended with exit 0. The held file stayed as it was. In probe `g2-hold-2s`, a hold of 2 s caused one warning, and the later writes replaced the file.
  - Not verified: SIGKILL and SIGTERM on macOS and Linux, a file symlink (no symlink privilege on this host), and WSL (not installed).
- The tests simulate a kill by restoring the files that a turn had on disk. The probes above ended a real parent process.
- Separate processes that share one transcript path have no write coordination. Each write is atomic and the last one wins.

## Alternatives

1. **Exempt the transcript path from the mutation check**: rejected. The exempt path is compared as text with the status paths and the sentinel entries. A sentinel name, a submodule path, and a case alias each fail. A guard with one exception needs a proof for every path form. A record outside the tree needs none.
2. **Compare the hash of the transcript content instead of its path**: rejected. It keeps the exemption and its path forms.
3. **Write the record beside the transcript with a hidden name**: rejected. It is inside the work tree, so the check covers it.
4. **Skip the write and log a warning, as ADR 0016 did**: rejected. It leaves the gap that issue #581 reports.
5. **Store a full copy of the transcript as the record**: rejected in review. It copies the task text out of the transcript. It also lets a record replace the roles and the mark that the transcript holds. The record now holds the id and its binding only.
6. **Store the record in the install home**: rejected. The home is user scope and has its own lock (ADR 0025). The temporary directory already holds the run state of the interactive path.
7. **Bind the record to a value that the transcript already holds**: rejected. No such value exists before the first turn (see Consequences). A continued run holds earlier event times, but a fresh run holds none.
8. **Bind the record to the file identity and the modification time of the transcript**: rejected. Every atomic write makes a new file. The values differ across file systems and change when a tool touches the file. A test cannot restore them after a simulated kill.

## Authors

Andro Marces

## Links

- [Issue #564](https://github.com/andromarces/agent-loops/issues/564)
- [Issue #581](https://github.com/andromarces/agent-loops/issues/581)
- [Pull request #585](https://github.com/andromarces/agent-loops/pull/585)
- [Issue #580](https://github.com/andromarces/agent-loops/issues/580)
- [Issue #613](https://github.com/andromarces/agent-loops/issues/613)
- Supersedes [ADR 0016: Resume the session of a failed first turn, with a fallback to a new session](0016-resume-a-failed-first-turn-with-a-fallback.md)
- Implementation: `src/lib/session-record.mjs`, `onSessionAssigned` in `src/cli.mjs`, and `readContinuation` in `src/lib/continuation.mjs`. Documented in `README.md`.
- [ADR Index](README.md)
