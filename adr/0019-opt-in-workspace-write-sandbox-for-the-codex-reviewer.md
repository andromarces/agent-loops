# 0019. Opt in to a workspace-write sandbox for the Codex reviewer

## Status

accepted

## Date

2026-10-05

## Context

A Codex reviewer turn runs with `-c sandbox_mode="read-only"`. ADR 0001 states two-layer read-only enforcement for reviewer and orchestrator turns: a CLI sandbox or plan flag, and the pre and post Git snapshot in `withMutationCheck`. Under that sandbox the reviewer cannot run a targeted test or an ad-hoc probe. ADR 0017 supplies the result of a whole `--test-cmd` run instead, and issue #421 asks for the upgrade path for the need that ADR does not cover.

Direct probes, macOS, codex-cli 0.162.0-alpha.9 (issue #421, 2026-10-04) and 0.162.0-alpha.14 (2026-10-05):

- `read-only`: `pnpm exec vitest run` fails with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`, `./node_modules/.bin/vitest run` fails with `EPERM` on `node_modules/.vite-temp`, and `gh pr checks` cannot reach `api.github.com`.
- `workspace-write` with network on: `pnpm exec vitest run` fails with `ERR_PNPM_PRIVATE_INSTALL_CREATE`, because pnpm writes to its store outside the work tree. `./node_modules/.bin/vitest run` exits 0 with the same counts as an unsandboxed run, and `gh pr checks` lists the checks.
- `workspace-write` with `sandbox_workspace_write.network_access=false` (2026-10-05): `./node_modules/.bin/vitest run` exits 0 (66 files passed, 1 skipped; 1249 tests passed, 8 skipped), `curl https://api.github.com` fails with `Could not resolve host`, and `gh pr checks` fails with `error connecting to api.github.com`. The work tree stayed clean.
- `workspace-write` with no network setting on the command line (2026-10-05): `curl` returned HTTP 200 and `gh pr checks` listed the checks. The user Codex config on that machine sets `[sandbox_workspace_write] network_access = true`, so the mode inherits network from the user config.

The headless orchestrator has three guards that this change leaves in place: `readOnly: true` on the first and the repair turn in `decide`, the Codex `read-only` flag that follows from it, and the `withMutationCheck(cwd, "orchestrator", ...)` wrapper in `orchAdapter`. The adapter and `runChild` shared one `readOnly` boolean, so the opt-in needs a separate reviewer-only input.

## Decision

1. `--reviewer-workspace-write` is an optional boolean run input on both paths that run reviewer turns: a headless option, and an init flag of `agent-loop role`. It is off by default, and a run without it keeps its invocation, prompt, state file, and transcript. It is refused unless `--reviewer codex`, because only the Codex adapter reads the sandbox input, and any other reviewer would run read-only while the prompt said otherwise. The refusal comes at parse time on the headless path and at init on the interactive path, before any state is written.
2. **Init-field rules.** The interactive path stores `reviewerWorkspaceWrite: true` in the state file, and only when on. A later call that omits the flag reads the stored value. A later call that repeats the flag on a run that stored it is accepted. A later call that passes the flag on a run that did not store it is refused: `--reviewer-workspace-write cannot be changed after init`. No flag turns it off after init. A child process with write access to the runs root can edit the state file, as it can edit `cwd` and `pr`, so the stored value is not a barrier against a process that already holds that access.
3. **Network stays off.** The opt-in passes `-c sandbox_workspace_write.network_access=false` explicitly, and the reviewer prompt says the turn has no network. The explicit value is required: the 2026-10-05 probe showed that `workspace-write` inherits network from the user Codex config. The network-on form is the one that issue #421 probed, and it lets `gh` read check status. It also opens the remote-write path of gap 3 below, which the prompt rule of issue #422 covers by advice only. The runtime already reads the required-check status for a declared PR (ADR 0011), so the reviewer does not need `gh`, and the opt-in buys local tests and probes without the remote-write path. A network-on variant needs its own decision.
4. **Guard 1, reviewer only.** `runChild` takes `reviewerWorkspaceWrite` and passes the adapter option `sandbox: "workspace-write"` for a reviewer turn only. It keeps `readOnly: true` on that turn, so the `withMutationCheck` wrapper of `runChild` still runs. The Codex adapter gives `sandbox` precedence over `readOnly` and adds `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false` on new and resumed sessions. No other adapter reads `sandbox`, so none changes its invocation, and a test per adapter shows identical arguments with the input on and off. `decide` never sets `sandbox`, keeps `readOnly: true` on the first and the repair turn, and the Codex `read-only` flag and the orchestrator `withMutationCheck` stay. A worker turn never receives it.
5. **Guard 2, reviewer prompt line.** With the opt-in on, the reviewer prompt carries a sandbox note: the turn runs in a `workspace-write` sandbox with network off, a package manager that writes to a store or cache outside the work tree fails there, so the reviewer calls the project's local binary directly, and the rule against file changes still holds. The line names no repository-specific tool or path. With the opt-in off the prompt has no such line. The headless initial prompt tells the orchestrator about the opt-in only for a run that set it, and says that its own turns stay read-only.
6. **Guard 3, this ADR.** The accepted gaps below are part of the decision. ADR 0001 stays `accepted` and is not superseded. The two-layer enforcement it states still holds for every orchestrator turn and for every reviewer turn of a run without the opt-in. This ADR defines an operator-selected exception for a reviewer turn, and the non-mutating invariant for that turn stays, enforced by detection.

### Accepted gaps

1. **Detection-only enforcement.** For an opted-in reviewer turn, enforcement moves from preventive (the sandbox) to detective (`withMutationCheck` in `src/lib/snapshot.mjs`). An edit succeeds. The run then halts with a `MutationError`, exit 1, and the runtime does not revert the change.
2. **Snapshot blind spots.** The snapshot uses `git status --porcelain=v1 -z --untracked-files=all` plus the index hash and `HEAD`. It does not see a write to an ignored file (for example `.env` or `node_modules/`), a write outside the repository, a write that the turn restores before it ends, or Git state other than the index and `HEAD` (other refs, the stash, the config). `workspace-write` also allows writes in the work tree that the snapshot cannot attribute to the reviewer when the same tree holds the writes of a `--test-cmd` run (ADR 0017).
3. **Remote GitHub writes over network.** This ADR keeps network off, so the opt-in does not open the path. A run on a different network setting, for example a user config that a later change leaves in force, would let `gh` and `git` change remote state (push, merge, review, comment), and the local snapshot does not see that. The README section "Codex read-only network limit" states that the other four adapters keep shell network in read-only turns, so Codex is the only adapter that blocks it today. Issue #422 holds the reviewer-wide rule against remote writes, and it is advisory.
4. **A larger prompt-injection blast radius from reviewed content.** The reviewer reads a diff, test output, and repository files that a model or a third party wrote. Under `read-only`, an instruction hidden there can at most read. Under `workspace-write`, it can also run a command that edits the work tree or writes outside it into any location that the sandbox allows. The detection of gap 1 limits that to what the snapshot sees.
5. **Likely no gain on the unelevated Windows sandbox.** `docs/parent-guard.md` records that the unelevated Windows sandbox blocks a child spawn with `EPERM` under `workspace-write` ([openai/codex#37415](https://github.com/openai/codex/issues/37415)). The test runner is a child spawn, so the opt-in probably gives a Windows reviewer no ability to run tests. Not verified for a test runner.

## Consequences

- An operator who accepts the gaps gets a Codex reviewer that can run a targeted test or an ad-hoc probe, without a package manager and without network, on macOS (probed) and probably Linux (not probed).
- A reviewer that edits the work tree halts the run and leaves the change on disk. The parent reads the `MutationError` and decides.
- The default is unchanged, and so are the other four adapters, the worker, and every orchestrator turn.
- A run that needs `gh` or another network read from the reviewer keeps the runtime read of ADR 0011, or its own decision for network.
- A reviewer that follows the prompt and calls `pnpm` instead of the local binary sees a failure that the prompt names as expected.

## Alternatives

1. **Network on with the opt-in**: the probed form, and it lets the reviewer run `gh`. Rejected for now: it opens the remote-write path that the runtime cannot detect, and the runtime already supplies check status.
2. **Inherit network from the user Codex config**: no flag, and no control for the operator. Rejected: the result then depends on a file that the run does not own.
3. **Reuse `readOnly` as the carrier**: a value other than a boolean would reach `decide` and every adapter. Rejected: the issue requires a reviewer-only input that `decide` never sets.
4. **A per-run `--reviewer-sandbox <mode>` value**: room for modes that no adapter reads. Rejected: one boolean covers the single mode that was probed.
5. **Apply the opt-in to the orchestrator**: the orchestrator reads and decides only, so it has no need. Rejected.
6. **Supersede ADR 0001**: the default and the orchestrator keep its two layers, so superseding would mark a live decision as replaced. Rejected.

## Authors

Andro Marces

## Links

- [Issue #421: Add an opt-in workspace-write sandbox for the Codex reviewer](https://github.com/andromarces/agent-loops/issues/421)
- [Issue #342: Document that a Codex reviewer on Windows cannot spawn the test runner](https://github.com/andromarces/agent-loops/issues/342)
- [Issue #384: Verify the Codex read-only test-runner spawn on macOS, Linux, and the elevated Windows sandbox](https://github.com/andromarces/agent-loops/issues/384)
- [Issue #420: Run a --test-cmd before each reviewer turn and supply the result to the reviewer](https://github.com/andromarces/agent-loops/issues/420)
- [Issue #422: Forbid GitHub and remote writes in every reviewer and orchestrator turn](https://github.com/andromarces/agent-loops/issues/422)
- Implementation: the `sandbox` option in `src/agents/codex.mjs`, `reviewerWorkspaceWrite` in `runChild` and `runLoop` in `src/runtime.mjs`, `workspaceWriteLine` in `src/prompts/reviewer.mjs`, `reviewerSandboxBlock` in `src/prompts/orchestrator.mjs`, the init field in `src/role.mjs`, the flag in `src/cli.mjs` and `src/lib/args.mjs`; tests in `tests/agents/`, `tests/runtime.reviewer-sandbox.test.mjs`, `tests/role.reviewer-sandbox.test.mjs`, `tests/orchestrator.test.mjs`, `tests/cli.test.mjs`, and `tests/prompts/`; documented in `docs/orchestrator-instructions.md` and `README.md`
- [ADR 0001: Hybrid orchestrator with deterministic runtime](0001-hybrid-orchestrator-runtime.md)
- [ADR 0011: Supply the required-check status to the reviewer from the runtime](0011-supply-the-required-check-status-to-the-reviewer.md)
- [ADR 0017: Run an operator test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR Index](README.md)
