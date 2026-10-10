# 0030. Keep the pre-assigned id of a failed first Copilot turn that saved a turn

## Status

accepted

Supersedes decision 2 of [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md). ADR 0027 stays `accepted`, because its other decisions hold. Both ADRs record the partial supersession.

## Date

2026-10-10

## Context

ADR 0027 decision 2 keeps only an id that the result event of a failed first Copilot turn reports. It never keeps the pre-assigned `--session-id`, because a failure that reports no id does not show that a session exists.

The probe of issue #641 showed the gap. A first turn that ran a tool and ended with no result event left a session under the pre-assigned id. A resume of that id held the turn: it recalled the codeword and the exact shell command (Copilot CLI 1.0.95 and 1.0.96-2, Windows 11). The adapter kept no id, so the next turn started a new session and repeated the role preamble. The session that held the failed turn was lost.

Issue #642 asks to keep that id without keeping a stale one. Claude solves the same problem with `sessionUnconfirmed`: a pre-assigned id stays until an ownership check, and a missing session reaches the missing-session fallback of ADR 0016. Probes on 2026-10-10 (Copilot CLI 1.0.96-2, Windows 11 Pro 10.0.26220, `COPILOT_HOME` unset, so the store is `~/.copilot/session-state/<id>/`):

| Failure                                                                    | Result event | Session directory                                                                                                   |
| -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `--model` names an unavailable model (also 1.0.90-4 in issue #375)         | none         | `workspace.yaml`, `checkpoints/`, `files/`, `research/`. No `events.jsonl`.                                         |
| `--reasoning-effort xhigh` on a model that does not support it             | none         | The same. No `events.jsonl`.                                                                                        |
| The process ended before the prompt was recorded (timeout 3 s to 7 s)      | none         | The adapter kept no id, and a direct kill at 1.5 s to 12 s wrote no `events.jsonl`.                                 |
| A timeout after the prompt was recorded (adapter run, timeout 9 s to 13 s) | none         | The adapter kept the pre-assigned id. A kill after a tool call also left `events.jsonl` with `user.message` (#641). |
| A completed turn                                                           | `result`     | `events.jsonl` with `session.start`, `user.message`, `assistant.message`, and `session.shutdown`.                   |

A bad model or an unsupported effort creates the session directory but no turn. The directory alone cannot show that a session holds a turn. `events.jsonl` with a `user.message` event can.

The adapter reads `events.jsonl` once, right after the child process ends. Issue #679 probed that timing against a CLI that still writes the session. The host ran Copilot CLI 1.0.96-2 on macOS 27.2 (Apple silicon) with Node.js 26.11.1. `COPILOT_HOME` was unset. The probe ran on 2026-10-10.

The probe made 56 runs through `runCopilot`. Each run used a fresh role state, a scratch git repository under the system temporary directory, and a separate `AGENT_LOOP_RUNS_ROOT`. The probe killed no process.

After each return, the probe listed the processes that had the scratch repository as working directory. It also read the event types of `events.jsonl`. The probe changed during the work, so two schemes apply. The first 11 runs (timeouts of 1 s to 20 s) took the first listing and read at once after the return. Their labels `t+2s` and `t+10s` count from that first listing.

The last 45 runs polled the process list and the event types every 100 ms from the return, for 1.5 s to 5 s. Their labels `t+0`, `t+2s`, and `t+10s` count from the end of that polling. They fell at least 1.5 s, 3.5 s, and 11.5 s after the return.

A separate list came from the start of each run. It was taken 0.7 s before the configured timeout or cancel time (0.5 s after the start for the 1 s timeout). No label counts from the kill. Three earlier runs, made while the probe was built, are not counted.

The table lists the 53 failed first turns by the file that the CLI left. They are 48 timeouts from 1 s to 16 s and 5 cancels from 3 s to 12 s. Three timeouts and one cancel ran with `COPILOT_ALLOW_ALL=1`. Three more turns finished before the timeout fired. They kept a confirmed id and held `user.message`.

| File after the failed turn                                                 | Timeouts | Cancels | Adapter id         |
| -------------------------------------------------------------------------- | -------- | ------- | ------------------ |
| No `events.jsonl`                                                          | 21       | 1       | none kept          |
| `session.start` and `session.shutdown` only                                | 1        | 0       | none kept          |
| `user.message` and an `abort` event, before any `session.shutdown`         | 22       | 3       | kept               |
| `user.message` and a finished turn, with no `abort` event                  | 1        | 1       | kept               |
| `user.message` listed after `session.shutdown` (1 file also holds `abort`) | 3        | 0       | kept by file check |

The adapter kept an id in exactly the 30 runs whose final file held `user.message`, and in none of the other 23. It took 27 of the 30 ids from the result of the failed output. It took the 3 others from the file check, and it marked them `sessionUnconfirmed`. A timeout of 4.9 s to 5.15 s after the spawn gave both outcomes. The final file held an `abort` event in 26 of the 53 runs.

The event types of the file did not change after the first read in any of the 56 runs. In the first 11 runs, the three reads were equal. In the last 45 runs, no poll differed from the first read, and the three later reads were equal. The probe compared event types, not bytes. It did not read the file at the instant of the adapter read. A change between that read and the first probe read is not excluded.

The list from the start of each of the 53 failed runs showed the `node` shim and the native `copilot` process. It also showed MCP server children in 49 runs. The first listing after the return listed a process in 5 runs. In 4 of them the process ended before `ps` read its data, so those 4 stay unidentified in the saved results. The fifth ran from the `codegraph` package, an MCP server that the live list shows under the native `copilot` process. It had parent pid 1.

Every later listing, in all 56 runs, listed no process of the scratch repository. The last listing came 10 s after the first listing in runs 1 to 11. It came at least 11.5 s after the return in runs 12 to 56. In the 4 polled runs with a first-listing process, the first empty listing finished within 0.25 s of the return. In the unpolled run, the next listing came 2 s after the first.

A second probe of 48 timeouts (5 s, six runs in parallel) identified those processes. It tagged each run through an inherited environment variable. It kept only pid, parent pid, elapsed time, and executable name. For the last 24 runs it also kept whether the command line named `codegraph`.

The first listing finished 26 ms to 45 ms after the return. It listed one process named `node` with parent pid 1 in 11 of the 48 runs. In the 24 classified runs, 4 such processes appeared, and all 4 named `codegraph`. The next listing finished 79 ms to 105 ms after the return and listed none in any run. No listed process had the executable name `copilot`.

The probe found no Copilot process that outlived the turn, so it opens no bug under issue #679. The only process after the return was a `codegraph` MCP server that ended within 0.1 s. The unidentified processes of the first probe are not settled by the saved results. The second probe saw only that MCP server in the same load. It does not exclude a write by a process that lived only between the adapter read and the first listing.

With `COPILOT_ALLOW_ALL=1`, the `sleep` shell was in the list from the start of 3 runs, taken 0.7 s before the configured time. The first listing after the return listed no process in those 3 runs. The live process of issue #398 was not reproduced through the adapter, because that probe killed the shim pid alone.

Limits of the probe: the adapter passes no `--allow-tool` flag, so the shell tool is denied and no tool shell started without `COPILOT_ALLOW_ALL=1`. On a loaded host, 2 timeouts returned 3.5 s and 3.6 s late. Both listed `user.message` after `session.shutdown`. The probe tested no other host and no other CLI version.

A model error in the middle of a model call could not be produced on this host. Its stream ends with no result event, like a kill, so the same file check decides it. The test covers it with an error event in the failed output.

## Decision

1. The Copilot adapter keeps the pre-assigned id of a failed first turn when the child process started, the output reported no id (the `sessionId` and `session_id` fields of the last result event are absent or null), and the session of that id holds a saved turn. "Holds a saved turn" means that `<COPILOT_HOME or ~/.copilot>/session-state/<id>/events.jsonl` is a regular file whose first 256 KiB holds a `user.message` event. The id must be a canonical lowercase UUID. The same rule covers an exit 0 whose output has no result event or no result session id field. A valid reported id wins and is never marked. An id that the output reports but that is empty or not a string is invalid, and it stores nothing, as ADR 0027 decision 1 requires: a failed selection stores nothing on a first turn. The pre-assigned id is not kept then, even when a turn was saved, because the output named a session that the adapter cannot read.
2. The adapter marks a kept pre-assigned id `sessionUnconfirmed`. A result event, or a failed result, clears the mark only when it reports the id that the role state holds. A result that reports another id leaves the kept id and its mark, so a later resume still runs the check, and a successful result of another id raises `resumeMismatchError` as before. A turn that kept the id does not change it later.
3. A resume of an unconfirmed id first runs the same check. When the session holds no turn, the adapter clears the mark and raises an error with `sessionMissing` before any CLI starts, so the runtime reruns the turn as a first turn with the role preamble, as for Claude and Codex (ADR 0016 and ADR 0027 decision 4). A confirmed id resumes with no check.
4. The check follows the Claude ownership check on links. The session directory `session-state/<id>` must be a real directory, `events.jsonl` must be a regular file, and the open uses `O_NOFOLLOW` where it exists. A symlinked or junctioned session directory and a symlinked events file read as no saved turn, so the resume raises `sessionMissing`. Claude checks the project directory and the session file the same way. The adapter does not check the `session-state` directory itself or `COPILOT_HOME`, which the operator controls, and Claude does not check its `projects` directory either. The adapter does not bind the session to a work tree, which the Claude check does with the marker (see Alternatives 4).
5. A failure that saved no turn keeps no id, as before. A process that never started keeps none, even when a session file exists under the id.
6. ADR 0027 decision 2 no longer holds. The other decisions of ADR 0027 hold.

## Consequences

- The next worker turn after a failed first turn that ran a tool resumes the saved session and sends no second preamble. A bad model or an unsupported effort keeps none and the next turn carries the preamble.
- The check proves that a turn exists under the id, not that this run created it. The id is a fresh random UUID that only the role state records, so a clash is not expected. The marker and work tree check that Claude uses (ADR 0016) are not repeated.
- The check reads one file head per unconfirmed resume and once per failed first turn, and logs nothing of its content.
- A session store outside `COPILOT_HOME` or `~/.copilot` reads as holding no turn. A failed first turn then keeps no id, and an unconfirmed id reruns as a first turn. The loss is one repeated preamble.
- The mark reaches `--continue-from` and the transcript through the existing role-state handling. The headless loop writes no pre-spawn record for Copilot, because the adapter has no `onSessionAssigned` hook.

## Alternatives

1. **Keep the pre-assigned id of every failed first turn**: rejected. A bad model leaves a session directory with no turn, and the next turn would skip the preamble in a session that never saw it.
2. **Keep the id when the session directory exists**: rejected for the same reason. The bad-model probe creates the directory.
3. **Keep the id and let the next turn discover a missing session**: rejected. Copilot resumes any `--session-id` with a new session and no error, so no missing-session signal exists after the spawn.
4. **Append a marker line to the first prompt, as Claude does**: rejected for now. It changes every Copilot first prompt, and the random id already makes a clash unlikely. The upgrade is the marker check, if a clash is ever seen.

## Authors

Andro Marces

## Links

- [Issue #641](https://github.com/andromarces/agent-loops/issues/641)
- [Issue #642](https://github.com/andromarces/agent-loops/issues/642)
- [Issue #397](https://github.com/andromarces/agent-loops/issues/397)
- [Issue #679](https://github.com/andromarces/agent-loops/issues/679)
- [Pull request #668](https://github.com/andromarces/agent-loops/pull/668)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR 0016: Resume the session of a failed first turn, with a fallback to a new session](0016-resume-a-failed-first-turn-with-a-fallback.md)
- Implementation: `holdsTurn` and `runCopilot` in `src/agents/copilot.mjs`; tests in `tests/agents/copilot.test.mjs`. Documented in `README.md`.
- [ADR Index](README.md)
