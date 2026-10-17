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

`-c sandbox_mode="read-only"` restricts network access of the shell commands that the sandbox runs, as well as writes. It applies to every Codex orchestrator turn, and to a Codex reviewer turn only with `--reviewer-sandbox read-only` (or `workspace-write`, which also keeps network off). A Codex reviewer with no sandbox keeps shell network. It does not block model-side tools. The Codex `web_search` tool ran and returned results in a read-only probe on 2026-10-04 (issue #421). A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception. That rule can run a shell command with an expansion outside the sandbox, with network. The runtime does not prevent that.

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
| none (the default) | no flag                                                                         | `-c sandbox_mode="danger-full-access"`                                              |
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

With no sandbox, the shell commands of the reviewer turn can write anywhere that the user account can write and can reach the network. The mutation check is then the only edit guard, and it sees the repository only. The user execpolicy exception does not apply, because no sandbox exists to skip. Not verified with a live Codex turn: the no-sandbox mode on Windows, macOS, and Linux (issues #708, #709), and under a Codex requirements file that does not allow `danger-full-access` (issue #710).

In `workspace-write`, shell network is off on purpose. The option is set explicitly, because `workspace-write` takes network from the user Codex config when the command line does not set it. `network_access=false` covers the shell commands that the sandbox runs. A model-side tool (for example Codex `web_search`) and any other channel outside the sandbox, such as a connector, are not covered. A user Codex rule that allows `bash -c`, `sh -c`, or `zsh -c` also runs a shell command with an expansion outside the sandbox.

The runtime read of the required-check status for a named PR ([ADR 0024](https://github.com/andromarces/agent-loops/blob/main/adr/0024-supply-the-required-check-status-for-a-named-pr.md)) still reaches
the reviewer.

The probe evidence for the `workspace-write` opt-in mode is in [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md). On macOS, a reviewer ran the local test binary to exit 0, and shell network calls failed. The sandbox blocks `ps`, so the `ps`-gated tests skip. On the unelevated Windows sandbox, `pnpm exec` failed with a store lock error. Linux and the elevated Windows sandbox are not verified.

Accepted gaps of the two sandboxed modes, as ADR 0019 states them (the no-sandbox mode adds the gaps in the section "Safety trade-off of the no-sandbox mode" below):

- Detection only. The sandbox no longer prevents an edit. An edit succeeds, and the run then halts with a `MutationError`, exit 1, with no revert.
- Snapshot blind spots. The snapshot does not see a write to an ignored file (for example `.env` or `node_modules/`), a write outside the repository, a write that the turn restores before it ends, or Git state other than the index and `HEAD` (other refs, the stash, the config). The reviewer prompt tells the turn to remove the output that it created under an ignored path or outside the repository, and to name any that it could not remove in `Notes`. The runtime removes only the per-turn scratch folder that the prompt names first (issue #920, [ADR 0042](https://github.com/andromarces/agent-loops/blob/main/adr/0042-remove-the-reviewer-scratch-folder-in-the-runtime.md)). No runtime step removes other output (issues #865, #906).
- Remote GitHub writes. Shell network is off here, so the opt-in does not open the shell path for `gh` and `git`, except under the user-rule exception in this item. Exception, seen on one machine only (issue #640): a user Codex rule that allows `bash -c`, `sh -c`, or `zsh -c` ran a shell command with an expansion such as `$$` or `$HOME` outside the sandbox, with network and with a write outside the work tree. The runtime does not prevent that. The sandbox does not block a channel outside it, for example a GitHub app connector or another model-side tool, and the local snapshot does not see a remote write over any channel, so a push, a merge, a review, or a comment could change remote state unseen. Codex is the only adapter that blocks shell network in a read-only turn today. Issue #422 holds the rule against remote writes, which is advisory and not enforced.
- A larger prompt-injection blast radius. Reviewed content that holds an instruction can steer a command that writes, not only one that reads.
- Likely no gain on the unelevated Windows sandbox, which blocks a child spawn with `EPERM` under `workspace-write` (`docs/parent-guard.md`). The probe above shows a failed child `node` spawn and a pnpm store lock failure. Not verified for a test runner.

#### Safety trade-off of the no-sandbox mode

- The shell commands of a reviewer turn can write outside the work tree, and the mutation check does not see such a write.
- A command that a reviewer starts can write after its parent ends, and it is not limited to the work tree or to no network ([ADR 0034](https://github.com/andromarces/agent-loops/blob/main/adr/0034-keep-the-codex-reviewer-descendant-gap-after-a-parent-end.md)).
- With shell network on, a reviewer turn can run `gh` and `git` and push, merge, review, or comment. The runtime does not see a remote write. The rule of issue #422 is advisory.
- Reviewed content that holds an instruction can steer a shell command that writes outside the work tree or sends data over the network.
- An operator who needs containment passes `--reviewer-sandbox read-only` or `workspace-write`, or runs the reviewer in an external sandbox with no credential for the remote.

#### Codex read-only child-spawn limit

This limit applies to a Codex reviewer in the `read-only` mode, and to Codex orchestrator turns. A reviewer with no sandbox is not limited this way.

Direct probe of the `read-only` opt-in mode (the reviewer default when it ran): on 2026-09-29, a `codex exec` run on Windows 11 with codex-cli
0.159.0-alpha.12 and `-c sandbox_mode="read-only"` observed two results. A child
`node` spawn from a Node.js process returned an error. `pnpm test --version`
exited 1 with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` (`Access is denied`).
That probe did not start Vitest.

Reports recorded in issue #342, not re-observed: the reviewer turns of the #301,
#302, #311, and #326 runs, on the same CLI version, OS, and the `read-only` mode (then the default), each reported
`Vitest failed at startup (spawn EPERM)`. Some also reported `pnpm` blocked by a
store lock and `oxfmt` failing with `spawn EPERM`. Their reviewer `Checks` lines
therefore excluded the test suite, and the accepts rested on `git diff`, static
checks, and in-process probes. `docs/parent-guard.md` records the same class on
the `workspace-write` path: the unelevated Windows sandbox blocks a child spawn
with `EPERM`.

Direct probe of the `read-only` opt-in mode: on 2026-10-10, a `codex exec` run on macOS with codex-cli
0.163.0-alpha.4 and `-c sandbox_mode="read-only"` ran `pnpm test` in the work
tree. It exited 1 in under one second, before any test started, when `vp` failed
to load `vite.config.mjs` with `EPERM: operation not permitted, mkdir
'<repo>/node_modules/.vite-temp'`. The pnpm store lock of the Windows probe did
not appear. The work tree stayed clean. The same class of failure showed on
2026-10-04 (codex-cli 0.162.0-alpha.9, `vitest` run directly). A Codex
reviewer in the `read-only` mode on macOS therefore cannot run the test suite. A reviewer
with no sandbox, the default since [ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md), is not limited this way. That claim is not verified with a live turn (issue #708).

Not verified: a Codex reviewer in the `read-only` mode on Linux, and a Codex reviewer under the
elevated Windows sandbox. Do not assume the test suite runs on either in a sandboxed mode.

#### Read-only subagent fan-out

Every adapter can fan out from a read-only turn to child subagents. Probes on 2026-09-23 measured each installed CLI.

- `claude`: Plan mode delegates research to the built-in Explore and Plan subagents. They inherit the role model (Explore is capped at Opus on the Claude API). The adapter sets `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` on read-only turns only, so plan mode reads files directly. Worker turns stay unchanged. The variable disables only the built-in Explore and Plan subagents; the general-purpose and custom subagents stay available. Requires Claude Code v2.1.198 or later; older versions ignore the variable.
- `codex`: A read-only `exec` turn kept the collaboration tools. On codex-cli 0.156.1 the session rollout recorded a `spawn_agent` call and its subagent reply, while `--json` collapsed the spawn into a `collab_tool_call`. The `<multi_agent_role>` developer message and the `spawn_agent` tool description state that subagents inherit the parent model and reasoning effort. No switch disables it: `--disable multi_agent`, `--disable multi_agent_v2`, `-c features.multi_agent=false`, `-c agents.max_depth=0`, and `--ignore-user-config` each still spawned a subagent. A read-only codex turn can therefore cost the parent model a multiple of what the transcript suggests.
- `agy`: On Antigravity CLI 1.2.8, a plan-mode turn ran a `research` subagent through `invoke_subagent`, visible as a `step_type: "subagent"` step in `--output-format stream-json`. The binary defaults a subagent `model` to `inherit`, the parent model. No CLI flag or setting disables it.
- `opencode`: On OpenCode v0.0.0-dev-20030, a plan turn ran an `explore` subagent through the `subagent` tool, visible as a `tool_use` event in `run --format json`. The `explore` and `general` agents set no model, so they inherit the session model. The adapter sets `OPENCODE_CONFIG_CONTENT` with `subagent` and `edit` denies on read-only turns only; an A/B run through the adapter showed the `subagent` tool call without the deny and no such call with it. OpenCode merges that per-turn document after the user config, so the `edit` deny removes the edit and write tools even when a global permissions allow resolves after the plan agent's own `edit` deny (issue #107, probed on v0.0.0-dev-20033). The tools are absent entirely, so a read-only turn cannot save plan files under `~/.opencode/plan/*` either. Shell stays available for read-only commands such as `git diff`; the adapter does not deny `shell`, so a read-only turn can still write through shell. A user-set `OPENCODE_CONFIG_CONTENT` is replaced on read-only turns, so permission rules belong in `opencode.json`. Worker turns stay unchanged.
- `copilot`: On Copilot CLI 1.0.89-0, a read-only turn ran an `explore` subagent through `task` and a `search-subagent` through `search_code_subagent`, visible in `--output-format json`. The `subagent.started` event carried `modelSelectionSource: "agent_definition_default"`, and the subagent ran on `gpt-5.6-luna` while the parent ran on `gpt-5.4`. Copilot subagents do not inherit the role model, so a read-only turn does not multiply the role-model budget; the subagent still runs and still costs money on its own model. No switch is reliable: `--excluded-tools task` removed `task`, and the model then used `search_code_subagent`.

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
- A GitHub app connector on Codex. A read-only Codex probe on 2026-10-04, codex-cli 0.162.0-alpha.9, listed GitHub write tools from the connector (server name `codex_apps`), for example `github_create_issue`, `github_update_issue`, `github_add_comment_to_issue`, and `github_merge_pull_request`. The probe observed only that the tools were listed in a read-only turn. A write through those tools was not probed, so whether it succeeds or is refused is unverified. The observation applies to a Codex session that has that connector.

#### Denial probe (issue #432)

Probed on 2026-10-05, macOS. A probe never wrote to a remote. Network denial used a read of `https://example.com`. Connector denial used tool listings and event streams. A "pass" below is a shell result on this machine for one run.

| Adapter (version)                       | Shell network                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Connector or MCP write tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` (2.1.289)                      | Can deny. With the runtime flags (`--permission-mode plan`) the fetch returned `200`. With `--settings '{"sandbox":{"enabled":true,"network":{"allowedDomains":[]}}}'` it failed with `CONNECT tunnel failed, response 403`. The allowlist works per domain, not per HTTP method.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Can deny. `--disallowedTools mcp__<server>` removed that server's tools from the `system init` tool list (`codegraph`, Google Drive), and `mcp__*` removed every MCP tool. A rule scoped to write tool names also works: `--disallowedTools 'mcp__*__merge_pull_request,mcp__*__push_files,mcp__*__create_*,mcp__*__*_write,mcp__*__add_*'` removed 12 GitHub connector tools from the init tool list and kept `get_file_contents`, `list_pull_requests`, and `pull_request_read`. The connector count in the init event varied between runs with connector timing. |
| `codex` (codex-cli 0.162.0-alpha.14)    | Already denied by `sandbox_mode="read-only"`, which the Codex orchestrator and a reviewer in the `read-only` or `workspace-write` mode run under: the fetch failed with `Could not resolve host`. A user execpolicy rule is an exception (see "Codex read-only network limit"). A Codex reviewer with no sandbox, the default since ADR 0038, keeps shell network. This probe did not cover that mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Not verified. `--disable apps` (`features.apps=false`, documented as "apps are not surfaced to the model") was accepted and dropped the recommended-plugins block from `codex debug prompt-input`. This session listed no `github` tool with or without the flag, so the effect on `codex_apps` write tools was not observed.                                                                                                                                                                                                                                       |
| `agy` (1.2.17)                          | Not denied. `--mode plan --sandbox` returned `200`. The docs say sandboxed shell commands run without network, and that the sandbox, `permissions.deny`, and `read_url` come from `~/.gemini/antigravity-cli/settings.json`. No per-invocation flag sets them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Not probed beyond `agy mcp list`, which showed only the user `codegraph` server. `agy mcp disable <name>` writes the user configuration, so the runtime cannot use it per turn.                                                                                                                                                                                                                                                                                                                                                                                     |
| `opencode` (v0.0.0-dev-20570)           | Can deny by command pattern only. `OPENCODE_CONFIG_CONTENT` with `{"action":"shell","resource":"curl *","effect":"deny"}` gave `Permission denied: shell`. `{"action":"bash",...}` did not match in this build and the fetch returned `200`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Inconclusive. The docs say a permission key such as `<server>_*` denies every tool of an MCP server. With a `codegraph` MCP server added through `OPENCODE_CONFIG_CONTENT`, this build called the server through an `execute` tool, and the rule `{"action":"*_explore",...}` produced no denial event, so a selective rule was not verified.                                                                                                                                                                                                                       |
| `copilot` (GitHub Copilot CLI 1.0.92-4) | Partly denied by default, with the exact runtime arguments (`--session-id <id> -s --no-ask-user --output-format json --deny-tool write`, prompt on stdin). Refused with `Permission denied because no interactive user response was available`: `curl` to `https://example.com` (3 of 3 runs), `gh pr merge --help`, `gh issue comment --help`, `gh api --help`, and `"node" "<cli>" role wait-checks --pr 489 --timeout 30 --cwd "<tree>"` (2 of 2 runs). Ran with network: `gh pr checks 489 --required` (3 of 3 runs, including 2 with the exact command). `git push -h` ended with a failed tool call and no message. The denial is a Copilot default, not a runtime setting. The user configuration on this machine sets no tool allow list (`trustedFolders` only). With `--allow-all-tools` the fetch returned `200`, and `--deny-tool 'shell(curl)'` refused it. | The built-in `github-mcp-server` connected, and the model listed only read tools (`get_file_contents`, `search_code`, `search_users`, and two Copilot space reads). `--disable-builtin-mcps` removed `github-mcp-server` and kept the user `codegraph` server. `--enable-all-github-mcp-tools` would add write tools.                                                                                                                                                                                                                                               |

The runtime enables no denial. Each candidate fails one of these tests:

- It breaks a read the reviewer needs. A domain allowlist cannot separate `gh pr checks` from `gh pr merge` on `api.github.com`, and a Claude `mcp__*` rule also removes read tools such as `codegraph`.
- It matches a command pattern, which `git -C <dir> push` or an alias bypasses, so it does not deny the path.
- Its effect on the write tools was not observed (Codex `--disable apps`, OpenCode MCP rules).
- It needs a user-level configuration file that the runtime does not own (`agy`).

Selective MCP write denial, decided per adapter:

- `claude`: not enabled. The deny rule works and keeps the read tools, but it matches tool names, so it covers only the names it lists. GitHub, Google Drive, Slack, and Pipedrive connectors each name their write tools differently, and a server of the user can name them in any way. The shell path stays open on `claude` and carries the same writes through `gh` and `git`, so the rule would narrow one path and leave the other.
- `opencode`: not enabled. A selective MCP rule was not verified (see the table), the runtime configures no MCP server, and the shell path stays open.
- `copilot`: not needed. The default toolset of the built-in GitHub server has read tools only, and the shell write commands probed were refused by default.

A Codex orchestrator turn, and a Codex reviewer turn in the `read-only` or `workspace-write` mode, need no shell denial, except under the user-rule exception of the section "Codex read-only network limit". A Codex reviewer turn with no sandbox, the default, keeps shell network, so the rule stays advisory there, as on `claude`, `agy`, and `opencode`. The Codex connector path stays unverified. The `copilot` shell refusal is a default of the CLI version above and of a configuration without a tool allow list. A user allow list can restore it. The rule stays advisory on `claude`, `agy`, `opencode`, and a no-sandbox Codex reviewer. A parent that needs enforcement must run those CLIs in a sandbox with no credential for the remote.

The `copilot` result decides the headless wait (#495). The runtime does not give a `copilot` orchestrator the `wait` mode, because the probe found `role wait-checks` refused while `gh pr checks` ran. A `copilot` orchestrator gets the `reviewer` rule when the reviewer CLI keeps shell network, and the `gate` rule otherwise. A `copilot` reviewer still reads the required checks with `gh pr checks`. A `copilot` orchestrator prompt says that its turn keeps shell network and refuses only `role wait-checks` without approval, and that it runs no check read itself.
