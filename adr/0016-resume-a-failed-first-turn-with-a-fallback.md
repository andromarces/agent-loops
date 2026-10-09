# 0016. Resume the session of a failed first turn, with a fallback to a new session

## Status

superseded

Superseded by [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md). ADR 0027 restates the decisions of this ADR that still hold and closes the crash gap of an orchestrator or reviewer turn with a transcript inside the work tree.

## Date

2026-09-30

## Context

A failed first turn lost its session. The Claude, Codex, and opencode adapters set
`state.sessionId` only after a successful parse, so a non-zero exit or a timeout left
the id null. The next turn started a new session with the role preamble. That session
had no memory of the edits the failed turn left in the work tree (issue #360).

Keeping the id creates a second failure: a turn that fails before the CLI saves a
session leaves an id that names no session. Every later resume then fails, and the
step budget runs out.

## Decision

1. Each adapter reads the session id from the output when the CLI printed one and keeps
   it on the role state on every failure path, including a non-zero exit, a timeout, and
   a response-validation failure after the id was read, for a first turn only. Claude and
   opencode select the first truthy id in the output, Codex the `thread_id` of its first
   `thread.started` event, Copilot the id of its last result event, and agy the
   `conversation_id` of its one result object. Each then requires the selected id to be a
   non-empty string, so an empty id is skipped only where the selection takes the first
   truthy id (Claude and opencode), and a selected number, object, or empty value fails the
   turn. A failed turn never changes
   the id of a resumed session. Every adapter except agy keeps the resumed id or raises
   `resumeMismatchError` on a different one, and the Claude adapter now does so like
   Codex, Copilot, and opencode. agy adopts the `conversation_id` that its successful
   result carries, even when it differs from the resumed id. When it resumed an id and the
   result carries a different one, with or without the stderr text
   `conversation "<name>" not found`, the adapter logs a warning and sets
   `state.conversationReplaced`. The adapter clears the mark at the start of every call. The
   runtime clears it after every worker, reviewer, and orchestrator turn, on success and on failure.
   A worker turn that carries the mark is followed by one preamble-only worker turn in the new
   conversation, in the same step. That turn carries the worker preamble and a task that asks for
   no change, so the turn that already ran is never rerun and its edits are not repeated.
   The preamble reaches the conversation after the task prompt, so the turn that ran acted on the
   task without the rules. The preamble-only turn is a worker turn with no mutation check, so
   it can still write although its prompt asks for no change. A failed preamble turn logs a
   warning and leaves the worker result intact, and only a cancel propagates. A reviewer prompt
   carries its full scope on every turn, so a replaced reviewer conversation needs nothing.
   An orchestrator turn that carries the mark and was not the first turn is rerun once, with the
   initial instructions placed before the same prompt. Each call has its own mutation check, and
   the first call is checked before the rerun starts, so an edit of the first call that the rerun
   restores is still detected. An
   orchestrator turn is read-only, so the rerun repeats no edit, and its answer replaces the
   answer of the instructionless conversation. The first orchestrator turn already carries the
   instructions and is not rerun. The orchestrator conversation loses the earlier turns of the old
   conversation. The mark is not stored in the state file, so a crash between a worker turn and its
   preamble turn leaves the new conversation without the preamble. The Copilot adapter keeps the id that the result event of a failed first turn
   reports. It does not keep the pre-assigned id: a failed turn that reports no id does not show
   that the CLI created a session under it, and a kept id would send the next worker turn
   to a session that may not exist, without the preamble. On Copilot CLI 1.0.90-4, a first
   turn that failed on a bad model printed no result event, and a later call with the same
   pre-assigned id completed and echoed that id. Whether that call resumed a prior
   session or started a new one is not verified, and neither is whether the failed turn
   saved a session.
   The Claude adapter passes a pre-assigned UUID with `--session-id` on every first turn and
   keeps it when the turn fails, unless the failed output reported an id, which wins (issue
   #395). A resumed turn passes no `--session-id`. A successful first turn adopts the id the
   CLI reports and logs a warning when it differs from the pre-assigned one. On Claude Code
   2.1.292, a first turn killed 30 s into a `sleep 90` tool call printed nothing and left a
   session file, and `--resume` of the pre-assigned id answered with the earlier command in its
   history and echoed the id. A first turn killed 0.4 s in left no session file, and `--resume`
   of its id exited 1 with the `No conversation found` line of decision 2, so the next turn
   reaches the fallback and reruns as a first turn with a new pre-assigned id. A pre-assigned id
   that names no session therefore costs one failed resume, not a lost run.
   Windows 11, Claude Code 2.1.295 (issue #565), probed in scratch directories under the
   temporary directory, with the unchanged adapter. Every result agrees with the adapter, so no
   defect was found. Layout: a first turn with `--session-id <id> --output-format json --verbose`
   printed a `session_id` equal to `<id>` and wrote `projects/<dir>/<id>.jsonl`, where `<dir>` is the
   work tree path with each non-alphanumeric character replaced by `-`. The first `user` record
   has `sessionId` equal to `<id>`, `cwd` as launched, and `message.content` as a string that ends
   with the marker line. Id casing: an uppercase `--session-id` was kept as given in the file name
   and in the output. The adapter generates lowercase ids only, so its canonical lowercase check
   never refuses an id of its own. Drive letter: `realpath` of `C:...wt1` and `c:...wt1`
   both returned `C:...wt1`. Claude Code records `cwd` as launched, so one session recorded
   `C:...` and another `c:...`. Resumed through `runClaude` with the check on, all four pairs
   of a `C:` or `c:` work tree and a `C:` or `c:` record passed, and a parent directory and
   another role were refused. A drive letter difference does not make an owned session read as
   not owned. Guard: `O_NOFOLLOW` is `undefined` in Node 26.8.1 on Windows. A directory junction
   as the project directory reports `isSymbolicLink() === true` and `isDirectory() === false`
   from `lstat`, and the check refused it. The same session in a real directory passed. A
   symlink could not be created (`EPERM`, no symlink privilege), so a file symlink is not
   verified. Forced terminate: Windows has no SIGKILL, so the child was ended with
   `taskkill /F /T /PID`. A first turn with a `sleep 90` tool call, killed at 0.4, 1, 2, and
   2.5 s, left no session file, the check refused (a worker or reviewer turn then reruns as a first turn, and an orchestrator turn ends the run), and `--resume <id>` exited 1 with the
   `No conversation found` line of decision 2. Killed at 3, 3.5, 4, 8, 15, and 30 s, it left a
   file whose first user record carried the marker, the check passed, and `--resume <id>`
   answered. Stdout was empty in every case. The file appears between 2.5 s and 3 s on this
   host, and that boundary is not a contract. Not verified: other Claude Code versions on
   Windows (2.1.284 and 2.1.292 were probed on macOS for issue #395), a file symlink, and a
   drive letter difference on a work tree that no longer exists, where `realpath` fails and the
   case is kept as given.
   On the interactive dispatch path, the adapter reports the pre-assigned id to the dispatcher
   before it starts the CLI, and the dispatcher writes it to the state file at once. A crash
   during the turn then leaves the id, and the turn after `--resume-interrupted` resumes it. A
   failed write stops the turn before the CLI starts. A first turn that the CLI rejects with
   `Error: Session ID <id> is already in use.` (exit 1, empty stdout, that one line, optional
   line ending) never keeps the id, because the id names another session. The state file then
   records null and the next turn starts with a fresh id. The turn is not rerun: a collision of
   a random UUID is not expected, and a refusal never resumes an unrelated session.
   The adapter withdraws the id through the same callback as soon as it sees the rejection,
   before it rethrows, so the state file holds no rejected id while the turn ends. A crash in the
   instant between the rejection and that write can still leave it, and an unrelated session of
   another work tree can hold a pre-assigned UUID that the CLI never confirmed for this run.
   `resumeMismatchError` cannot catch that: the other session reports the same id. The role state
   therefore carries `sessionUnconfirmed` from the pre-spawn write until the CLI output reports the
   session. The adapter resumes an unconfirmed id only when a Claude Code session file for it,
   under `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), has a first user record that
   names the id and this work tree and carries the marker `[agent-loop session <id> role <role>]`,
   which the adapter appends to every first-turn prompt. The id is a fresh random value that only
   this run's state records, and the role is in the marker, so another session of the same work
   tree or of another role never matches. Only the marker match reads session content, and nothing
   of it is logged. The adapter refuses an id that is not a canonical lowercase UUID before it builds
   a path, follows no symlinked project directory or session file, and accepts only a regular file
   that it reads with a 256 KiB bound. `--continue-from` restores the unconfirmed mark with the id,
   so a restored id passes the same check. Otherwise the adapter raises the missing-session error
   before any CLI starts, and the runtime reruns the turn as a first turn, as in decision 3. A
   session store elsewhere reads as not owned, and the turn starts a fresh session. Both paths
   save the id mid-turn (issue #564). When `--transcript` is set, the headless loop rewrites the
   transcript before the CLI of a Claude orchestrator, worker, or reviewer starts, with the id and
   `sessionUnconfirmed` on that role, so a parent crash during a first turn leaves a transcript that
   `--continue-from` restores, and the ownership check runs before the resume. A rejected id is
   withdrawn through the same hook. The written file keeps the id until the next transcript write, so a
   crash during the turn leaves it on disk. The id lives in an in-memory overlay that the end of the
   CLI call clears, and the role state is not changed. The next write, at the latest the write at
   exit, records what the adapter decided: a reported id wins, an unreported one keeps the
   pre-assigned id with its mark, and a rejected one keeps none.
   Setting the id on the role instead made a reported id lose and dropped the mark, so a stale id
   resumed unchecked. Three limits remain. A failed transcript write only warns, as at exit. A run
   with no `--transcript` keeps no record. A transcript inside the Git work tree that the mutation check covers (the repository root, not
   only `--cwd`) is not written before an orchestrator or reviewer turn, because those turns run
   under the mutation check and the write would fail it, so they keep the gap for that layout and
   log a warning. A refused ownership check on a resumed orchestrator id ends the run and keeps
   the id with its mark, because the orchestrator has no first-turn rerun: a new session would
   lack the task. The restore runs inside the mutation check, so a failed snapshot after the turn cannot lose the mark. Not verified: Windows file system behavior, and the transcript that a real
   process kill leaves, which the tests simulate by reading the file mid-turn. Separate processes that
   share one transcript path have no write coordination: each write is atomic and the last wins.
2. The Claude and Codex adapters mark a resume error with `sessionMissing` only when the
   process exited 1 with no timeout, cancel, or signal, stdout is the empty string, and
   stderr is the one verified line for the requested id, byte for byte, plus at most one
   line ending (LF or CRLF): Claude Code
   `No conversation found with session ID: <id>`, Codex
   `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)`.
   That line ending is the only normalization. Leading or trailing spaces, blank lines,
   a second line, or any other text leave the error unmarked.
   A wrong mark would rerun a real failure as a first turn and repeat its edits. A CLI
   that changes the wording loses the fallback and fails as before.
3. `runChild` handles the mark. It clears the role session id, then reruns the turn
   once as a first turn: a worker gets the preamble again, a reviewer prompt is
   unchanged. The rerun runs inside the same read-only mutation check.
4. The rerun charges no second step. The failed resume ran no model turn, so the
   step still pays for one requested turn. The rerun happens at most once per turn, so
   the extra cost is bounded. The transcript shows two `invocation` events with the same
   `stepsUsed`, and the state file holds one `turns` entry.
5. A dispatch that ends in a cancel or a fatal guard error still persists the id the
   CLI reported, and the runtime writes the cleared id when the rerun fails.

## Consequences

- A failed first turn resumes its own session, edits included, and reuses its prompt cache.
- opencode and agy give no failure for a missing session. opencode accepts the id and
  creates that session. In the probe, agy warned on stderr, exited 0, and started a
  new conversation with a new id. Neither can trigger the fallback. The agy adapter adopts the
  id the result carries and, for a resumed turn whose id differs, logs a warning and marks the
  state. A worker conversation then gets the preamble in a preamble-only turn. That turn costs
  one model call and is not charged as a step. Its prompt asks for no change, but the worker
  turn has no mutation check, so it can still write. The task prompt reaches the new
  conversation before the preamble. An orchestrator turn is rerun once with the initial
  instructions, which costs one more model call and loses the earlier orchestrator turns.
- In the probe, Claude and agy printed no session id when killed at 20 to 25 s. A Claude first
  turn that ends that way keeps its pre-assigned id. An agy first turn keeps a null id.
- A worker resumed after a failed first turn receives no second preamble. The failed turn
  carried it, and the CLI saved it with the session.

## Alternatives

1. **Charge a second step for the rerun**: rejected. The user-visible turn count would
   depend on a CLI storage detail, and a run near its budget would end for a fault
   that ran no model turn.
2. **Match the error text in `runChild`**: rejected. The messages belong to the CLIs, so
   each adapter owns its pattern and the runtime reads one flag.
3. **Rerun the agy turn when the conversation is missing**: rejected. The turn already
   ran and can have edited the tree, so a rerun repeats the edits. A preamble-only turn
   replaces it for a worker. An orchestrator turn is read-only, so a rerun is safe there
   (issue #396).
4. **Pass a pre-assigned Claude session id with `--session-id`, as the Copilot adapter does**: adopted for Claude in
   issue #395 after a probe (decision 1). The Copilot adapter still keeps no pre-assigned id, because a Copilot
   probe did not show that a failed first turn saves a session.
5. **Refuse a different agy id**: rejected. The new conversation already holds the turn, and a
   kept stale id would fail the same way on every later turn.
6. **Store a preamble-owed mark and prepend the preamble to the next worker turn**: rejected.
   It needs a new field in the state file and in `--continue-from`, and the preamble would
   reach the conversation a turn later.

## Authors

Andro Marces

## Links

- [Issue #360](https://github.com/andromarces/agent-loops/issues/360)
- [Issue #395](https://github.com/andromarces/agent-loops/issues/395)
- [Issue #396](https://github.com/andromarces/agent-loops/issues/396)
- [Issue #564](https://github.com/andromarces/agent-loops/issues/564)
- [Issue #565](https://github.com/andromarces/agent-loops/issues/565)
- Implementation: `keepFailedSessionId` and `flagMissingSession` in `src/agents/shared.mjs`,
  the adapters in `src/agents/` (the Claude pre-assigned id in `src/agents/claude.mjs`), `runFn` in `src/runtime.mjs`, the dispatch write in
  `src/role.mjs`, and the headless transcript write through `onSessionAssigned` in `src/runtime.mjs` and `src/cli.mjs`; documented in `README.md`
- Superseded by [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR Index](README.md)
