# 0072. Keep the orchestrator command tree gap after a headless parent SIGKILL

## Status

accepted

## Date

2026-11-02

## Context

Issue #1333 records a macOS probe of issue #708. A headless run with an `opencode` orchestrator ran `sh ./check.sh` in a disposable Git repository. The committed script ran `sleep 60` and then wrote `orphan-write-orch.txt`. The driver sent `SIGKILL` to the parent 6957 ms after the spawn. The parent exited with the signal 4 ms later.

At 1.581 s after the exit, the opencode CLI, its server, and the shell tree all ran. The write landed 59935 ms after the signal. No transcript existed at the signal or at the end of the watch.

ADR 0027 records the orphan behavior of a killed parent. ADR 0071 ends the descendants of a Codex child on a POSIX `SIGTERM` or `SIGINT`. It records that a `SIGKILL` of the parent runs no handler. ADR 0031 decision 7 rejects an end signal to a process that the current run did not start. ADR 0037 alternative 2 rejects a watchdog process that reports a vanished dispatcher.

The probe holds the shell rows `23328 14967 23328 sh ./check.sh` and `23329 23328 23328 sleep 60`. The shell tree led its own process group, outside the group of the opencode CLI. The probe does not record whether the opencode server descends from the CLI child.

Issue #1339 repeats the probe with a `SIGTERM` and with one `SIGINT`, on macOS 27.2 (arm64), Node v27.0.0-alpha.0.0.0, opencode v0.0.0-dev-466, and repository head `cc5ed5d6`. Each run used model `opencode-go/deepseek-v4.1-flash`, a committed `check.sh` that sleeps 60 s and then writes `orphan-write.txt`, and a disposable Git repository. The shell led its own process group in both runs. The opencode server was a child of the CLI child, in its own process group.

The probe records these results.

- `SIGTERM`: the signal was sent at `2026-11-01T21:09:37.872Z`, and the parent exited with the signal 4 ms later.
- `SIGTERM` liveness: the CLI child, the server, the shell, `sh ./check.sh`, and `sleep 60` were live at the signal. All eight rows were dead 1.5 s after the signal, and no `orphan-write.txt` appeared within 75 s.
- `SIGINT`: the signal was sent at `2026-11-01T21:11:17.609Z`, and the parent exited 130 in 458 ms.
- `SIGINT` liveness: the same rows were live at the signal and dead 1.5 s after it. No `orphan-write.txt` appeared within 75 s.
- Server ancestry, `SIGTERM`: CLI child 39788 (parent 39681, group 39788). Server 39806 (parent 39788, group 39806). Shell 40324 (parent 39806, group 40324). `sh ./check.sh` 40325, and `sleep 60` 40326.
- Server ancestry, `SIGINT`: CLI child 42160 (parent 42053, group 42160). Server 42178 (parent 42160, group 42178). Shell 42739 (parent 42178, group 42739). `sh ./check.sh` 42740, and `sleep 60` 42741.
- Mutant: a `SIGKILL` of the parent from the same driver left all eight rows live 1.5 s after the signal. The shell wrote `orphan-write.txt` 59943 ms after that signal.

## Decision

