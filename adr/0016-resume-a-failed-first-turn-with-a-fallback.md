# 0016. Resume the session of a failed first turn, with a fallback to a new session

## Status

accepted

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
   result carries, even when it differs from the resumed id, and logs a warning only when
   it resumed an id and stderr matches `conversation "<name>" not found`. A resumed agy
   turn is sent without the role preamble, so a new conversation that agy started has not
   received it. The Copilot adapter keeps the id that the result event of a failed first turn
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
   session store elsewhere reads as not owned, and the turn starts a fresh session. Only the interactive dispatch path
   saves the id mid-turn. The headless loop keeps the id in memory until the turn ends, so a
   parent crash during a first turn there still loses the id, and the next run starts a new
   session. That pre-spawn crash gap stays open for the headless loop.
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
  new conversation with a new id. Neither can trigger the fallback. The agy adapter has
  no mismatch check: it stores the valid id the result carries and logs a warning only
  when stderr matches `conversation "<name>" not found`. A resumed turn carries no
  preamble, so a new conversation lacks it. A new id without that stderr text is adopted
  without a warning and was not seen in the probe.
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
   ran and can have edited the tree, so a rerun repeats the edits.
4. **Pass a pre-assigned Claude session id with `--session-id`, as the Copilot adapter does**: adopted for Claude in
   issue #395 after a probe (decision 1). The Copilot adapter still keeps no pre-assigned id, because a Copilot
   probe did not show that a failed first turn saves a session.

## Authors

Andro Marces

## Links

- [Issue #360](https://github.com/andromarces/agent-loops/issues/360)
- [Issue #395](https://github.com/andromarces/agent-loops/issues/395)
- Implementation: `keepFailedSessionId` and `flagMissingSession` in `src/agents/shared.mjs`,
  the adapters in `src/agents/` (the Claude pre-assigned id in `src/agents/claude.mjs`), `runFn` in `src/runtime.mjs`, and the dispatch write in
  `src/role.mjs`; documented in `README.md`
- [ADR Index](README.md)
