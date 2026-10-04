# 0017. Run an operator test command before each reviewer turn

## Status

accepted

## Date

2026-10-04

## Context

A reviewer turn runs read-only: `readOnly = !isWorker` in `runChild`, which for a Codex reviewer is `-c sandbox_mode="read-only"`. Direct probes on 2026-10-04 (macOS, codex-cli 0.162.0-alpha.9) showed that the suite cannot start there. `pnpm exec vitest` exits 1 with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`, and `./node_modules/.bin/vitest` exits 1 with `EPERM` on `node_modules/.vite-temp`. An unsandboxed run passed. The reviewer `Checks` line then excludes the tests.

ADR 0011 already supplies the required-check status to the reviewer prompt from the runtime. A run with no PR, or with unpushed local state, has no CI result to read, so that status does not cover it.

Issue #420 asks for an optional `--test-cmd` that the runtime runs before each reviewer turn and supplies as advisory evidence, with the same mechanism as ADR 0011.

## Decision

1. `--test-cmd <command>` is an optional run input on both paths: a headless option, and an init flag of `agent-loop role`. A run without it changes nothing: the reviewer prompt, the result, the envelope, and the state file keep their earlier shape. `--test-cmd-timeout <seconds>` is the bound (item 4) and needs `--test-cmd`. A blank command is refused at parse time.
2. The runtime runs the command in the run's `--cwd` before each reviewer turn, in the runtime process, so no CLI sandbox applies to it. It never runs before a worker turn. The orchestrator keeps `readOnly: true` and the `withMutationCheck` wrapper, the reviewer keeps its read-only invocation and its mutation check, and no adapter option changes.
3. **Arbitrary command.** The runtime runs a command that the operator wrote, with its own privileges and environment, outside every sandbox.
   - The flag is the only source. The command is read from `--test-cmd` at init (interactive) or from the command line (headless) and from nowhere else. A worker report, a reviewer report, an orchestrator action, a task text, and a prompt never set or change it. Later `role` calls read it from the state file, and the init-flag rule rejects a changed value, as for `--pr`.
   - The state file is written by the runtime at init only, under the runs root outside the work tree. A child process with write access to the runs root could rewrite any field of it, including `cwd` and `pr`. That ceiling is the same as for every state field, and this decision does not close it.
   - The command goes to the platform shell as one string: `/bin/sh -c` on POSIX and `cmd.exe` on Windows (Node `shell: true`). The runtime adds no quoting and no escaping. The operator writes the command in the syntax of the shell that runs it, so a command that quotes one way on POSIX needs its own form on Windows.
   - The environment is the environment of the runtime. A secret in the command text is exposed to the reviewer prompt, the result, and the transcript, so the operator passes secrets by environment and never in the command (item 6).
4. **Time bound.** The default is 600 seconds, because a suite outruns the 60 second `gh` read bound (`DEFAULT_READ_TIMEOUT_MS`). `--test-cmd-timeout` sets it. A command that reaches the bound is killed together with its child processes and is reported as `timed-out`, with `exitCode: null`. That status is neither a failure nor a pass, and the prompt says so. The kill uses execa `killDescendants`: a process group signal on POSIX and `taskkill /T /F` on Windows, so macOS, Linux, and Windows terminate the whole tree. A command that ignores the first signal is force-killed after one second. The bound is separate from the turn `--timeout` and does not count against it. A cancel kills the command the same way and ends the turn as any cancel does.
5. **Output size.** The runtime streams the output and keeps a rolling window of 16 KiB, so memory stays bounded however noisy the command is. The reviewer sees the last 8 KiB of text. The result carries `outputBytes` and `truncated`, and the prompt names the cut.
6. **Output as prompt content.** The tail goes to a model, the result, the state file, and the transcript.
   - The tail is untrusted data. It can hold text that reads as an instruction, so the prompt says so before the tail and puts the tail in a fence that is longer than any backtick run in it. Control characters other than newline and tab are removed.
   - The runtime redacts by exact value: the value of every environment variable whose name contains `token`, `secret`, `passw`, `key`, `credential`, or `auth`, and is at least 8 characters long, becomes `[redacted:NAME]`, in the tail and in the reported command. The runtime does not detect other secrets: a secret that the command derives, encodes, reads from a file, or holds in a variable with another name reaches the reviewer. The prompt tells the reviewer not to repeat one. This is a mitigation, not a guarantee.
7. **Writes to the work tree.** The runtime takes a snapshot before the command and another after it, and reports the diff: `workTreeChanged`, `changedPaths` (at most 20), and `changedCount`. The paths include the `<index>` and `<HEAD>` entries of `diffSnapshots`. The reviewer mutation check takes its baseline after the command, so the command's writes become that baseline and are not a reviewer mutation. The reviewed state therefore describes the tree after the command, and the report is the only record of the change. The prompt tells the reviewer to report the change in `Checks`, and the result carries it to the parent. A change never fails the turn. Ignored files are out of scope, as for every snapshot, so a cache under an ignored directory is not reported.
8. The result is advisory evidence, like the ADR 0011 status. It carries `advisory: true`, and the reviewer treats it as a report, not a verdict. The reviewer can still misreport it in `Checks`, so the runtime reports the result beside the response and a parent compares the two.
9. The command never fails a turn. A failing, timed-out, or unstartable command is a result. A snapshot failure and a cancel still end the turn, as they do for the mutation check.
10. The result is reported as `testRun` in three places: the reviewer prompt, the interactive envelope and `lastResult` in the state file, and the headless result prompt beside the response. A turn with no command carries no `testRun`. The `turns` entry keeps the fixed shape of ADR 0008. The headless initial prompt tells the orchestrator that the run has a command and that it cannot set or change it.
11. The reviewer cannot run a targeted test or an ad-hoc probe, because it sees only the result of the whole command. Issue #421 (an opt-in workspace-write sandbox for the Codex reviewer) covers that need.

## Consequences

- A read-only reviewer holds test evidence from an unsandboxed run, for any run, with or without a PR and with or without pushed state.
- The operator owns the command, so the runtime runs code that no model chose. The risk is the operator's own command line, and the flag is the only way to set it.
- A suite that changes the work tree is reported, and the reviewer reviews the changed tree. Those changes are not caught as a reviewer mutation, so the parent must read the report.
- The tail can still carry a secret that the exact-value redaction does not find. Keep secrets out of the suite output.
- Each reviewer turn pays for one full run of the command, up to the bound. A run that does not need the evidence omits the flag.
- Ignored files, and anything outside the work tree, are not compared.

## Alternatives

1. **Open the reviewer sandbox to run the suite**: it changes a sandbox setting and gives a model write access. Rejected.
2. **Let the orchestrator or the reviewer choose the command**: a model would pick what runs outside the sandbox. Rejected; the flag is the only source.
3. **Run the command without a shell**: it needs an argument parser per platform and rejects `&&` and environment prefixes. Rejected; the operator writes the command for the platform shell.
4. **Pattern-based redaction of secrets in the tail**: it misses unknown formats and rewrites ordinary text. Rejected; exact environment values are the one set the runtime knows.
5. **Take the reviewer baseline before the command and fail on any change**: a test that writes a cache would halt every run. Rejected; the change is reported, and the run goes on.
6. **Record the result in the `turns` entry**: it grows the fixed shape of ADR 0008. Rejected, as ADR 0011 rejected it for the status.

## Authors

Andro Marces

## Links

- [Issue #420: Run a --test-cmd before each reviewer turn and supply the result to the reviewer](https://github.com/andromarces/agent-loops/issues/420)
- [Issue #342: Document that a Codex reviewer on Windows cannot spawn the test runner](https://github.com/andromarces/agent-loops/issues/342)
- Implementation: `runTestCmd` in `src/lib/test-cmd.mjs`, `testRunLines` in `src/prompts/reviewer.mjs`, the run and the `testRun` result field in `runChild` in `src/runtime.mjs`, the init field in `src/role.mjs`, the flags in `src/cli.mjs` and `src/lib/args.mjs`; tests in `tests/lib/test-cmd.test.mjs`, `tests/runtime.test-cmd.test.mjs`, `tests/role.test-cmd.test.mjs`, `tests/cli.test.mjs`, and `tests/prompts/`; documented in `docs/orchestrator-instructions.md` and `README.md`
- [ADR 0011: Supply the required-check status to the reviewer from the runtime](0011-supply-the-required-check-status-to-the-reviewer.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR Index](README.md)
