# 0013. Bound the headless required-check wait with the runtime wait

## Status

accepted

## Date

2026-09-29

## Context

ADR 0010 gave the interactive parent `agent-loop role wait-checks`, a wait with a
stated bound. The headless orchestrator prompt kept the older instruction: run
`gh pr checks <pr> --required --watch` and "bound the watch to a few minutes".
`gh` takes no timeout for a watch, so the prompt could not state a bound, and a
watch that outlasts the per-invocation `--timeout` (default 3600 seconds) ends the
run on exit 1 before the turn returns an action (issue #348, deferred from #329).

## Decision

1. The headless orchestrator runs each wait through `role wait-checks --pr <pr>
--timeout <seconds>`, the operation ADR 0010 defined. The prompt no longer
   names a `gh` watch.
2. The prompt renders the whole command, not a bare `agent-loop`.
   `waitChecksCommand` names `process.execPath`, the `src/cli.mjs` that this
   process runs, and `--cwd` with the run's resolved work tree, each path in
   double quotes. On Windows the separators become forward slashes. The command resolves for a global install,
   an `npm link`, and a clone run through `node <repo>/src/cli.mjs` or
   `pnpm agent-loop`, and the wait reads the run's repository whatever directory
   the shell starts in. `runLoop` passes its `cwd` to `initialPrompt`.
3. The shell forms follow the probes below. On Windows the prompt gives two
   forms and the orchestrator uses the one for the shell its shell tool runs:
   `& "<node>" "<cli>" role wait-checks ...` for PowerShell, and the same command
   without `&` for bash or cmd. Other platforms get the plain form.
4. The Node, CLI, and work tree paths are refused, and the prompt then names no
   wait, when one holds a character that bash, PowerShell, or cmd expands or
   reinterprets inside double quotes. The full set:
   - `"`: ends the string in all three shells.
   - U+201C, U+201D, U+201E: PowerShell reads each as a double quote.
   - `$` and a backtick: variable, subexpression, and escape expansion in bash and
     PowerShell.
   - `%`: environment expansion in cmd, also inside quotes.
   - `!`: delayed expansion in cmd, and history expansion in interactive bash.
   - Any control character (Unicode category Cc), a line break and NUL included.

   A backslash is not in the set on Windows, where it is a path separator and
   the path is rewritten with forward slashes first. On POSIX it is a name
   character that bash reads as an escape inside double quotes, and a rewrite
   would point the command at another path, so a POSIX path holding one is
   refused.

5. The prompt states `<seconds>` and derives it from the run's turn `--timeout`,
   which `runLoop` passes to `initialPrompt`: 300 seconds, or half the turn
   `--timeout` less the five-second child-exit ceiling when that is smaller. With
   `--timeout 0` (unbounded) the value is 300. The wait plus its child-exit
   window always ends before the turn does, and half the turn stays free for the
   orchestrator's own work.
6. A turn `--timeout` under 12 seconds fits no positive bound. The prompt then
   names no wait and tells the orchestrator not to run `gh pr checks` or
   `role wait-checks`. The `--require-ci` gate is the only check read, and a
   refused finish is corrected by a reviewer dispatch or an abort.
7. The status-read exception to the orchestrator role rule covers one command,
   `agent-loop role wait-checks`, the same scope as the interactive instructions.
   It reads status and changes nothing. The headless prompt tells the orchestrator
   not to watch the checks with `gh` directly.
8. A result of `"timedOut": true` is a completed read that left a required check
   pending. It is not a pass and not a finish condition. The orchestrator does not
   wait again in the same turn: it dispatches the reviewer, or aborts with the
   pending check named, and can wait again on a later turn.
9. The prompt keeps the ADR 0010 child-exit rule. `"childExitUnconfirmed": true`
   means the `gh` child was not observed to exit, so the orchestrator settles that
   process before another wait and does not wait again when it cannot.
10. `docs/orchestrator-instructions.md` ("Waiting in the headless loop") and the
    README state the same rule, and a test pins the identical exception sentence in the instructions, the prompt, and the README.

## Consequences

- A headless wait cannot end the run on the turn timeout for any turn
  `--timeout`, and the interactive and headless paths share one bounded wait and
  one timeout outcome.
- The prompt depends on the turn `--timeout` and the run's `cwd`, so
  `initialPrompt` takes both as inputs. A run that passes none gets the
  300-second default and `process.cwd()`.
- The command works wherever the run itself works, because it names the running
  Node binary and CLI script, and it reads the run's work tree. It records install
  and work tree locations in the prompt, so a prompt is not portable to another
  machine.
- A run with a turn `--timeout` under 12 seconds, or a path with a refused
  character, cannot wait, and only the `--require-ci` gate reads the checks.
- known-limit: a non-ASCII path is rendered as is, and cmd reads it through its
  active code page. A path that cmd cannot read fails the command visibly.
- The orchestrator must pick the form for its own shell. A prompt cannot know
  which shell a harness runs, so it lists the forms and the orchestrator chooses.
- The orchestrator can run the command in a read-only turn on `claude`, `agy`,
  and `opencode`. `codex` stays unable to wait, as before. `copilot` keeps
  network for `gh pr checks` but refuses the command without approval (#432
  probe), so a `copilot` orchestrator cannot wait either (#495). A `copilot`
  reviewer still reads the checks.
- Probes on Windows 11 with Node 26 (a Node path and a work tree path holding
  spaces): bash and cmd ran the plain form, and Windows PowerShell 5.1 and
  PowerShell 7 ran the `&` form. PowerShell reported a parser error on the plain
  form, bash reported a syntax error on `&`, and cmd rejected `&`. cmd expanded
  `%VAR%` and, with `/v:on`, `!` inside double quotes. Tests run the forms in the
  shells present on the machine and skip the rest.

## Alternatives

1. **Keep `gh pr checks --watch` and state a smaller "few minutes"**: rejected.
   `gh` has no timeout for a watch and a shell `timeout` is absent on Windows and
   on macOS without GNU coreutils, so the bound stays a request the orchestrator
   cannot enforce.
2. **A fixed 300-second bound in the prompt**: rejected. A run started with a
   turn `--timeout` under about 10 minutes could then wait past the turn.
3. **A one-second floor for a short turn**: rejected in review. A one-second turn
   would receive a wait of up to six seconds, so the guarantee failed at the edge.
   No wait is named instead.
4. **A bare `agent-loop` in the prompt**: rejected in review. A clone run has no
   `agent-loop` on `PATH`, so the command would fail there.
5. **One form with the call operator, or none**: rejected in review. Bash and
   cmd reject `&`, and PowerShell rejects a quoted executable without it, so no
   single quoted-path form runs in all three shells.
6. **A bare `node` on `PATH`**: rejected. The running Node binary may not be on
   `PATH`, and a different `node` could run a different version.
7. **A non-role equivalent command**: rejected. `wait-checks` writes no run state
   and needs no init, so it already serves the headless turn, and a second command
   would duplicate the outcome rules of ADR 0010.
8. **Let the orchestrator wait again in the same turn after a timeout**: rejected.
   The bound is half the turn, so a second wait can outlast the turn.

## Authors

Andro Marces

## Links

- [Issue #348: Bound the headless required-check wait with the runtime wait](https://github.com/andromarces/agent-loops/issues/348)
- Implementation: `headlessWaitSeconds`, `waitChecksCommand`, and the `wait` rule in
  `src/prompts/orchestrator.mjs`, the `timeout` input from `src/runtime.mjs`;
  tests in `tests/prompts/orchestrator.test.mjs` and `tests/runtime.test.mjs`;
  documented in `docs/orchestrator-instructions.md` and `README.md`
- [PR #382](https://github.com/andromarces/agent-loops/pull/382)
- [ADR 0010: A runtime-owned bound on the interactive required-check wait](0010-runtime-owned-required-check-wait-bound.md)
- [ADR Index](README.md)
