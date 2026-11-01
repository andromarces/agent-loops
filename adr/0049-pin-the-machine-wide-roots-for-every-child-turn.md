# 0049. Pin the machine-wide roots for every child turn

## Status

accepted

Partially supersedes [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md). This ADR replaces decision 2 (host state stays shared), which pinned the roots for a Codex child only. Every other decision of ADR 0047 holds.

## Date

2026-10-20

## Context

The runs root, the test-slot directory, and the session-record directory default to paths under `os.tmpdir()`. A child turn that sets `TMP`, `TEMP`, or `TMPDIR` before it runs `agent-loop test-slot` moves them, so its suite takes a slot that no other run counts. The machine-wide slot limit of ADR 0039, ADR 0040, and ADR 0046 then does not hold. The guidance for a short Windows temporary path (issue #903) leads a child to set such an override. An interactive Claude Code worker did so on 2026-10-20 (issue #970). Only a Codex child had the pins.

## Decision

1. **Every worker and reviewer spawn is pinned.** `exec` adds `AGENT_LOOP_RUNS_ROOT`, `AGENT_LOOP_TEST_SLOTS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` to the environment of a spawn with the role `worker` or `reviewer`. This covers every adapter (Claude Code, Codex, Copilot, OpenCode, and agy).
2. **One resolver.** `rootPins` in `src/lib/root-pins.mjs` resolves the three paths in the parent process. `exec` and the Codex private temporary directory both use it.
3. **User value wins.** A root that the user set to a non-empty value is not replaced, and an explicit `env` option of the caller wins over a pin. An empty value counts as unset. `stateRoot`, `slotsRoot`, and `sessionRecordsRoot` fall back to the `os.tmpdir()` default for an empty value, and the pins of ADR 0047 on `main` did the same. Keeping an empty value would let a `TMP` override in the child move the root again.
4. **Codex unchanged.** A Codex turn keeps its private temporary directory and its removal behavior (ADR 0047, decisions 1 and 3 to 7).
5. **npm debug logs off.** `exec` also sets `npm_config_logs_max=0` for a worker or reviewer spawn (issue #995). npm writes its debug logs to its cache, outside the work tree and any turn temporary directory, and the cleanup rule of a turn cannot remove them. A non-empty `logs_dir` or `logs_max` that the user or the caller `env` set, in any case, leaves the entry out, so a chosen directory still receives its logs. An empty value of any spelling counts as unset. The child environment holds exactly one spelling of each setting, `npm_config_logs_dir` or `npm_config_logs_max`, with the last non-empty value of the process and then the caller environment, so no empty alias masks a user value, and the default is `npm_config_logs_max=0` only when neither is held. `withNpmLogSettings` in `src/lib/exec.mjs` decides it, and `exec` passes the whole environment to the spawn for these roles.

## Consequences

- A child command that moves `TMP`, `TEMP`, and `TMPDIR` still takes its slot in the slot directory of the parent.
- A child that runs an `npm run` script leaves no file in the npm cache `_logs` directory. A failing npm command leaves no debug log to read, and the user can set `npm_config_logs_max` to get one.
- `exec` adds no pin to a spawn with another role, or none, and that spawn inherits the environment as before. A Codex turn of any role, the orchestrator included, still gets the pins from `withTurnTmpdir`.

## Verification

Issue #710 ran the live check on macOS 27.2 (26B123) at source head `5a33f11e03b4d7d5967c2ea6fdc41b7f5dee1788`, which includes `8f14f78`.

- Claude Code, Codex, OpenCode, and agy each ran one worker turn and one reviewer turn through `role dispatch` in a disposable Git repository.
- Each of those eight turns set `TMP`, `TEMP`, and `TMPDIR` to one other existing directory, then ran `test-slot --wait 120`.
- Each turn printed its TMP, TEMP, and TMPDIR values, the three parent roots, and the exact `test-slot` command it ran.
- Each held turn read its lock file and printed the owner pid, which equaled the pid of its own `test-slot` process.
- The lock nonce matched the marker nonce, and the parent slot directory listing held that lock file.
- The nested dispatch removed `AGENT_LOOP_TEST_SLOT_HELD`, and each child printed `child_slot_marker=<unset>`.
- The saved fields are `child_slot_marker`, `TMP`, `TEMP`, `TMPDIR`, `runs`, `records`, `slots`, `marker_lock`, `slot_owner`, `slot_owner_pid`, `shell_ppid`, `owner_match`, `slot_files`, and `test_slot_exit`.
- The CLIs were Claude Code 2.1.316, codex-cli 0.166.0, GitHub Copilot CLI 1.0.106-2, opencode v0.0.0-dev-466, and agy 1.4.12.
- The models were `haiku`, `gpt-6-luna` at low effort, `mai-code-1.1-flash`, `opencode-go/deepseek-v4.1-flash`, and `gemini-3.8-flash` at low effort.
- Copilot ran both turns, but the CLI refused each shell call with `Permission denied because no interactive user response was available`.
- Both Copilot envelopes carried `shellDenied: true`, which ADR 0035 records as the shell limitation.
- A comparison required the parent roots, a moved `TMPDIR`, no inherited marker, and a lock owned by the turn.
- Mutants for a wrong runs root, a lock owned by another pid, and an inherited marker each failed all eight turns.
- Eight of the ten turns matched, and the two Copilot turns did not run the probe.
- No result contradicts this ADR, so no bug was opened.

## Alternatives

1. **Render the wrapper command with an explicit `AGENT_LOOP_TEST_SLOTS_ROOT`.** Not taken. It covers the slot directory only, not the runs root or the session-record directory.
2. **Set `npm_config_logs_dir` to the Codex private temporary directory (issue #995).** Not taken. Only a Codex turn has that directory, so the other adapters would still leave logs.
3. **Pin inside each adapter.** Not taken. Five call sites repeat one rule, and a new adapter can miss it.

## Authors

Andro Marces

## Links

- [Issue #970](https://github.com/andromarces/agent-loops/issues/970)
- [Issue #995](https://github.com/andromarces/agent-loops/issues/995)
- [Issue #710: Verification checklist: live runs](https://github.com/andromarces/agent-loops/issues/710)
- [PR #996](https://github.com/andromarces/agent-loops/pull/996)
- [PR #973](https://github.com/andromarces/agent-loops/pull/973)
- [PR #1338](https://github.com/andromarces/agent-loops/pull/1338)
- Implementation: `rootPins` in `src/lib/root-pins.mjs`, `exec` and `withNpmLogSettings` in `src/lib/exec.mjs`, `withTurnTmpdir` in `src/lib/turn-tmpdir.mjs`; tests in `tests/lib/exec.test.mjs`; documented in `docs/orchestrator-instructions.md` and `docs/reference/architecture.md`
- [ADR 0039: Machine-wide test slot](0039-machine-wide-test-slot.md)
- [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md)
- [ADR Index](README.md)
