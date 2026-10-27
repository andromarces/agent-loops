# Agent Loops reference

The full documentation of Agent Loops. The [README](../README.md) holds the short
version. Each section keeps the anchor that it had in the README.

- [Architecture and supported agents](reference/architecture.md)
  - [Architecture](reference/architecture.md#architecture)
  - [Supported agents](reference/architecture.md#supported-agents)
  - [Closing block recovery](reference/architecture.md#closing-block-recovery)
  - [OpenCode model default](reference/architecture.md#opencode-model-default)
- [Session resume](reference/session-resume.md)
  - [Session resume after a failed turn](reference/session-resume.md#session-resume-after-a-failed-turn)
- [Installation](reference/install.md)
  - [Requirements](reference/install.md#requirements)
  - [Install](reference/install.md#install)
  - [Upgrade](reference/install.md#upgrade)
  - [Uninstall skips](reference/install.md#uninstall-skips)
  - [Run without installing](reference/install.md#run-without-installing)
  - [Install from a Git URL](reference/install.md#install-from-a-git-url)
  - [The `agent-loop` command](reference/install.md#the-agent-loop-command)
  - [From a clone (development)](reference/install.md#from-a-clone-development)
- [Headless runs](reference/usage.md)
  - [Usage](reference/usage.md#usage)
  - [Options](reference/usage.md#options)
  - [Continue a run](reference/usage.md#continue-a-run)
  - [Transcript](reference/usage.md#transcript)
  - [Exit codes](reference/usage.md#exit-codes)
  - [Test slot](reference/usage.md#test-slot)
- [Child dispatch](reference/role.md)
  - [Interactive child dispatch: `agent-loop role`](reference/role.md#interactive-child-dispatch-agent-loop-role)
  - [`wait-checks`](reference/wait-checks.md)
  - [Finish gates: absence rule](reference/finish-gates.md)
- [Interactive parent session](reference/harness-entry-points.md)
  - [Interactive orchestrator: harness entry points](reference/harness-entry-points.md#interactive-orchestrator-harness-entry-points)
  - [Parent guard: hard read-only for the parent session](reference/harness-entry-points.md#parent-guard-hard-read-only-for-the-parent-session)
  - [Local files in a linked work tree](reference/harness-entry-points.md#local-files-in-a-linked-work-tree)
- [Safety](reference/reviewer-safety.md)
  - [Reviewer safety](reference/reviewer-safety.md#reviewer-safety)
  - [Read-only CLI flags](reference/reviewer-safety.md#read-only-cli-flags)
  - [Codex read-only network limit](reference/reviewer-safety.md#codex-read-only-network-limit)
  - [Codex reviewer sandbox mode](reference/reviewer-safety.md#codex-reviewer-sandbox-mode)
  - [Safety trade-off of the no-sandbox mode](reference/reviewer-safety.md#safety-trade-off-of-the-no-sandbox-mode)
  - [Codex read-only child-spawn limit](reference/reviewer-safety.md#codex-read-only-child-spawn-limit)
  - [Read-only subagent fan-out](reference/reviewer-safety.md#read-only-subagent-fan-out)
  - [Mutation detection](reference/reviewer-safety.md#mutation-detection)
  - [Remote writes](reference/reviewer-safety.md#remote-writes)
  - [Denial probe (issue #432)](reference/reviewer-safety.md#denial-probe-issue-432)
- [Maintenance](reference/development.md)
  - [Development](reference/development.md#development)
  - [Releasing](reference/development.md#releasing)
  - [Manual smoke test](reference/development.md#manual-smoke-test)

Other documents:

- [Orchestrator instructions](orchestrator-instructions.md): the role rules for an
  interactive parent session. The core names the reference sections under
  `orchestrator/` and when to read each.
- [Parent guard details](parent-guard.md): every guard target and matcher.
- [Architecture Decision Records](https://github.com/andromarces/agent-loops/blob/main/adr/README.md).
