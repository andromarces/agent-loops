# 0038. Run the Codex reviewer with no sandbox by default

## Status

accepted

Partially supersedes [ADR 0019: Opt in to a workspace-write sandbox for the Codex reviewer](0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md). This ADR replaces two decisions of ADR 0019: the `read-only` default of a Codex reviewer turn, and the boolean opt-in `--reviewer-workspace-write` as the only choice. Every other decision of ADR 0019 holds, including its accepted gaps for the two sandboxed modes.

## Date

2026-10-14

## Context

A Codex reviewer turn runs in a sandbox. On the hosts that were probed, that sandbox blocks the test suite, and it blocks shell network (ADR 0019, `docs/reference/reviewer-safety.md`). The reviewer accept then rests on `git diff`, static checks, and the advisory `--test-cmd` result of ADR 0017.

- `read-only`, macOS, codex-cli 0.163.0-alpha.4: `pnpm test` exits 1 before any test starts, with `EPERM` on `node_modules/.vite-temp`.
- `read-only`, Windows, codex-cli 0.159.0-alpha.12: a child `node` spawn returned an error, and `pnpm test --version` failed with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`.
- `read-only`: a shell `gh pr checks` cannot reach `api.github.com` (issue #421).
- `workspace-write` with network off, macOS: the local `vp` binary ran the full suite to exit 0, and `gh pr checks` failed to connect (issues #499, #640).
- `workspace-write`, unelevated Windows: a child `node` spawn returned an error (issue #656, ADR 0019 gap 5).
- `read-only` on Linux and the elevated Windows sandbox: not verified.

ADR 0019 made `read-only` the default and added one opt-in mode. Alternative 4 of ADR 0019 rejected a `--reviewer-sandbox <mode>` value, because one boolean covered the one opt-in mode. A third mode, no sandbox, as the default makes one boolean insufficient.

The operator of a run that needs a contained reviewer has two choices that the repository already supports: the two sandboxed modes, or an external sandbox with no credential for the remote. A reviewer with no sandbox is the same class as the `claude`, `agy`, and `opencode` read-only invocations, which already keep shell network (`docs/reference/reviewer-safety.md`, "Denial probe (issue #432)").

### Codex CLI forms, checked on this host

Host: Windows 11, `codex-cli 0.163.0-alpha.10`. No Codex model turn ran for this check.

- `codex exec --help` lists `-c, --config <key=value>` and `-s, --sandbox <SANDBOX_MODE>` with the values `read-only`, `workspace-write`, and `danger-full-access`. It also lists `--dangerously-bypass-approvals-and-sandbox`.
- `codex exec resume --help` lists `-c, --config <key=value>` and `--dangerously-bypass-approvals-and-sandbox`. It lists no `-s, --sandbox`.

Result: only the `-c sandbox_mode="danger-full-access"` form is accepted by both subcommands, and it is the form that the adapter already uses for the two other modes. The `--dangerously-bypass-approvals-and-sandbox` flag also skips approvals, and the `-c` form changes one setting only.

## Decision

1. **New default.** A Codex reviewer turn of a run that starts after this change runs with `-c sandbox_mode="danger-full-access"`, on a new session and on a resumed session. The adapter reads the reviewer input `sandbox` with the value `none` for this mode.
2. **Opt-in flag.** `--reviewer-sandbox <read-only|workspace-write>` selects a sandboxed mode on both paths.
   - `read-only` reproduces the earlier default invocation, `-c sandbox_mode="read-only"`.
   - `workspace-write` reproduces the invocation of ADR 0019, with `sandbox_workspace_write.network_access=false`.
   - The flag is refused unless `--reviewer codex`. The headless path refuses it at parse time, and the interactive path refuses it at init, before any state is written.
3. **Alias kept.** `--reviewer-workspace-write` stays as an alias of `--reviewer-sandbox workspace-write`. Existing scripts keep their meaning. The alias with `--reviewer-sandbox read-only` is refused as a conflict, in either order. The alias adds no new rule: it is parsed into the same mode value, and one refusal text serves both.
4. **Recorded mode.** A run that starts after this change records `none`, `read-only`, or `workspace-write`, for a Codex reviewer only. The interactive path stores it as `reviewerSandbox` in the state file. The headless path records it in the transcript `options`. A run with a reviewer that is not Codex records no mode, and its prompts name none.
5. **Init-only on the interactive path.** A later call can repeat the stored mode, or omit the flag. Any other value is refused in either direction: `--reviewer-sandbox cannot be changed after init (state holds: <mode>).`
6. **Headless `--continue-from`.** A continued run keeps the mode of the earlier run when the flag is omitted. It is refused when the flag names another mode: `--reviewer-sandbox cannot be changed by --continue-from (the earlier run held: <mode>).` This extends the contract of [ADR 0026](0026-detect-a-changed-resolved-model-on-continue-from.md), which compares the roles and the resolved models of the earlier run, and does not compare the flag that ADR 0019 added. The refusal runs before any turn and writes no transcript.
7. **A run from before this change never loses its sandbox.** A state file or an earlier transcript with no recorded mode gets `workspace-write` when it holds `reviewerWorkspaceWrite: true`, and `read-only` otherwise. It never gets `none`. This covers a later `role dispatch`, `role dispatch --resume-interrupted`, and a headless `--continue-from` run. A field that is present with a value that is not one of the three modes, such as `null`, a number, an empty string, or an unknown string, is refused, never read as another mode: `State file field reviewerSandbox must be one of none, read-only, workspace-write, got: <value>.` on the interactive path, and `--continue-from <file> has an invalid reviewerSandbox option.` on the headless path. The refusal covers every path that acts on the recorded mode (`role dispatch`, `--resume-interrupted`, `extend`, `finish`, the init-field comparison, and `--continue-from`), and every reviewer kind. Only an absent field takes the legacy fallback. One exception: `role abort` does not read a damaged mode. It runs no reviewer turn, charges no step, and is the only route to a terminal lifecycle when `dispatch` and `finish` are refused (ADR 0014), so it ends the run over any recorded value, a mode flag included. Over a valid recorded mode, `abort` still refuses a flag that names another mode, as every other init flag.
8. **Orchestrator and worker turns do not change.** Every orchestrator turn keeps `readOnly: true`, the Codex `read-only` flag, and its mutation check. A worker turn never receives the reviewer input. The other four adapters do not read the input, and their arguments stay identical in every mode.
9. **The mutation check wraps every reviewer turn in every mode.** `runChild` keeps `readOnly: true` for the reviewer, so `withMutationCheck` still runs. With no sandbox it is the only edit guard, and its coverage does not change (ADR 0019 gap 2).
10. **Prompts state the actual mode.** The reviewer prompt and the headless orchestrator prompt carry a note for each of the three modes. The rule against file changes and the rule against remote writes (issue #422) stay in every reviewer prompt.
11. **Check-read precedence.** The change alters the network class of a Codex reviewer only.
    - `requiredCheckWait` returns `reviewer` for a Codex reviewer with no sandbox when the orchestrator is not a waiting CLI (`codex`, `copilot`, or unnamed). The reviewer fallback read can then succeed on Codex.
    - It returns `wait` for a waiting orchestrator (`claude`, `agy`, `opencode`), whatever the reviewer mode.
    - It returns `gate` for a Codex reviewer in either sandboxed mode with a non-waiting orchestrator, as before.
    - The runtime-supplied status and its conditions, and the `--require-ci` gate, do not change. The gate stays the only read that enforces.
12. **Managed Codex requirements are not claimed.** How `codex exec` behaves for `sandbox_mode="danger-full-access"` under a requirements file that does not allow it is not verified. This ADR makes no claim about that case. Issue #710 holds the live check.

## Consequences

- A new Codex reviewer turn can run the test suite and `gh pr checks`. The accept of a reviewer can then rest on a test run that the reviewer ran, on a host where the sandbox blocked it.
- The shell commands of a reviewer turn can write anywhere that the user account can write, and can reach the network. The model-side and connector paths that ADR 0019 lists do not change. A connector write probe of issue #496 (2026-10-25, codex-cli 0.165.0-alpha.1) posted a GitHub comment under `danger-full-access`, the mode of this default, while `read-only` and `workspace-write` refused it.
- **The mutation check is the only edit guard.** It stays repository-local: `git status --porcelain=v1 -z --untracked-files=all`, the index hash, and `HEAD`. It does not see a write to an ignored file, a write outside the repository, a write that the turn restores before it ends, or Git state other than the index and `HEAD`. A write outside the repository is no longer limited by a sandbox either.
- **Descendant writes after a parent end** (ADR 0034, issue #712) are no longer limited to the work tree or to no network.
- **Remote writes.** With shell network on, a reviewer turn can run `gh` and `git` and push, merge, review, or comment. The local snapshot does not see a remote write. The rule of issue #422 is advisory and not enforced.
- **Prompt injection.** The reviewer reads diffs, test output, and repository files that a model or a third party wrote. With no sandbox, an injected instruction can steer a shell command that writes outside the work tree or sends data over the network. An operator who needs containment passes `--reviewer-sandbox read-only` or `workspace-write`, or runs the reviewer in an external sandbox with no credential for the remote.
- The user execpolicy exception of ADR 0019 does not apply with no sandbox, because no sandbox exists to skip. It still applies to both sandboxed modes.
- A headless `--continue-from` run that names another mode than the earlier run is refused. Before this change, the flag was not compared.
- Documentation of the three modes lives in `docs/reference/reviewer-safety.md`, `docs/reference/usage.md`, `docs/reference/role.md`, and `docs/orchestrator-instructions.md`.

### Pending verification

These live checks are not done. Each result goes into this ADR when its issue records it.

- Issue #708 (macOS, also satisfies issue #707 for Linux): a live Codex reviewer turn with no sandbox runs the full test suite and `gh pr checks <pr> --required`. Record the codex-cli and Node versions, the exit codes, and the test counts.
  - Result on macOS 27.2 (Darwin 27.2.0, arm64), probe on 2026-10-19: a nested `agent-loop role` run with `--mode review-only`, `--reviewer codex`, `--reviewer-model gpt-6.1-sol`, `--reviewer-effort high`, and no `--reviewer-sandbox` flag. The saved state file holds `reviewerSandbox: "none"`. The one reviewer turn ended with status `ok` and verdict `accept`. The `reviewed` fields were `head` d659dc7, `clean` true, and `exact` true. The run ended with `finish`, and the state file holds lifecycle `finished`.
  - The reviewer report in `Checks`, as the reviewer wrote it: `node --version` exit 0, v26.12.0, and `codex --version` exit 0, codex-cli 0.164.0-alpha.3. The plain test-slot wrapper over `pnpm test` exit 0, with 120 test files passed and 1 skipped. Tests: 2593 passed, 20 expected fail, and 16 skipped. `gh pr checks 956 --required` exit 0.
  - Separate direct probe on the same day, not a `role` run: a `codex exec` turn with `-c sandbox_mode="danger-full-access"` and `-m gpt-6.1-sol` ran the same commands. Each exited 0, with the same test counts. This probe ran no reviewer prompt and no mutation check.
- Issue #709 (Windows): the same check. Record the same fields.
  - Result on Windows 11 (10.0.26220), probe on 2026-10-23: a nested `agent-loop role dispatch` run in a disposable linked work tree at head 193d06f, with `--mode review-only`, `--reviewer codex`, no `--reviewer-model`, no `--reviewer-effort`, and no `--reviewer-sandbox` flag. The saved state file holds `reviewerSandbox: "none"`. The one reviewer turn ended with exit 0, status `ok`, and verdict `reject`. The `reviewed` fields were `head` 193d06f, `clean` true, and `exact` true. The reviewer ran the full suite and `gh pr checks`, so the no-sandbox mode ran both on Windows. The verdict is `reject` because the suite failed, not because a command was blocked.
  - The reviewer report in `Checks`, as the reviewer wrote it: `node --version` exit 0, v26.8.1, and `codex --version` exit 0, codex-cli 0.164.0-alpha.12. The test slot wrapper over `pnpm test` exit 1, with 120 test files passed and 6 failed. Tests: 2644 passed, 26 failed, 20 expected fail, and 86 skipped. `gh pr checks 1010 --repo andromarces/agent-loops --required` exit 0, with `ci (macos-latest)`, `ci (ubuntu-latest)`, and `ci (windows-latest)` pass.
  - The failures are not a sandbox block. A direct run of the same command at the same head, outside the reviewer, also exited 1: 121 test files passed and 5 failed, and tests 2647 passed, 23 failed, 20 expected fail, and 86 skipped. The failing files were `tests/cli.reviewer-sandbox.test.mjs`, `tests/cli.session-persist.test.mjs`, `tests/role.first-turn-task.test.mjs`, `tests/runtime.session-replace.test.mjs`, and `tests/runtime.test-cmd.test.mjs`. The sampled failures ended with `Test timed out in 15000ms`. The `ci (windows-latest)` check passed on the same head. The count differs between the two runs. Host load is an unconfirmed suspect, and no run tested it. This ADR does not state a cause.
- Issue #710 (live runs): a Codex reviewer turn with no sandbox under a Codex requirements file that does not allow `danger-full-access`. Record the codex-cli version, the exit code, and the mode that the turn ran in.

## Alternatives

1. **`--dangerously-bypass-approvals-and-sandbox`.** Rejected. It also skips approvals, and `codex exec resume` accepts it, but it changes more than the sandbox.
2. **`--sandbox danger-full-access`.** Rejected. `codex exec resume` does not list `-s, --sandbox`, so one form could not serve new and resumed sessions.
3. **Remove `--reviewer-workspace-write`.** Rejected. A script that passes it would fail, or lose its sandbox. The alias costs one parser case.
4. **Keep `read-only` as the default and add a `none` mode flag.** Rejected. The `read-only` reviewer cannot run the test suite on the hosts that were probed, so the default left the main review gap open.
5. **Give a run from before this change the new default.** Rejected. A resumed run would lose a sandbox that its operator chose or accepted. Decision 7 forbids it.

## Authors

Andro Marces

## Links

- [Pull request #777](https://github.com/andromarces/agent-loops/pull/777)
- [Pull request #1010](https://github.com/andromarces/agent-loops/pull/1010)
- [Issue #776](https://github.com/andromarces/agent-loops/issues/776)
- [Issue #707: Verification checklist: Linux](https://github.com/andromarces/agent-loops/issues/707)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [Issue #709: Verification checklist: Windows](https://github.com/andromarces/agent-loops/issues/709)
- [Issue #710: Verification checklist: live runs](https://github.com/andromarces/agent-loops/issues/710)
- [ADR 0019: Opt in to a workspace-write sandbox for the Codex reviewer](0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md) (partially superseded)
- [ADR 0026: Detect a changed resolved model on --continue-from](0026-detect-a-changed-resolved-model-on-continue-from.md)
- [ADR 0034: Keep the Codex reviewer descendant gap after a parent end](0034-keep-the-codex-reviewer-descendant-gap-after-a-parent-end.md)
- [ADR Index](README.md)