1. The runtime adds no end for an orchestrator command tree after a `SIGKILL` of the headless parent. The gap stays. A `SIGKILL` runs no handler, so no parent code can end the tree.
2. The runtime does not detect the command tree on the next run. A stored group id can name a reused group. An end signal to that group reaches a process that the run did not start (ADR 0031 decision 7). A refusal needs a liveness check that no record supports (ADR 0020).
3. The operator check of ADR 0034 decision 4 covers an orchestrator turn. After a parent end by a signal other than `SIGINT`, the operator checks for a surviving orchestrator process or shell child. The operator also checks the state of the work tree before the next run. The check is stated in [Continue a run](../docs/reference/usage.md#continue-a-run).
4. Every adapter keeps its current behavior. The Codex child keeps the ADR 0071 tree end on `SIGTERM` and `SIGINT`. The other adapters, including `opencode`, keep the execa process-group end.
5. The decision has no test, because the code does not change. The acceptance allows this: the ADR records why the gap stays.
6. The `opencode` adapter keeps the execa process-group end. The probe records no live command tree or opencode server 1.5 s after a parent `SIGTERM` or `SIGINT`. It records no orphan write within 75 s of the signal. The runtime adds no `treeEnd` to the `opencode` child, and the code does not change.

## Consequences

- A command of an orchestrator turn can write to the work tree after a `SIGKILL` of the parent. The runtime reports nothing for it.
- The probe recorded no transcript at the signal or at the end of the watch. The killed parent wrote no result, so no clean tree report preceded the write in that probe.
- A `SIGINT` of the parent still runs `cancelOnSigInt`, and a second `SIGINT` still ends the live trees (ADR 0033). A `SIGTERM` received by the parent still runs the ADR 0071 walk for the Codex child. An `opencode` child keeps the execa group signal.
- Reopen this decision on one of three events. A portable parent-death signal exists for the adapters. The runtime starts a supervisor that ends with the parent. A probe records a live `opencode` command tree after a parent signal other than `SIGKILL`.
- Not verified: Linux and Windows. The macOS probe of issue #1339 verifies a `SIGTERM` and one `SIGINT` of an `opencode` parent with a shell tree, and the server ancestry. The issue #708 item `macOS or Linux: SIGTERM or SIGINT a live opencode orchestrator parent with a shell command tree` records the macOS result.
- A parent `SIGTERM` or one `SIGINT` of an `opencode` orchestrator leaves no command tree or server on macOS. The operator check of ADR 0034 decision 4 still covers a `SIGKILL`, Linux, and Windows.

## Alternatives

1. **End the tree on `SIGKILL`**: rejected. The kernel runs no handler for the signal.
2. **Start a supervisor that ends the tree when the parent dies**: rejected. It adds a second process with its own orphan and cleanup class (ADR 0037 alternative 2). A port must work on macOS and Windows.
3. **Detect and end the tree on the next run**: rejected by ADR 0031 decision 7. The runtime signals a process that it did not start in this run.
4. **Detect and refuse the next run**: rejected. A stored group id can name a reused group. The next run can start after the late write, so the refusal adds no bound.
5. **Kill the process group of the parent**: rejected. The probe tree led its own group, so a group signal never reaches it.
6. **Use `PR_SET_PDEATHSIG` or a cgroup**: rejected. Node exposes neither. `PR_SET_PDEATHSIG` is Linux-only, and the probe host is macOS.
7. **Extend the ADR 0071 walk to the `opencode` adapter**: deferred. The probe signal was `SIGKILL`, so the walk never runs on that path. The probe records no parent link from the opencode server to the CLI child. Reopen it with the issue #708 probe of an `opencode` parent signal and its server ancestry.

## Authors

Andro Marces

## Links

- [Pull request #1336](https://github.com/andromarces/agent-loops/pull/1336)
- [Issue #1333: An orchestrator command writes to the work tree after the headless parent is killed](https://github.com/andromarces/agent-loops/issues/1333)
- [Issue #1339: Extend the ADR 0071 tree end to the opencode orchestrator if its command tree outlives a parent signal](https://github.com/andromarces/agent-loops/issues/1339)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [Issue #1326: End the Codex reviewer command tree on POSIX after a parent signal](https://github.com/andromarces/agent-loops/issues/1326)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR 0031: Refuse --continue-from and --resume-interrupted while a live process holds a Claude session](0031-refuse-continue-from-and-resume-interrupted-while-a-live-process-holds-a-claude-session.md)
- [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md)
- [ADR 0034: Keep the Codex reviewer descendant gap after a parent end](0034-keep-the-codex-reviewer-descendant-gap-after-a-parent-end.md)
- [ADR 0037: State the process rule in child prompts and add no dead-child report](0037-state-the-process-rule-in-child-prompts-and-add-no-dead-child-report.md)
- [ADR 0071: End the Codex reviewer command tree on POSIX after a parent signal](0071-end-the-codex-reviewer-command-tree-on-posix-after-a-parent-signal.md)
- Implementation: none.
- Tests: none. See decision 5 and decision 6.
- [ADR Index](README.md)
