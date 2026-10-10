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

   The probes of issues #641 and #398 later showed that a first turn killed after a tool call
   saves a session under the pre-assigned id. ADR 0030 keeps that id when the session holds a saved
   turn (issue #642).

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
   macOS 27.2 (arm64), Node v26.11.1, Git 2.56.0, Claude Code 2.1.296, repository head `76bb63c` (issue #565).
   Each probe ran in a disposable Git repository under the temporary directory. Each probe used `haiku` for
   every role and the unchanged adapter. Every result agrees with the adapter, so no bug was opened.
   Layout and id casing. Command: `claude -p --session-id <id> --model haiku --permission-mode bypassPermissions --output-format json --verbose`, with the prompt `Reply OK. Change no file.` and the marker line.
   The output carried one `session_id` equal to `<id>`. The session file was
   `projects/<cwd with each non-alphanumeric character replaced by "-">/<id>.jsonl`. The first `user` record
   had `sessionId` equal to `<id>` and `cwd` equal to the launch directory. Its `message.content` was a string
   that ends with the marker. An uppercase `--session-id` kept its case in the output and in the file name.
   This matches the Windows result.
   SIGKILL of the CLI. The prompt asked for a `sleep 87` tool call. The driver sent `SIGKILL` to the `claude`
   pid at 0.4, 1, 2, 2.5, 3, 4, 8, 15, and 30 s after the spawn. The driver read whether the session file
   existed just before the signal. Stdout was empty and the exit signal was `SIGKILL` in every probe.
   A kill at 0.4, 1, and 2 s left no session file. The adapter check then refused the id with `sessionMissing`.
   `claude -p --resume <id>` exited 1 with `No conversation found with session ID: <id>` and empty stdout.
   A kill at 2.5, 3, 4, 8, 15, and 30 s left a file whose first `user` record carried the marker.
   The check passed, and `runClaude` resumed the id. In the probes at 2.5 to 8 s, the answer to a question
   about the earlier command named `sleep`. In the probes at 15 and 30 s, it did not.
   The file appears between 2 and 2.5 s on this host. That boundary is not a contract.
   SIGKILL of the headless parent. Command: the orchestrator command of issue #580 in ADR 0027, with
   `--transcript` outside the work tree. The driver ran `process.kill(<parent pid>, "SIGKILL")` at 0.4, 1.5,
   and 3.5 s after the spawn. It then ran `--continue-from` on the same transcript.
   At 0.4 s, no session file existed at the kill or 1.5 s later. The continued run ended with exit 1 and
   `Claude Code session <id> is not verified as owned by this work tree`.
   At 1.5 s, no file existed at the kill, and a file existed 1.5 s after the parent exit.
   At 3.5 s, a file existed at the kill. Both continued runs resumed the id, ended with exit 0, and cleared the mark.
   A `claude` child with parent pid 1 remained after each kill, as ADR 0027 records.
   Symlink guard. These were probes against a synthetic session store with a stub `claude`, not real-session
   probes. A throwaway `CLAUDE_CONFIG_DIR` held a session file with a valid first `user` record. A `claude` stub
   on `PATH` stood for the CLI. A regular file in a real directory passed the check, and the stub ran.
   Four cases were each refused with `sessionMissing`, and no CLI turn started. The cases were a file symlink,
   a directory symlink as the project directory, and a marker with another role. The fourth case was a `cwd` that differs by one character.
   Real-session symlink probe (issue #710). The host was macOS 27.2 (Darwin 27.2.0, arm64), Node v26.11.1, Claude Code 2.1.296, and repository head `6139965`.
   A real first turn ran in a disposable Git repository under the temporary directory.
   Command: `claude -p --session-id <id> --model haiku --permission-mode bypassPermissions --output-format json --verbose`, with the prompt `Reply OK. Change no file.` and the marker line.
   The result was `OK` with `is_error` false. The CLI wrote the session file under `~/.claude/projects`.

   An unchanged `runClaude` then resumed the id with `sessionUnconfirmed` set. Case A used the default store.
   It resumed the session, and the log showed one CLI start.
   Cases B and C used a throwaway `CLAUDE_CONFIG_DIR`, with the symlink pointing at the real session. They only read the real session through the symlink.

   B replaced the session file with a symlink. C replaced the project directory with a symlink.
   Each raised `sessionMissing` with the line `Claude Code session <id> is not verified as owned by this work tree.`
   Neither case started a CLI.

   Case D, a regular copy of the real file in the throwaway store, passed the check and started the CLI. The CLI exited 1 in that store.
   Only the symlink differs between D and B or C, so the symlink caused the refusal.
   Every result agrees with the adapter. No bug was opened.

   Not verified: Linux. Not verified on Windows: a file symlink, a directory symlink,
   and a drive letter difference for a work tree that no longer exists.
   Not verified: a Claude Code version other than 2.1.284, 2.1.292, 2.1.295, and 2.1.296.
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
   lack the task. The restore runs inside the mutation check, so a failed snapshot after the turn cannot lose the mark. Issue #580 probed a real process kill and the Windows file system on
   Windows 11 with Claude Code 2.1.295. ADR 0027 holds the commands and the results. A forced kill
   with `taskkill /F /T` left the id with the mark. `--continue-from` resumed it after the ownership
   check, when the driver sample before the kill showed the session file. A run whose sample showed
   no session file was refused. A reviewer then reran as a first turn. Issue #580 also probed
   `SIGKILL` and `SIGTERM` on macOS 27.2 (arm64), Node v26.11.1, Claude Code 2.1.296, with `kill` of the
   headless parent pid. ADR 0027 holds the commands and the results. Every result agrees with the
   decisions here. With a transcript outside the work tree and the session file seen in the driver sample,
   both signals left the id with the mark, and `--continue-from` resumed it for the orchestrator, the
   reviewer, and the worker. A run whose sample showed no session file gave the refusal for an orchestrator
   id, and a rerun as a first turn for a reviewer id and for an in-tree worker id. After `SIGTERM`, the same check found no child process.
   `SIGKILL` of the parent left a `claude` child with parent pid 1 in 12 of 14 probes, at a check 1.5 s after the parent exit. Not verified: Linux.
   Separate processes that
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
  new conversation with a new id. Neither can trigger the fallback.

  A live probe on agy 1.3.2 (issue #579) found the same result for a missing name and for a
  missing UUID. Each exited 0, printed the stderr warning, and returned a new id. A resume of an
  existing id kept its id. The probes do not show that a missing id is the only cause of a
  replaced conversation. No probe produced a replaced conversation without the stderr line.

  The preamble-only worker turn answered `OK` and left the work tree unchanged. The rerun
  orchestrator prompt answered with the action for the result, not with the first action that the
  instructions ask for. The probe found no result that contradicts the adapter or the runtime.

  Issue #657 repeated the three probes on agy 1.3.2 on Windows 11 Pro (10.0.26220), on 2026-10-10,
  in a disposable Git repository in the system temporary directory. The flags were
  `--input-format text --output-format json`, with the prompt on stdin and `--mode plan` except in
  probe 2. A missing name and a missing UUID each exited 0, printed
  `warning: conversation "<id>" not found`, and returned `SUCCESS` with a new id. An existing id
  returned the same id and no warning. The preamble-only worker prompt answered `OK` and left HEAD
  and `git status` unchanged. The rerun orchestrator prompt answered `run_reviewer`, and the same
  result prompt alone also answered `run_reviewer`. The result matches macOS, and no result
  contradicts the adapter or the runtime. No Linux host was available, so Linux stays unverified.

  The agy adapter adopts the id the result carries. For a resumed turn whose id differs, it logs a
  warning and marks the state. A worker conversation then gets the preamble in a preamble-only
  turn. That turn costs one model call and is not charged as a step.

  Its prompt asks for no change, but the worker turn has no mutation check, so it can still
  write. The task prompt reaches the new conversation before the preamble. An orchestrator turn is
  rerun once with the initial instructions. That rerun costs one more model call and loses the
  earlier orchestrator turns.

- In the probe, Claude and agy printed no session id when killed at 20 to 25 s. A Claude first
  turn that ends that way keeps its pre-assigned id. An agy first turn keeps a null id.

  Issue #398 probed the kill cases that stayed open. The host was macOS 27.2 (arm64) with Node
  v26.11.1 and Git 2.56.0. The CLIs were Copilot CLI 1.0.96-2, agy 1.3.2, and Claude Code 2.1.296.
  Each probe ran in a disposable Git repository in the system temporary directory.

  A driver script spawned the CLI in its own process group and read stdout. It sent one signal to
  the CLI pid. It listed the process group 1.5 s later. Then it ended the group. Each resume used
  one prompt shape. The prompt asked for the word of the first prompt and the state of the tool
  call.

  - Copilot, id with no session: the command was `echo '<prompt>' | copilot --session-id <fresh uuid>
    -s --no-ask-user --output-format json`. The prompt asked for the word that the user told the
    model earlier. `NONE` was the answer for no word. The call exited 0 and answered `NONE`. The
    `result` event echoed the id. An id with no session creates a session.
  - Copilot, kill during a tool call: the command was the same call with `--allow-all-tools`. The
    prompt asked to remember `MANGO` and to run `sleep 60; echo hi`. The driver sent `SIGKILL`
    to the `copilot` pid 3 s after the first `tool.execution_start` event. Stdout held no
    `result` event. The session directory held `events.jsonl`, with one `user.message` event and
    one `tool.execution_start` event.

    The resume exited 0 and echoed the id in its `result` event. It answered `MANGO; no, the
    sleep command did not finish.`. At the time of the probe the adapter kept no id for this
    failure, so it dropped a session that resumes. ADR 0030 now keeps it (issue #642). The probe matches the Windows probe of issue
    #641.

  - Copilot, earlier kills with `sleep 61`: a kill 2.5 s after the start printed only MCP status
    events. It left a session directory with no `events.jsonl`. The resume answered `MANGO`. A
    kill 0.3 s after the start left no session directory. The resume answered `NONE`.

    A resume of an id with no session exits 0 and starts a session. A kept pre-assigned id
    therefore does not fail. It does lose the preamble.

  - Copilot, process cleanup: `copilot` is a shell shim. A kill of its pid left the native
    `copilot` process with parent pid 1. The tool shell and `sleep` also stayed alive with parent
    pid 1, in their own process group. The driver ended them by pid.
  - agy, kill during a tool call: the command was `agy --input-format text --output-format json
    --dangerously-skip-permissions`. The prompt on stdin asked to remember `PAPAYA` and to run
    `sleep 63; echo hi`. The driver sent `SIGKILL` 15 s after the start. Stdout was empty. Stderr
    read `root agent idle; waiting up to 30m0s for 1 background task(s)`.

    The transcript under `~/.gemini/antigravity-cli/brain/<id>/` shows a `run_command` step with
    status `RUNNING` as a background task. The file
    `~/.gemini/antigravity-cli/conversations/<id>.db` existed. The resume command was `agy
    --input-format text --output-format json --conversation <id>`. It exited 0 and returned the
    same `conversation_id`. It answered `The secret word is PAPAYA, and the sleep command did not
    finish because the background task stopped during a server restart.`.

    A kill during a tool call therefore leaves a conversation that resumes. The output names no
    id, so the adapter keeps null and cannot resume it. The `init` event of `--output-format
    stream-json` carries `conversation_id` before any step. A later change can read the id from
    that format. The `zsh` shell of the tool call stayed alive with parent pid 1. The driver
    ended it by pid.

  - Claude, id read from the output: the command was `claude -p --model haiku --allowedTools Bash
    --output-format stream-json --verbose`. The prompt asked to remember `GUAVA` and to run
    `node -e "setTimeout(function(){},64000)"` with the `Bash` tool. A first attempt with
    `sleep 64; echo hi` did not test a call that runs, because the tool blocked it (`Blocked:
    sleep 64 followed by: echo hi`). The driver sent `SIGKILL` 4 s after the `Bash` `tool_use`
    event. The `init` event printed the `session_id`, and the session file `<id>.jsonl` existed.

    The resume command was `claude -p --model haiku --resume <id> --output-format json
    --verbose`. It exited 0. Its `init` and `result` events carried the same id. The answer named
    `GUAVA` and said that the timer result was not recorded. The `zsh` shell of the tool call and
    its `node` child stayed alive with parent pid 1. The driver ended them by pid.

    The adapter uses `--output-format json`, which prints nothing before the end. The adapter
    relies on the pre-assigned id.

  - Result: no probe contradicts the adapter. The Copilot result repeats issue #642, which ADR 0030 resolves.
  - Claude, kill under `--output-format json`: issue #675 repeated the kill with the adapter
    output format. The host was macOS 27.2 (arm64) with Node v26.11.1 and Claude Code 2.1.296. The
    probe ran in a disposable Git repository in the system temporary directory.

    The command was `claude -p --allowedTools Bash --model haiku --output-format json --verbose
    --session-id <fresh uuid>`, with the prompt on stdin. The prompt asked to remember `GUAVA` and
    to run `node -e "setTimeout(function(){},64017)"` with the `Bash` tool. The driver sent
    `SIGKILL` to the `claude` pid 4 s after the `node` timer process appeared in its process tree.

    Stdout and stderr were empty, and the exit was by `SIGKILL`. The session file `<id>.jsonl`
    existed, with the prompt and two `assistant` records. The `zsh` shell of the tool call and its
    `node` timer stayed alive with parent pid 1. The driver ended them by pid.

    The resume command was `claude -p --model haiku --output-format json --verbose --resume
    <id>`. It exited 0. Its `init` and `result` events carried the same id. The answer named
    `GUAVA` and said that the timer outcome was not recorded.

    Limit: this probe called the CLI directly, and its prompt carried no ownership marker. The
    adapter appends `[agent-loop session <id> role <role>]` to a first-turn prompt. `ownsSession`
    requires that marker before the adapter resumes an unconfirmed id. The adapter refuses this
    probe session. A worker or reviewer turn then reruns as a first turn. An orchestrator turn
    has no rerun, so the run ends and the id keeps its mark.

    The probe shows that Claude Code resumes a session that `SIGKILL` left, and that the format
    prints no id. It does not show the adapter recovery path. The probes of issues #565 and #580
    covered that path through the adapter.

  - Copilot, kill of the native process: issue #675 repeated the Copilot kill with a signal to
    the native process. The host was macOS 27.2 (arm64) with Node v26.11.1 and Copilot CLI
    1.0.96-2 (native package `@github/copilot-darwin-arm64` 1.0.96-1). The `copilot` command is a
    shell script that runs a Node loader (`npm-loader.js`). The loader starts the native binary.

    The command was `copilot -s --no-ask-user --output-format json --allow-all-tools --session-id
    <fresh uuid>`, with the prompt on stdin. The prompt asked to remember `MANGO` and to run
    `sleep 61; echo hi`. The driver sent `SIGKILL` to the native `copilot` child of the loader
    pid, 3 s after the first `tool.execution_start` event.

    The loader exited with code 1, not by a signal, 0.2 s after the signal. Stdout held no
    `result` event. Stderr read `GitHub Copilot native binary at <path> was terminated by signal
    SIGKILL.` and a misleading second line, `GitHub Copilot CLI: no platform package found.
    Reinstall with ...`. The `bash` tool shell and its `sleep` stayed alive with parent pid 1 in
    their own process group. Both were still alive 8 s later, and the driver ended them by pid.
    The session file `events.jsonl` held `user.message` and `tool.execution_start` events and
    nothing after the signal.

    The resume used the same `--session-id`. It exited 0 and echoed the id in its `result` event.
    It answered `MANGO; the sleep command did not finish.`. The result matches the kill of the
    loader pid and the Windows probe of issue #641. ADR 0030 applies to this case. The tool shell
    that outlives the native process belongs to the cleanup gap that issue #679 probes.

  - Result of issue #675: no probe contradicts the adapter, so no bug was opened.
  - Not verified, other cases: no Linux host and no Windows host was available in issue #675.
    Linux stays unverified, and so does Windows for the agy and Claude kill cases. The Windows
    probe stays open for the Windows collaborator. A model error in the middle of a Copilot turn
    is out of scope (issue #642).

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
   issue #395 after a probe (decision 1). The Copilot adapter kept no pre-assigned id. The probes of issues #641
   and #398 later showed that a first turn killed after a tool call leaves a session under that id. ADR 0030
   keeps the id when the session holds a saved turn (issue #642).
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
- [Issue #398](https://github.com/andromarces/agent-loops/issues/398)
- [Pull request #663](https://github.com/andromarces/agent-loops/pull/663)
- [Issue #675](https://github.com/andromarces/agent-loops/issues/675)
- [Issue #564](https://github.com/andromarces/agent-loops/issues/564)
- [Issue #565](https://github.com/andromarces/agent-loops/issues/565)
- [Issue #580](https://github.com/andromarces/agent-loops/issues/580)
- Implementation: `keepFailedSessionId` and `flagMissingSession` in `src/agents/shared.mjs`,
  the adapters in `src/agents/` (the Claude pre-assigned id in `src/agents/claude.mjs`), `runFn` in `src/runtime.mjs`, the dispatch write in
  `src/role.mjs`, and the headless transcript write through `onSessionAssigned` in `src/runtime.mjs` and `src/cli.mjs`; documented in `README.md`
- Superseded by [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR 0030: Keep the pre-assigned id of a failed first Copilot turn that saved a turn](0030-keep-the-pre-assigned-id-of-a-failed-first-copilot-turn-that-saved-a-turn.md)
- [ADR Index](README.md)
