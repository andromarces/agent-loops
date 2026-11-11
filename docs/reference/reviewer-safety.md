# Safety

## Reviewer safety

Orchestrator turns run in read-only mode to prevent unintended repository mutations. Reviewer turns of every CLI except Codex run read-only too. A Codex reviewer turn runs with no sandbox by default, and the operator can choose a sandbox ([Codex reviewer sandbox mode](#codex-reviewer-sandbox-mode), [ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)). The mutation check wraps every turn in every mode.

### Read-only CLI flags

| CLI        | Read-only invocation flag     | Flag effect                                                                                                                                                                                                   | Role-model subagent fan-out                                              | Evidence                              |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `claude`   | `--permission-mode plan`      | Plan mode blocks file edits.                                                                                                                                                                                  | Yes; Explore and Plan subagents run on the role model. Adapter disables. | Claude docs; issue #46 smoke test     |
| `codex`    | `-c sandbox_mode="read-only"` | Orchestrator turns, and reviewer turns with `--reviewer-sandbox read-only`. Passes read-only sandbox mode on new and resumed sessions. Also blocks shell network access, except under a user execpolicy rule. | Yes; `spawn_agent` subagents inherit the parent model and effort.        | Codex rollout transcript              |
| `agy`      | `--mode plan`                 | Plan mode disables file edits.                                                                                                                                                                                | Yes; `invoke_subagent` subagents inherit the parent model by default.    | CLI `stream-json` step                |
| `opencode` | `--agent plan`                | The plan agent blocks edits; a global permissions allow can cancel it. Adapter denies `edit` per turn. Shell writes stay possible.                                                                            | Yes; the `subagent` tool inherits the session model. Adapter denies it.  | `run --format json` tool call; A/B    |
| `copilot`  | `--deny-tool write`           | Denies write/edit tools. External permissions may still permit shell writes.                                                                                                                                  | No; subagents run on an agent-definition default model.                  | `--output-format json` subagent event |

#### Codex read-only network limit

`-c sandbox_mode="read-only"` restricts network access of the shell commands that the sandbox runs, as well as writes. It applies to every Codex orchestrator turn, and to a Codex reviewer turn only with `--reviewer-sandbox read-only` (or `workspace-write`, which also keeps network off). A Codex reviewer with no sandbox keeps shell network. It does not block model-side tools.

The Codex `web_search` tool is a model-side tool, so the sandbox does not block it (issue #421). A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception. That rule can run a shell command with an expansion outside the sandbox, with network. The runtime does not prevent that.

A Codex orchestrator turn cannot run `gh` from its sandboxed shell to resolve a PR head, except under the user-rule exception above. A Codex-orchestrated PR run must then abort, or record the unresolved compare under `notDone` and `open` with `"unresolvedCompare": true`. It must not finish as verified, unless the run carries `--require-ci <pr>`. That gate runs in the runtime process, which the Codex sandbox does not cover. The gate resolves the PR head without the orchestrator needing network access (#293).

A Codex reviewer turn in a sandboxed mode cannot run `gh` from its sandboxed shell either, for example to check a PR's CI status. The same exception applies. A Codex reviewer turn with no sandbox can run `gh`, so the headless `requiredCheckWait` rule is `reviewer` for it, unless the orchestrator is a waiting CLI ([ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)).

Read-only file
protection stays in place on every adapter, except for a Codex reviewer turn with no sandbox (the default) and one in `workspace-write`: the CLI flag remains, and
the pre/post mutation check still aborts on a detected change on every turn. The other
adapters' read-only invocations keep shell network access, except `copilot`, which refuses most shell commands without approval (see [Denial probe](#denial-probe-issue-432)).

#### Codex reviewer sandbox mode

A Codex reviewer turn runs in one of three modes
([ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md),
which partially supersedes
[ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md)).
The flag needs `--reviewer codex`. The adapter uses the same `-c sandbox_mode` form on new and resumed sessions, because `codex exec resume` accepts `-c` and not `--sandbox` (codex-cli 0.163.0-alpha.10).

| Mode               | Selected by                                                                     | Codex setting                                                                       |
| ------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| none (the default) | no flag                                                                         | `-c sandbox_mode="danger-full-access" -c features.apps=false`                       |
| `read-only`        | `--reviewer-sandbox read-only`                                                  | `-c sandbox_mode="read-only"`                                                       |
| `workspace-write`  | `--reviewer-sandbox workspace-write`, or the alias `--reviewer-workspace-write` | `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false` |

The mode is fixed at init on the interactive path, and a headless `--continue-from` run keeps the earlier mode. A run from before ADR 0038 keeps its sandbox: `workspace-write` if it held `--reviewer-workspace-write`, `read-only` otherwise.
The reviewer prompt gains one note that states the actual mode:

- The turn has no sandbox, or the read-only sandbox, or the workspace-write sandbox.
- In a sandboxed mode, its shell commands have no network, and a user execpolicy rule is an exception.
- In a sandboxed mode, the limit covers shell commands only.
- With no sandbox, the rules against file changes and remote writes are the only limits.
- In `workspace-write`, a package manager that writes outside the work tree fails there, so the reviewer calls the project's local binary.

The orchestrator turns, the worker turns, and the other
four adapters keep their invocations, and the mutation check still wraps every reviewer turn.

With no sandbox, the shell commands of the reviewer turn can write anywhere that the user account can write and can reach the network. The mutation check is then the only edit guard, and it sees the repository only. The user execpolicy exception does not apply, because no sandbox exists to skip. The app connectors are off in this mode (`features.apps=false`), because a GitHub connector write runs there without approval (issue #496).

Live reviewer turns with no sandbox are recorded in [ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md#pending-verification). The turn ran the full suite and `gh pr checks` on macOS and Windows (issues #708 and #709, PRs #956 and #1010).

No Linux host ran a turn. The macOS result stands for Linux in the checklist of issue #707. Not verified with a live Codex turn: the mode under a Codex requirements file that does not allow `danger-full-access` (issue #710).

In `workspace-write`, shell network is off on purpose. The option is set explicitly, because `workspace-write` takes network from the user Codex config when the command line does not set it. `network_access=false` covers the shell commands that the sandbox runs. A model-side tool (for example Codex `web_search`) and any other channel outside the sandbox, such as a connector, are not covered. A user Codex rule that allows `bash -c`, `sh -c`, or `zsh -c` also runs a shell command with an expansion outside the sandbox.

The runtime read of the required-check status for a named PR ([ADR 0024](https://github.com/andromarces/agent-loops/blob/main/adr/0024-supply-the-required-check-status-for-a-named-pr.md)) still reaches
the reviewer.

The probe evidence for the `workspace-write` opt-in mode is in [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md). On macOS, a reviewer ran the local test binary to exit 0, and shell network calls failed. The sandbox blocks `ps`, so the `ps`-gated tests skip. On the unelevated Windows sandbox, `pnpm exec` failed with a store lock error. Linux and the elevated Windows sandbox are not verified.

Accepted gaps of the two sandboxed modes, as ADR 0019 states them (the no-sandbox mode adds the gaps in the section "Safety trade-off of the no-sandbox mode" below):

- Detection only. The sandbox no longer prevents an edit. An edit succeeds, and the run then halts with a `MutationError`, exit 1, with no revert.
- Snapshot blind spots. The snapshot does not see a write to an ignored file (for example `.env` or `node_modules/`), a write outside the repository, a write that the turn restores before it ends, or Git state other than the index and `HEAD` (other refs, the stash, the config). The reviewer prompt tells the turn to remove the output that it created under an ignored path or outside the repository, and to name any that it could not remove in `Notes`. The runtime removes only the per-turn scratch folder that the prompt names first (issue #920, [ADR 0042](https://github.com/andromarces/agent-loops/blob/main/adr/0042-remove-the-reviewer-scratch-folder-in-the-runtime.md)). No runtime step removes other output (issues #865, #906).
- Remote GitHub writes. Shell network is off here, so the opt-in does not open the shell path for `gh` and `git`, except under the user-rule exception in this item. Exception, seen on one machine only (issue #640): a user Codex rule that allows `bash -c`, `sh -c`, or `zsh -c` ran a shell command with an expansion such as `$$` or `$HOME` outside the sandbox, with network and with a write outside the work tree. The runtime does not prevent that.
  - The sandbox does not block a channel outside it, for example a GitHub app connector or another model-side tool, and the local snapshot does not see a remote write over any channel, so a push, a merge, a review, or a comment could change remote state unseen. Codex is the only adapter that blocks shell network in a read-only turn today. Issue #422 holds the rule against remote writes, which is advisory and not enforced.
- A larger prompt-injection blast radius. Reviewed content that holds an instruction can steer a command that writes, not only one that reads.
- Likely no gain on the unelevated Windows sandbox, which blocks a child spawn with `EPERM` under `workspace-write` (`docs/reference/parent-guard.md`). The probe above shows a failed child `node` spawn and a pnpm store lock failure. Not verified for a test runner.

#### Safety trade-off of the no-sandbox mode

- The shell commands of a reviewer turn can write outside the work tree, and the mutation check does not see such a write.
- A command that a reviewer starts can write after its parent ends, and it is not limited to the work tree or to no network ([ADR 0034](https://github.com/andromarces/agent-loops/blob/main/adr/0034-keep-the-codex-reviewer-descendant-gap-after-a-parent-end.md)).
- With shell network on, a reviewer turn can run `gh` and `git` and push, merge, review, or comment. The runtime does not see a remote write. The rule of issue #422 is advisory.
- Reviewed content that holds an instruction can steer a shell command that writes outside the work tree or sends data over the network.
- An operator who needs containment passes `--reviewer-sandbox read-only` or `workspace-write`, or runs the reviewer in an external sandbox with no credential for the remote.

#### Reviewer shell commands can lose `GH_TOKEN` and `GITHUB_TOKEN`

On Windows, a PowerShell profile can remove both names. Codex and this repository do not remove them.

Mechanism (issue #971): Codex runs a shell command through PowerShell. It adds `-NoProfile` only when the command does not use a login shell (`codex-rs/core/src/shell.rs`, tag `rust-v0.164.0-alpha.6`). Otherwise the user profile loads. A profile that sets or clears `GH_TOKEN` and `GITHUB_TOKEN` replaces the inherited values. Then `gh` falls back to the account in `hosts.yml` or the `gh` keyring.

Ruled out, by source at the same tag:

- The runtime. `src/lib/exec.mjs` merges the turn environment with `process.env`, and `codex` receives both names.
- The Codex environment policy. `populate_env` and `NON_INHERITABLE_ENV_VARS` do not list either name.
- The Codex credential broker. It is off unless the `network_proxy` feature enables it.

Check for a profile effect:

1. Set a dummy `GH_TOKEN` in the launching shell. Never use a real token.
2. Run `pwsh -Command '[bool]$env:GH_TOKEN'`. The result `False` means the profile removes the name.
3. Run `pwsh -NoProfile -Command '[bool]$env:GH_TOKEN'`. The result `True` confirms the profile as the cause.
4. Read the profile for code that sets, clears, or removes `GH_TOKEN` and `GITHUB_TOKEN`.

Avoid the effect:

- Set `allow_login_shell = false` in the Codex `config.toml`. Codex then starts PowerShell with `-NoProfile`. Without a login shell, the model cannot request one.
- Change the profile so it keeps an inherited `GH_TOKEN` and `GITHUB_TOKEN`.
- Store the account in the `gh` keyring (`gh auth login`), so the fallback can read the repository.
- Pass the token under another name, for example `AGENT_GH_TOKEN`, then set it in the command: `$env:GH_TOKEN = $env:AGENT_GH_TOKEN; gh ...`. A profile that clears only the two standard names leaves it alone.

Not verified: Linux shells, other Codex versions, and a profile that clears other names.

The shell forms and the login-shell result on macOS are in issue #971. Verified on macOS 27.2 with zsh 5.9 and codex-cli 0.166.0.

#### Codex read-only child-spawn limit

This limit applies to a Codex reviewer in the `read-only` mode, and to Codex orchestrator turns. A reviewer with no sandbox is not limited this way.

On Windows 11 a child `node` spawn returned an error, and `pnpm test --version` failed with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` (issue #342). On macOS `pnpm test` exited 1 before any test started, when `vp` failed to create `node_modules/.vite-temp` with `EPERM`. A reviewer with no sandbox is not limited this way. Linux and the elevated Windows sandbox are not verified. The probe logs are in [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md#read-only-child-spawn-and-denial-probes).

#### Read-only subagent fan-out

Every adapter can fan out from a read-only turn to child subagents. The per-adapter probe and its versions are in issue #90.

- `claude`: Plan mode delegates research to the built-in Explore and Plan subagents, which inherit the role model. The adapter sets `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` on read-only turns only, so plan mode reads files directly. Worker turns stay unchanged. The variable disables only the built-in Explore and Plan subagents. The general-purpose and custom subagents stay available, and a Claude Code version before 2.1.198 ignores the variable.
- `codex`: A read-only `exec` turn keeps the collaboration tools. `spawn_agent` subagents inherit the parent model and reasoning effort. No tested switch disables it, so a read-only turn can cost the parent model a multiple of what the transcript suggests.
- `agy`: A plan-mode turn runs a `research` subagent through `invoke_subagent`. A subagent defaults to `inherit`, the parent model. No CLI flag or setting disables it.
- `opencode`: A plan turn runs an `explore` subagent through the `subagent` tool. The `explore` and `general` agents set no model, so they inherit the session model. The adapter sets `OPENCODE_CONFIG_CONTENT` with `subagent` and `edit` denies on read-only turns only. OpenCode merges that per-turn document after the user config. The `edit` deny removes the edit and write tools when a global permissions allow resolves after the plan agent's own `edit` deny (issue #107).
  - The tools are absent entirely, so a read-only turn cannot save plan files under `~/.opencode/plan/*` either. Shell stays available for read-only commands such as `git diff`. The adapter does not deny `shell`, so a read-only turn can still write through shell. A user-set `OPENCODE_CONFIG_CONTENT` is replaced on read-only turns, so permission rules belong in `opencode.json`. Worker turns stay unchanged.
- `copilot`: A read-only turn runs an `explore` subagent through `task` and a `search-subagent` through `search_code_subagent`. Copilot subagents do not inherit the role model, so a read-only turn does not multiply the role-model budget. The subagent still runs and still costs money on its own model. No switch is reliable: `--excluded-tools task` removed `task`, and the model then used `search_code_subagent`.

Per-model usage cannot separate parent tokens from subagent tokens on the same model (#47). Fan-out above rests on tool-call traces and the controlled A/B probe, not on token totals.

### Mutation detection

Before and after every read-only turn (reviewer and orchestrator), including a reviewer turn that runs in the `workspace-write` mode or with no sandbox, the runtime takes a snapshot of the Git work tree, index, and `HEAD`.
If any modified, added, or deleted tracked or untracked file, index change, or commit is detected, the run aborts immediately with a fatal `MutationError` (exit code 1).

**No-revert rule**: Detected modifications are left intact in the work tree so the user can inspect what the agent did.

Known limits:

- Ignored files (matching `.gitignore`) are not tracked.
- Mutations reverted within the same turn are not detected.
- A change anywhere in the repository that contains `--cwd` aborts a read-only turn, even outside `--cwd`.
- With `--reviewer-sandbox workspace-write` or with no sandbox, this check is the only enforcement on the reviewer turn: it detects an edit and does not prevent it, and it does not revert it.
- A `--test-cmd` run happens before the reviewer snapshot. Its writes to the work tree are reported in `testRun` and become the baseline of that turn, so the mutation check does not flag them.

### Remote writes

The mutation check reads only the local work tree, index, and `HEAD`, so the runtime does not detect a remote write in a reviewer or orchestrator turn. A rule in the reviewer prompt, the headless orchestrator prompt, and `docs/orchestrator-instructions.md` forbids a write to GitHub or any remote, for example a push, a merge, a review, or a comment. The rule is advisory and the runtime does not enforce it. A status read such as `agent-loop role wait-checks` or `gh pr checks` is not a write.

Two paths can carry a remote write:

- Shell network. The `claude`, `agy`, and `opencode` read-only invocations keep shell network access (see [Codex read-only network limit](#codex-read-only-network-limit)), so a turn on one of them can run `gh` or `git` and change remote state. A Codex reviewer with no sandbox, the default, keeps shell network too. The `copilot` invocation refuses most shell commands without approval, but it runs `gh pr checks` (see the probe below).
- A GitHub app connector on Codex. The connector is `codex_apps`. A `read-only` or `workspace-write` turn refuses a connector write with `MCP tool call requires approval, but approval policy is never`. A `danger-full-access` turn can post a connector comment, and a Codex reviewer with no sandbox runs in that mode. This applies to a Codex session that has that connector (issue #496).

#### Denial probe (issue #432)

The probe results are in [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md#denial-probe-issue-432). Verified on macOS on 2026-10-05, with a later Windows connector probe on 2026-10-25. Linux is not verified.

The runtime enables no denial. Each candidate fails one of these tests:

- It breaks a read the reviewer needs. A domain allowlist cannot separate `gh pr checks` from `gh pr merge` on `api.github.com`, and a Claude `mcp__*` rule also removes read tools such as `codegraph`.
- It matches a command pattern, which `git -C <dir> push` or an alias bypasses, so it does not deny the path.
- It needs a user-level configuration file that the runtime does not own (`agy`).

Selective MCP write denial, decided per adapter:

- `claude`: not enabled. The deny rule works and keeps the read tools, but it matches tool names, so it covers only the names it lists. GitHub, Google Drive, Slack, and Pipedrive connectors each name their write tools differently, and a server of the user can name them in any way. The shell path stays open on `claude` and carries the same writes through `gh` and `git`, so the rule would narrow one path and leave the other.
- `opencode`: not enabled. The deny rule works and keeps the read tools. [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md#denial-probe-issue-432) records that result. The rule matches tool names, as the `claude` rule does. The runtime configures no MCP server, and the shell path stays open.
- `codex`: enabled for a reviewer with no sandbox. The runtime passes `-c features.apps=false`, the setting behind `--disable apps`, which removed every connector tool in a live turn (issue #496). The connector read tools go too, and the reviewer does not need them, because it reads checks through the shell. The sandboxed modes refuse the connector write already, so they get no setting.
- `copilot`: not needed. The default toolset of the built-in GitHub server has read tools only, and the shell write commands probed were refused by default.

A Codex orchestrator turn, and a Codex reviewer turn in the `read-only` or `workspace-write` mode, need no shell denial, except under the user-rule exception of the section "Codex read-only network limit". A Codex reviewer turn with no sandbox, the default, keeps shell network, so the rule stays advisory there, as on `claude`, `agy`, and `opencode`. The runtime turns the Codex connector off in that turn (see above), so only the shell path remains. The `copilot` shell refusal is a default of the CLI version above and of a configuration without a tool allow list.

A user allow list can restore it. The rule stays advisory on `claude`, `agy`, `opencode`, and a no-sandbox Codex reviewer. A parent that needs enforcement must run those CLIs in a sandbox with no credential for the remote.

The `copilot` result decides the headless wait (#495). The runtime does not give a `copilot` orchestrator the `wait` mode, because the probe found `role wait-checks` refused while `gh pr checks` ran. A `copilot` orchestrator gets the `reviewer` rule when the reviewer CLI keeps shell network, and the `gate` rule otherwise. A `copilot` reviewer still reads the required checks with `gh pr checks`. A `copilot` orchestrator prompt says that its turn keeps shell network and refuses only `role wait-checks` without approval, and that it runs no check read itself.
