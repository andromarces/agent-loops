# 0019. Opt in to a workspace-write sandbox for the Codex reviewer

## Status

accepted

Supersedes [ADR 0001: Hybrid orchestrator with deterministic runtime](0001-hybrid-orchestrator-runtime.md). The decisions of ADR 0001 that still hold are restated below, with one change: a reviewer turn is read-only by default, and an operator can opt in to `workspace-write`.

## Date

2026-10-05

## Context

A Codex reviewer turn runs with `-c sandbox_mode="read-only"`. ADR 0001 states two-layer read-only enforcement for reviewer and orchestrator turns: a CLI sandbox or plan flag, and the pre and post Git snapshot in `withMutationCheck`. An opted-in reviewer turn drops the first layer, which materially changes that decision, so this ADR supersedes ADR 0001. Under that sandbox the reviewer cannot run a targeted test or an ad-hoc probe. ADR 0017 supplies the result of a whole `--test-cmd` run instead, and issue #421 asks for the upgrade path for the need that ADR does not cover.

Direct probes, macOS, codex-cli 0.162.0-alpha.9 (issue #421, 2026-10-04) and 0.162.0-alpha.14 (2026-10-05):

- `read-only`: `pnpm exec vitest run` fails with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`, `./node_modules/.bin/vitest run` fails with `EPERM` on `node_modules/.vite-temp`, and `gh pr checks` cannot reach `api.github.com`.
- `workspace-write` with network on: `pnpm exec vitest run` fails with `ERR_PNPM_PRIVATE_INSTALL_CREATE`, because pnpm writes to its store outside the work tree. `./node_modules/.bin/vitest run` exits 0 with the same counts as an unsandboxed run, and `gh pr checks` lists the checks.
- `workspace-write` with `sandbox_workspace_write.network_access=false` (2026-10-05): `./node_modules/.bin/vitest run` exits 0 (66 files passed, 1 skipped; 1249 tests passed, 8 skipped), and the shell commands `curl https://api.github.com` and `gh pr checks` fail to connect (`Could not resolve host`, `error connecting to api.github.com`). The work tree stayed clean. Only shell commands were probed. The Codex `web_search` tool ran under `read-only` in the 2026-10-04 probe, because it is a model-side tool that the sandbox does not cover, and no model-side tool or connector was probed under `workspace-write`.
- `workspace-write` with no `network_access` setting on the command line (2026-10-05): `curl` returned HTTP 200 and `gh pr checks` listed the checks. The user Codex config on that machine sets `[sandbox_workspace_write] network_access = true`, so the mode inherits network from the user config.

Live probe of the merged adapter, macOS 27.2 arm64, codex-cli 0.163.0-alpha.5, Node v26.11.1, repository commit `76bb63c` (issue #499, 2026-10-10). Each turn ran through `agent-loop role dispatch --role reviewer --reviewer codex --reviewer-workspace-write` against a disposable clone in the system temporary directory, with `./node_modules/.bin/vp` as the project's local test binary. The reviewer reported the test and network results. The `role dispatch` call gave the exit code and the message of the halted run.

- The reviewer ran `./node_modules/.bin/vp test run tests/lib/args.test.mjs` (exit 0, 4 passed). It also ran a Node child spawn (`execFileSync` of `process.execPath`, exit 0, printed `child-ok`).
- A second turn ran the full suite with `./node_modules/.bin/vp test run`: exit 0, 82 files passed and 1 skipped, 1884 tests passed and 17 skipped. The same suite outside the sandbox gave 1892 passed and 9 skipped.
- The 8 extra skips are the `tests/lib/runstate.test.mjs` tests that skip when `ps` cannot run on macOS. The probe of issue #640 below confirms that the sandbox blocks `ps`.
- The test runner spawned its workers and its child processes under the sandbox.
- A shell `curl https://api.github.com` failed with exit 6 and `Could not resolve host: api.github.com`. The explicit `network_access=false` setting held. Only shell commands were probed, as before.
- A reviewer shell command appended a line to `README.md`. The `role dispatch` call then exited 1 with `Mutation detected during reviewer turn: README.md`, which is the `MutationError` message. The edit stayed on disk.
- Not verified: Linux, Windows (unelevated and elevated), and any model-side tool or connector under `workspace-write`.

Live probe of `ps`, `pnpm exec`, and `gh`, macOS 27.2 arm64, codex-cli 0.163.0-alpha.5, Node v26.11.1, repository commit `d9930d7` (issue #640, 2026-10-10). The setup is the same as above: `agent-loop role dispatch --role reviewer --reviewer codex --reviewer-workspace-write` against a disposable clone in the system temporary directory. The reviewer ran each command as its own shell call and reported the exit code and the output. `CODEX_HOME` pointed at a directory with no `rules/` and only `[sandbox_workspace_write] network_access = true` as config, so the probe saw the sandbox of the adapter alone (see the note on user rules below). Two turns gave the same results.

| Command                       | Exit | Decisive output                      |
| ----------------------------- | ---- | ------------------------------------ |
| `ps -p $$ -o pid=`            | 127  | `zsh:1: operation not permitted: ps` |
| `ps -p 1 -o pid=`             | 127  | `zsh:1: operation not permitted: ps` |
| `ps -o lstart= -p 1`          | 127  | `zsh:1: operation not permitted: ps` |
| `pnpm exec vp --version`      | 0    | `vp v1.1.0`                          |
| `gh pr checks 637 --required` | 1    | `error connecting to api.github.com` |

- The sandbox blocks `ps`. This is why the 8 `ps`-gated tests skip. The `darwin-lstart` stamp is therefore never read in a sandboxed reviewer turn, and the lock check there falls back to the pid-only check.
- `pnpm exec vp --version` runs under `workspace-write`. Only `--version` was probed. The 2026-10-05 probe above still holds that `pnpm exec vitest run` fails when pnpm writes to its store outside the work tree, and that was not run again.
- `gh` cannot reach `api.github.com` with shell network off. This matches the `curl` result: `curl` exited 6 with `Could not resolve host: api.github.com`. A shell `gh` call cannot read check status here, so the runtime read of ADR 0011 stays the source.
- The work tree stayed clean.
- User rules can run a command outside the sandbox. The Codex config on the probe machine has an execpolicy rule (`~/.codex/rules/default.rules`) that allows `bash -c`, `sh -c`, and `zsh -c`. A command that Codex cannot split into plain words, for example one with `$$`, `$?`, or `$HOME`, runs through that wrapper and skipped the sandbox. With that config, `ps -p $$ -o pid=` exited 0, `touch "$HOME/<file>"` created a file outside the work tree, and `gh pr checks` and `curl` reached the network when a `; echo "exit=$?"` followed them. The same commands without an expansion were blocked. This is a property of the user config, not of the adapter. The explicit `network_access=false` and the mutation check do not see it for a write outside the repository (gap 2). Not verified on other machines.
- Not run: Linux and Windows. The task has only a macOS host.

The headless orchestrator has three guards that this change leaves in place: `readOnly: true` on the first and the repair turn in `decide`, the Codex `read-only` flag that follows from it, and the `withMutationCheck(cwd, "orchestrator", ...)` wrapper in `orchAdapter`. The adapter and `runChild` shared one `readOnly` boolean, so the opt-in needs a separate reviewer-only input.

## Decision

1. `--reviewer-workspace-write` is an optional boolean run input on both paths that run reviewer turns: a headless option, and an init flag of `agent-loop role`. It is off by default, and a run without it keeps its invocation, prompt, state file, and transcript. It is refused unless `--reviewer codex`, because only the Codex adapter reads the sandbox input, and any other reviewer would run read-only while the prompt said otherwise. The refusal comes at parse time on the headless path and at init on the interactive path, before any state is written.
2. **Init-field rules.** The interactive path stores `reviewerWorkspaceWrite: true` in the state file, and only when on. A later call that omits the flag reads the stored value. A later call that repeats the flag on a run that stored it is accepted. A later call that passes the flag on a run that did not store it is refused: `--reviewer-workspace-write cannot be changed after init`. No flag turns it off after init. A child process with write access to the runs root can edit the state file, as it can edit `cwd` and `pr`, so the stored value is not a barrier against a process that already holds that access.
3. **Shell network stays off.** The opt-in passes `-c sandbox_workspace_write.network_access=false` explicitly, and the reviewer prompt says that the shell commands of the turn have no network. The setting covers the shell commands that the sandbox runs.
   - It does not block a model-side tool such as `web_search`, or any other channel outside the sandbox, for example a GitHub app connector. No document or prompt of this change claims it does.
   - The explicit value is required: the 2026-10-05 probe showed that `workspace-write` inherits network from the user Codex config.
   - The network-on form is the one that issue #421 probed, and it lets `gh` read check status. It also opens the shell remote-write path of gap 3 below, which the prompt rule of issue #422 covers by advice only.
   - The runtime already reads the required-check status for a declared PR (ADR 0011), so the reviewer does not need `gh`. The opt-in buys local tests and probes without the shell remote-write path. A network-on variant needs its own decision.
   - The limits hold for the adapter sandbox alone. Exception, seen on one machine only (issue #640, see the probe above): a user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` ran a shell command with an expansion outside the sandbox. That command had network, and a write outside the work tree succeeded. The runtime does not prevent that.
   - The runtime prompts state this exception in every line that states the shell network limit (issue #655).
   - The `--ignore-rules` flag of `codex exec` closes it, but the runtime does not use it. That flag drops user and project execpolicy rules together, so it also drops a project `forbidden` rule. The `--ignore-user-config` flag does not skip the rules (probe of 2026-10-10, issue #655).
4. **Guard 1, reviewer only.** `runChild` takes `reviewerWorkspaceWrite` and passes the adapter option `sandbox: "workspace-write"` for a reviewer turn only. It keeps `readOnly: true` on that turn, so the `withMutationCheck` wrapper of `runChild` still runs. The Codex adapter gives `sandbox` precedence over `readOnly` and adds `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false` on new and resumed sessions. No other adapter reads `sandbox`, so none changes its invocation, and a test per adapter shows identical arguments with the input on and off. `decide` never sets `sandbox`, keeps `readOnly: true` on the first and the repair turn, and the Codex `read-only` flag and the orchestrator `withMutationCheck` stay. A worker turn never receives it.
5. **Guard 2, reviewer prompt line.** With the opt-in on, the reviewer prompt carries a sandbox note. With the opt-in off, the prompt has no such line. The note names no repository-specific tool or path. It says:
   - The turn runs in a `workspace-write` sandbox, and its shell commands have no network.
   - A user execpolicy rule is an exception.
   - The limit covers shell commands only, not model-side tools or other channels outside the sandbox.
   - A package manager that writes to a store or cache outside the work tree fails there, so the reviewer calls the project's local binary directly.
   - The rule against file changes still holds.

   The headless initial prompt tells the orchestrator about the opt-in only for a run that set it. It also says that its own turns stay read-only.

6. **Guard 3, this ADR, and the supersession.** The accepted gaps below are part of the decision. ADR 0001 is marked `superseded` by this ADR, and this ADR carries a `Supersedes` backlink, as the repository ADR rules require for a material change. The next subsection restates every decision of ADR 0001 that still holds.

### Decisions carried over from ADR 0001

1. **Role separation.**
   - `orchestrator`: decides the next action (`run_worker`, `run_reviewer`, `finish`, `abort`) through structured JSON output. It does not modify files or spawn subprocesses.
   - `worker`: implements code changes and runs checks.
   - `reviewer`: inspects and verifies changes. A reviewer turn is read-only by default. With the opt-in of this ADR it runs in `workspace-write`, and the snapshot check enforces that it changes nothing.
2. **Deterministic controller.**
   - It manages process spawning, session resumption, step limits (`--max-steps`, default 20), timeouts, and signal cancellation (`SIGINT`).
   - Every orchestrator turn is read-only. Every reviewer turn of a run without the opt-in is read-only. Two-layer enforcement holds for both: a CLI sandbox or plan flag, and the pre and post Git work-tree snapshot (`withMutationCheck`). For an opted-in reviewer turn only the second layer applies (gap 1).
   - It executes exactly one repair turn when the orchestrator returns malformed or invalid action JSON.
3. **Structured summary.** A task completes successfully only when the orchestrator returns `finish` with a complete 5-section summary (`changed`, `verified`, `deferred`, `notDone`, `open`).
4. **Consequences that still hold.** The fixed worker-first loop, `--max-reviews`, and the `REVIEW_COMPLETE` marker stay removed. A detected mutation in a read-only or opted-in reviewer turn, or in an orchestrator turn, halts the run with exit code 1 and leaves the modified paths intact with no revert. Step limits and the repair limit are hard-coded constraints that the model cannot override. `--transcript` captures a run to JSON.
5. **Alternatives of ADR 0001 stay rejected**: extending the fixed loop with conditional branches, an ordered multi-role pipeline with string gate markers, and an orchestrator that shells out directly.

### Accepted gaps

1. **Detection-only enforcement.** For an opted-in reviewer turn, enforcement moves from preventive (the sandbox) to detective (`withMutationCheck` in `src/lib/snapshot.mjs`). An edit succeeds. The run then halts with a `MutationError`, exit 1, and the runtime does not revert the change.
2. **Snapshot blind spots.** The snapshot uses `git status --porcelain=v1 -z --untracked-files=all` plus the index hash and `HEAD`. It does not see a write to an ignored file (for example `.env` or `node_modules/`), a write outside the repository, a write that the turn restores before it ends, or Git state other than the index and `HEAD` (other refs, the stash, the config). `workspace-write` also allows writes in the work tree that the snapshot cannot attribute to the reviewer when the same tree holds the writes of a `--test-cmd` run (ADR 0017).
3. **Remote GitHub writes.** This ADR keeps shell network off, so the opt-in does not open the shell path, except under the user-rule exception that follows. Exception, seen on one machine only (issue #640, see the probe above): a user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` ran a shell command with an expansion outside the sandbox, with network and with a write outside the work tree. The runtime does not prevent that. The shell network limit does not block a channel outside the sandbox, for example a GitHub app connector or another model-side tool, and a run on a different network setting would let `gh` and `git` change remote state too. The local snapshot sees none of it, so a push, a merge, a review, or a comment could change remote state unseen. A write through the connector tools was not probed. The README section "Codex read-only network limit" states that the other four adapters keep shell network in read-only turns, so Codex is the only adapter that blocks it today. Issue #422 holds the reviewer-wide rule against remote writes, and that rule is advisory and not enforced.
4. **A larger prompt-injection blast radius from reviewed content.** The reviewer reads a diff, test output, and repository files that a model or a third party wrote. Under `read-only`, an instruction hidden there can at most read. Under `workspace-write`, it can also run a command that edits the work tree or writes outside it into any location that the sandbox allows. The detection of gap 1 limits that to what the snapshot sees.
5. **Likely no gain on the unelevated Windows sandbox.** `docs/parent-guard.md` records that the unelevated Windows sandbox blocks a child spawn with `EPERM` under `workspace-write` ([openai/codex#37415](https://github.com/openai/codex/issues/37415)). The test runner is a child spawn, so the opt-in probably gives a Windows reviewer no ability to run tests. Not verified for a test runner.

## Consequences

- An operator who accepts the gaps gets a Codex reviewer that can run a targeted test or an ad-hoc probe. The reviewer needs no package manager to do so, and its shell commands have no network. This holds on macOS, where the live probe of the merged adapter confirmed it. It probably holds on Linux (not probed). It holds for the adapter sandbox alone: on the one machine of the probe of issue #640, a user Codex rule that allows `bash -c`, `sh -c`, or `zsh -c` ran a shell command with an expansion outside the sandbox, so its network and write limits did not apply to that command. The runtime does not prevent that. Not verified on other machines.
- A reviewer that edits the work tree halts the run and leaves the change on disk. The parent reads the `MutationError` and decides.
- The default is unchanged, and so are the other four adapters, the worker, and every orchestrator turn.
- A run that needs `gh` or another shell network read from the reviewer keeps the runtime read of ADR 0011, or its own decision for network.
- A reviewer that follows the prompt and calls `pnpm` instead of the local binary sees a failure that the prompt names as expected.

## Alternatives

1. **Network on with the opt-in**: the probed form, and it lets the reviewer run `gh`. Rejected for now: it opens the remote-write path that the runtime cannot detect, and the runtime already supplies check status.
2. **Inherit network from the user Codex config**: no flag, and no control for the operator. Rejected: the result then depends on a file that the run does not own.
3. **Reuse `readOnly` as the carrier**: a value other than a boolean would reach `decide` and every adapter. Rejected: the issue requires a reviewer-only input that `decide` never sets.
4. **A per-run `--reviewer-sandbox <mode>` value**: room for modes that no adapter reads. Rejected: one boolean covers the single mode that was probed.
5. **Apply the opt-in to the orchestrator**: the orchestrator reads and decides only, so it has no need. Rejected.
6. **Amend ADR 0001 in place, or leave it `accepted`**: its two-layer enforcement for reviewer turns no longer holds without exception, and the ADR rules require a new ADR and a `superseded` status for a material change. Rejected. The live decisions move into this ADR instead.

## Authors

Andro Marces

## Links

- [Issue #421: Add an opt-in workspace-write sandbox for the Codex reviewer](https://github.com/andromarces/agent-loops/issues/421)
- [Issue #342: Document that a Codex reviewer on Windows cannot spawn the test runner](https://github.com/andromarces/agent-loops/issues/342)
- [Issue #499: Verify the opt-in workspace-write Codex reviewer sandbox on live runs](https://github.com/andromarces/agent-loops/issues/499)
- [Issue #640: Probe ps, pnpm exec, and gh in the workspace-write Codex reviewer sandbox on macOS](https://github.com/andromarces/agent-loops/issues/640)
- [Pull Request #659: State the user-rule exception in the shell network lines of the runtime prompts](https://github.com/andromarces/agent-loops/pull/659)
- [Issue #384: Verify the Codex read-only test-runner spawn on macOS, Linux, and the elevated Windows sandbox](https://github.com/andromarces/agent-loops/issues/384)
- [Issue #420: Run a --test-cmd before each reviewer turn and supply the result to the reviewer](https://github.com/andromarces/agent-loops/issues/420)
- [Issue #422: Forbid GitHub and remote writes in every reviewer and orchestrator turn](https://github.com/andromarces/agent-loops/issues/422)
- [Pull Request #487: feat: add an opt-in workspace-write sandbox for the Codex reviewer](https://github.com/andromarces/agent-loops/pull/487)
- Implementation: the `sandbox` option in `src/agents/codex.mjs`, `reviewerWorkspaceWrite` in `runChild` and `runLoop` in `src/runtime.mjs`, `workspaceWriteLine` in `src/prompts/reviewer.mjs`, `reviewerSandboxBlock` in `src/prompts/orchestrator.mjs`, the init field in `src/role.mjs`, the flag in `src/cli.mjs` and `src/lib/args.mjs`; tests in `tests/agents/`, `tests/runtime.reviewer-sandbox.test.mjs`, `tests/role.reviewer-sandbox.test.mjs`, `tests/orchestrator.test.mjs`, `tests/cli.test.mjs`, and `tests/prompts/`; documented in `docs/orchestrator-instructions.md` and `README.md`
- Supersedes [ADR 0001: Hybrid orchestrator with deterministic runtime](0001-hybrid-orchestrator-runtime.md)
- [ADR 0011: Supply the required-check status to the reviewer from the runtime](0011-supply-the-required-check-status-to-the-reviewer.md)
- [ADR 0017: Run an operator test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR Index](README.md)
