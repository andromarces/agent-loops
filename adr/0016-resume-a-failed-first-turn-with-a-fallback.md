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

1. Each adapter reads the session id from the failed output when the CLI printed one
   and keeps it on the role state, for a first turn only. A resumed turn never changes
   its id, and the Claude adapter refuses a different id from a resumed turn with
   `resumeMismatchError`, as the other adapters do. The Copilot adapter keeps the id that the result event of a failed first turn
   reports. It does not keep the pre-assigned id: a failed turn that reports no id does not show
   that the CLI created a session under it, and a kept id would send the next worker turn
   to a session that may not exist, without the preamble. On Copilot CLI 1.0.90-4, a first
   turn that failed on a bad model printed no result event, and a later call with the same
   pre-assigned id ran as a new session and echoed that id. Whether the failed turn saved
   a session is not verified.
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
  creates that session. agy warns on stderr and starts a new conversation with a new
  id. Neither can trigger the fallback. The agy adapter adopts the new id and logs a
  warning, and the turn runs without the role preamble.
- Claude and agy print no session id on a timeout or a cancel, so a first turn that
  ends that way keeps a null id.
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
4. **Pass a pre-assigned Claude session id with `--session-id`, as the Copilot adapter does**: deferred. It would keep the
   id across a timeout, but it changes the first-turn invocation and needs its own probe.

## Authors

Andro Marces

## Links

- [Issue #360](https://github.com/andromarces/agent-loops/issues/360)
- Implementation: `keepFailedSessionId` and `flagMissingSession` in `src/agents/shared.mjs`,
  the adapters in `src/agents/`, `runFn` in `src/runtime.mjs`, and the dispatch write in
  `src/role.mjs`; documented in `README.md`
- [ADR Index](README.md)
