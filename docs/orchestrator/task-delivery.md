# Init task delivery

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a turn reports a replacement conversation, a missing session, a cancel, or a task-only turn.

The init task (`--task` or `--task-file`, which refuses an empty file) reaches each child conversation once. The first turn of a
conversation shows the task under its own `Init task:` label, before `Instructions:`.

- The role state records `taskSentTo`, the session id of the conversation that last carried the task. A turn
  shows the task when that id differs from the session id it runs in, or when the role has no session id.
- A role with no session id starts a new conversation. That happens on the first turn and after a first turn
  that failed before its CLI reported a session. It also happens on a rerun after a missing session ([Work tree ownership](../orchestrator-instructions.md#work-tree-ownership)).
- A turn that carries the task records the session id that its CLI returns. That id can name a replacement
  conversation, which received the whole prompt.
- A resumed turn that ran in a replacement conversation carries no task, so it records nothing. A task-only
  turn in the same dispatch then delivers it: the preamble-only turn for a worker, and a turn with the
  `Init task:` block and no review for a reviewer.
- A cancel never repeats the task. After a cancel, the next worker turn sends the preamble again, as before.
  It leaves the task out when the record names the session that it resumes.
- Every adapter (Claude Code, Codex, Copilot, opencode, agy) fails a turn that reports no session id. A
  successful turn therefore always stores one.
- Known limit: a canceled turn that carried the task counts as delivered. The CLI can drop that prompt. That
  conversation then never sees the task.
- A hard kill of the dispatch records no delivery, so the next turn can send the task again.
- The task-only reviewer turn costs one extra child turn in the same dispatch. It runs under its own
  read-only check, apart from the review turn, so a write in either turn halts the run. The replacement has
  the task before the verdict counts toward a finish.
- A task-only reviewer turn that fails, other than by a cancel, records no delivery, and the whole reviewer
  dispatch is an error result with no verdict. `finish --require-accept` then refuses, and the next reviewer
  turn shows the task.
- A task-only turn that runs in yet another conversation delivers the task there and records that
  conversation, so the next turn does not repeat it. The dispatch is an error result with no verdict,
  because the conversation that gave the verdict never had the task.
- A cancel in the task-only turn follows the known limit above: it counts as delivered, so the resumed
  reviewer turn does not repeat the task. The cancel keeps the replacement mark, and the dispatch gives no
  verdict.
