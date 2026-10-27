# Turn history and the step budget

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when you rebuild a run after compaction or restart, or when a stored `maxSteps` or sandbox mode is out of range.

## Turn history

Every `agent-loop role` run keeps its own turn history. No `--transcript` flag is
needed: the subcommand records each dispatched turn itself.

- The state file's `turns` array holds one entry per charged step, in order, and
  each entry survives every later dispatch that overwrites `lastDispatch` and
  `lastResult`.
- Each entry holds `role`, `status`, `verdict`, `head`, and `at`: the role that
  ran, the turn `status`, the reviewer verdict for a reviewer turn (`null`
  otherwise), the head the reviewer turn reviewed (`null` otherwise), and the
  turn time. Report and response text stay out of the entries.
- `status` is `ok`, `error`, or `interrupted`. An `interrupted` entry is a turn
  whose step was charged but whose outcome is unknown: no child result was ever
  recorded for it, so its verdict and head are `null`. The call that marks the
  run `interrupted` records it, so the history stays complete across recovery.
- Size bound: exactly one entry per charged step, and a dispatch past `maxSteps`
  is refused before it runs, so `turns` holds at most `maxSteps` entries. The
  recovery call runs no child, records an already-charged step from the `lastDispatch`
  role and time of that turn, and charges none of its own, so
  it does not push the history past that bound. The entries are fixed-shape, so
  the history cannot grow with the text a child returns.
- `budgetChanges` holds one entry per `role extend`: `from` and `to` (the old
  and new `maxSteps`), `stepsUsed` when the change ran, and `at`. A `<count>` outside
  the rule that [Blockers and terminal states](../orchestrator-instructions.md#blockers-and-terminal-states)
  states is refused and the state file stays unchanged. The call prints
  `{"status": "ok", "lifecycle": "active", "maxSteps": 40, "stepsUsed": 20}`. It shows after
  which turn the budget changed (ADR 0014). A run never extended has no `budgetChanges`.
  Because `maxSteps` only grows, `turns` still holds at most `maxSteps` entries.
- Accepted `--max-steps` range: 1 to 9007199254740991 (`Number.MAX_SAFE_INTEGER`).
  The CLI refuses a `--max-steps` outside it, and `dispatch`, `finish`, and
  `extend` re-check the stored `maxSteps` against the same range before reading the
  budget, because a state file written by an earlier version or hand-edited
  carries the value past the flag check. A refusal names the state file field to
  correct. Every budget a run reads is therefore a safe integer, so the step
  count always advances by exactly one per charged step.
- `abort` is not subject to that check. It charges no step and reads no budget,
  so it proceeds and ends the run. Use it to close a run whose stored `maxSteps`
  is out of range: `dispatch` and `finish` are refused, and a new init refuses
  over a non-terminal run, so `abort` is the only route to a terminal lifecycle
  for such a run. A new init then starts normally and archives the old state
  file. No field has to be hand-corrected.
- `abort` is not subject to the recorded reviewer sandbox mode check either (ADR 0038). `dispatch`,
  `--resume-interrupted`, `extend`, and `finish` refuse a state file whose
  `reviewerSandbox` is present but not `none`, `read-only`, or `workspace-write`. `abort` runs
  no reviewer turn, so it ends such a run, and it ignores a `--reviewer-sandbox` flag that it
  cannot compare with the damaged field. Over a valid mode, `abort` still refuses a flag that
  names another mode.
- Read `turns` after compaction or restart to rebuild which turns ran, which
  verdicts they returned, and which head each reviewer turn saw.
- `--transcript <file>` still appends one JSON line per `invocation` and
  `result` event. It stays a per-call flag and is not the turn history.
