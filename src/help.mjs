import { supportedAgents } from "./agents/index.mjs";

// Wraps option description text to the column that follows the flag name.
function wrapHelp(text, width = 66) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(32)}`);
}

// Option text shared by both option lists in `printHelp`.
const TEST_CMD_TEXT =
  "Run this command through the platform shell (/bin/sh -c, or cmd.exe on Windows) in --cwd before each reviewer turn, outside the reviewer sandbox. The exit code and an output tail go to the reviewer prompt as advisory evidence. This flag is the only source of the command. It runs with the environment of the runtime, so keep secrets out of the command text. It runs inside a machine-wide test slot (see test-slot); a slot wait that reaches AGENT_LOOP_TEST_SLOT_WAIT (default 1800 seconds) runs no command and reports slot-timeout, which is neither a pass nor a failure.";
const TEST_CMD_TIMEOUT_TEXT =
  "Bound on one --test-cmd run. Defaults to 600. The command's own process group (POSIX) or process tree (Windows) is killed at the bound, and the run reports timed out. An orphan that left the group, or whose parent exited on Windows, can survive (ADR 0017). Requires --test-cmd.";
const REVIEWER_SANDBOX_TEXT =
  'Sandbox of each Codex reviewer turn: read-only or workspace-write. With no flag the reviewer runs with no sandbox (sandbox_mode="danger-full-access"), so it can run the test suite and gh pr checks. Its shell commands can write anywhere the user can write and reach the network, and the mutation check is the only edit guard (ADR 0038). read-only is the earlier default. workspace-write keeps network access off for the shell commands that the sandbox runs. That limit covers shell commands only: model-side tools such as web_search and other channels outside the sandbox are not blocked. A user Codex execpolicy rule that allows bash -c, sh -c, or zsh -c is an exception (ADR 0019). Needs --reviewer codex. The orchestrator turns stay read-only, and the mutation check still halts the run on a change (ADR 0019, ADR 0038).';

/** Prints the `agent-loop` usage text to stdout. */
export function printHelp() {
  console.log(
    `
Usage:

  agent-loop \\
    --orchestrator codex \\
    --worker claude \\
    --reviewer agy \\
    --task "Implement the change."

  agent-loop role dispatch --role worker --prompt-file prompt.txt

  agent-loop --version
  agent-loop role --help

The orchestrator selects actions (run_worker, run_reviewer, finish, abort).
The runtime enforces step limits and mutation boundaries.

Subcommands:

  agent-loop role               Run a single worker or reviewer turn, or finish/abort/extend
                                a run, from a lifecycle state file (see below). One JSON
                                object on stdout, except --help, which prints plain
                                usage; logs on stderr.
  agent-loop install            Install harness entry points and parent guards at user
                                scope. Interactive, or --harness <list> --yes.
  agent-loop uninstall          Remove the installed entry points and guards. Restores
                                files that install changed.
  agent-loop test-slot          Run one command, quoted as one argument, through the
                                platform shell only while fewer than N machine-wide test
                                slots are held by live owners. --slots <n> (env
                                AGENT_LOOP_TEST_SLOTS, default 1) and --wait <seconds>
                                (env AGENT_LOOP_TEST_SLOT_WAIT, default 1800); a flag wins
                                over its env. --if-held runs
                                the command directly while no slot is held. Exits with the
                                command's code, 75 when no slot was won within the wait,
                                64 on a usage error, 130 or 143 on SIGINT or SIGTERM.
                                See agent-loop test-slot --help.
  agent-loop harness-check      Exit 0 only when the nearest harness process above the
                                shell matches the named harness, 3 when another harness
                                is nearest, and 1 when the check cannot run or finds no
                                harness ancestor. Used by the Claude, Codex, and
                                Antigravity skills.

Role operations:

  dispatch (default)            Run one --role turn for the run state at --cwd.
  finish                        End the run; the five-key summary arrives as JSON on stdin,
                                with an optional unresolvedCompare boolean beside the five
                                keys to record an unresolved PR-head compare. Exits 0 for
                                that marker, where the headless loop exits 4.
  abort                         End the run with --reason.
  extend                        Raise the step budget of a non-terminal run to
                                --max-steps, on the same state file, so the stored
                                role session ids stay. The value must exceed both
                                stepsUsed and the current budget. The caller
                                must pass the run's stored --parent-session id; the
                                check compares that id only.
  declare-pr                    Set the run PR once, after init, on a non-terminal run
                                that declared none, for a task whose worker opens the
                                PR. Needs --pr and the stored --parent-session id.
                                Refuses a run that already has a PR, a terminal run,
                                and review-only. The run then ends only through
                                --require-ci <pr> for that PR.
  wait-checks                   Wait for the required checks on --pr to settle, inside
                                --timeout seconds, and print their states with a
                                timedOut flag. The bound starts at command entry
                                and covers work-tree validation and every read;
                                a read that reaches it is stopped and given five
                                seconds to exit, and an exit the command could
                                not observe is reported as
                                childExitUnconfirmed. The total bound is
                                --timeout plus five seconds. With --all it waits
                                on every check of the PR head, not only the
                                required ones. Check states are read from the
                                commit by SHA; head names that commit. A failure
                                that gh pr checks lists settles the wait and is
                                reported in prFailures, apart from checks, because
                                it is not pinned to head.
                                --head <sha> keeps the wait going until the PR
                                head is that commit.
                                Reads status only, so it needs
                                no run state and changes nothing.

Role flags:

  --role worker|reviewer        Role to dispatch. Required for dispatch.
  --cwd <directory>             Target work tree. Must be inside a Git work tree.
                                Defaults to the current directory.
  --parent-session <id>         Required on the init call, on extend, and on declare-pr. The harness
                                session id the parent-edit guard matches; later calls
                                reject a changed value, and extend and declare-pr refuse a mismatch. The headless form (no subcommand) is the explicit
                                unguarded path.
  --task / --task-file / --mode / --worker* / --reviewer* / --max-steps / --timeout / --no-copy-local-files / --copy-local-path
                                First (init) call only. Later calls read these from the
                                state file and reject any attempt to change them.
                                Only extend takes --max-steps after init.
  --prompt-file <path>          Prompt source. Default is stdin.
  --transcript <file>           Append invocation and result events (JSON lines).
  --resume-interrupted          Explicitly continue after an uncertain previous turn.
  --require-accept              finish only: refuse unless the latest reviewer turn
                                accepted the current exact state, with a Checks line
                                (work-first and review-first).
  --pr <pr>                    init or declare-pr. Declares the run PR work on this pull
                                request, so a finish must end through the
                                --require-ci <pr> gate for the same PR. Refuses a
                                finish with no such gate and a finish that sets
                                unresolvedCompare. A base branch whose required-check
                                sources each state that it holds none does not
                                refuse it; the gate passes on the PR head, the
                                clean reviewed tree, and the merge state, and
                                records that no required check exists. A repository
                                whose rulesets are unreadable to the gate, such as a
                                private Free-plan repository, refuses a declared
                                run, so init and declare-pr refuse --pr there before
                                any state is written: omit --pr. Later
                                calls read it from the state file and reject any
                                attempt to change it, except declare-pr on a run
                                that has none. declare-pr and wait-checks also take it.
  --all                         wait-checks only: wait on every check of the PR head,
                                not only the required ones.
  --expect <check name>         wait-checks only, with --all, repeatable: the wait
                                does not settle as a pass until each named check has
                                a check run on the PR head, matched by exact name
                                (trimmed, case-sensitive, any app); a commit status
                                never matches. A check that never registers
                                ends the wait at the bound with timedOut: true and
                                the name in awaiting. A failing check still settles.
  --head <sha>                  wait-checks only: a full lowercase commit SHA. The wait
                                reads no checks until the PR head is that commit, and
                                a wait that reaches the bound first returns
                                timedOut: true with head null and no checks.
  --timeout <seconds>           wait-checks: bound on the wait. Defaults to 300. 0 is
                                refused, because the wait must stay bounded.
  --require-ci <pr>             finish only: refuse unless the PR head matches the
                                reviewed commit, the reviewed tree is clean, the PR is
                                not behind its base under a strict rule, has no merge
                                conflicts, is not blocked, and every required check
                                passed on the commit GitHub evaluates. An app-qualified
                                required check must pass on a check run from that app.
                                A base branch whose required-check sources each
                                state that it holds none has no check to wait for,
                                so the gate passes on the PR head, the clean
                                reviewed tree, and the merge state, and the run
                                records the absence. Refuses a
                                finish that also sets unresolvedCompare.
  --compare-head <pr>           finish only: refuse unless the PR is open, its head
                                matches the reviewed commit, and the reviewed tree is
                                clean (a closed or merged PR refuses). Reads
                                no required-check source and claims no check result, so
                                it serves a repository whose required-check sources are
                                unreadable, such as a private Free-plan repository.
                                Records headCompare: "verified" in the envelope and the
                                state file. Refused with --require-ci, with
                                unresolvedCompare, and by a run that declares a PR.
  --test-cmd <command>          ${wrapHelp(`init only. ${TEST_CMD_TEXT} The state file holds only a digest, so pass the same --test-cmd on every reviewer dispatch; a changed or missing value is refused.`)}
  --test-cmd-timeout <seconds>  ${wrapHelp(TEST_CMD_TIMEOUT_TEXT)}
  --reviewer-sandbox <mode>     ${wrapHelp(`init only. ${REVIEWER_SANDBOX_TEXT} A later call can repeat the stored value or omit the flag, and any other value is refused.`)}
  --reviewer-workspace-write    Alias of --reviewer-sandbox workspace-write.

Options:

  --orchestrator <agent>        Agent that directs the loop. Required.
  --worker <agent>              Agent that implements changes. Required.
  --reviewer <agent>            Agent that reviews the repository (no tracked or unignored change; see --reviewer-sandbox for codex). Required.
  --orchestrator-model <model>  Model passed to the orchestrator CLI. Optional.
  --orchestrator-effort <level> Thinking effort passed to the orchestrator CLI. Optional.
  --worker-model <model>        Model passed to the worker CLI. Optional.
  --worker-effort <level>       Thinking effort passed to the worker CLI. Optional.
  --reviewer-model <model>      Model passed to the reviewer CLI. Optional.
  --reviewer-effort <level>     Thinking effort passed to the reviewer CLI. Optional.

  Model and effort flags record what the caller requested. With opencode and no
  --<role>-model, the adapter passes no --model and OpenCode selects its own
  default, which varies by machine. An explicit --<role>-model passes through,
  and --<role>-effort applies to it as <model>#<effort>. An effort without a
  model is rejected.

  --cwd <directory>             Working directory for the agents. Must be inside a Git work tree. Defaults to current directory.
  --task <text>                 Task description. Required, unless --task-file is given.
  --task-file <path|->          Read the task from a file, or from stdin for -. Replaces --task,
                                and the two cannot be combined. An empty file is refused.
  --mode <mode>                 Loop policy: work-first, review-first, or review-only, the
                                same values the role subcommand takes. review-only
                                dispatches no worker, so it takes neither --pr, nor
                                --require-accept, nor --require-ci, each refused with the
                                wording the role path uses. At runtime it refuses a
                                run_worker action, and refuses a finish until a reviewer
                                turn has run, whatever that turn returned. Off by
                                default, so a run without the flag keeps the current
                                behavior. A repeated --mode takes the last value, as
                                every other repeated value flag here does.
  --max-steps <count>           Maximum child steps. Defaults to 20. 1 to 9007199254740991.
  --timeout <seconds>           Timeout per agent invocation. Defaults to 3600. 0 disables the bound.
  --transcript <file>           Record execution transcript to a JSON file.
  --continue-from <file>        Continue the earlier headless run whose --transcript file this is, with
                                the new --max-steps budget and the earlier orchestrator, worker, and
                                reviewer sessions. The role kinds, the recorded role models and
                                efforts, and --cwd must equal the earlier run's, or the run is
                                refused before any turn. An omitted model or effort matches only
                                an omitted one. For claude, copilot, and opencode, which report the
                                model they resolved, a role whose earlier run recorded one is probed
                                with one read-only turn before any turn of the run, under the
                                mutation check and SIGINT cancel of a child turn. A changed
                                resolved model refuses the run: restore the earlier CLI default
                                or start a new run, because a new --<role>-model value is refused
                                too. A role whose latest recorded turn, failed or not, named no
                                single model, or that has no record, is not checked, and the run
                                warns that the check did not run. codex and agy report no
                                model, so a changed CLI default is not detected for them. The
                                completion gate is restored only when the work tree is the state
                                the earlier run's last reviewer turn reviewed, read from the
                                transcript's events and must equal the gate event that ends it. Otherwise it is reset: no reviewer
                                accept carries over, so a finish after work needs a reviewer turn in
                                this run. Keep --transcript outside the work tree for the restore
                                to apply. The
                                earlier transcript is read once at start, so --transcript can name
                                the same file, and the transcript write is atomic, so a failed write
                                keeps the earlier file.
  --no-copy-local-files         Do not copy local files into a linked --cwd. By default, when --cwd is a
                                linked work tree, the run copies each untracked file of the main work
                                tree that --cwd ignores (agent instructions, harness configuration,
                                .env, .envrc, and the other paths in the reference docs) before the
                                first turn, never overwriting a file and never following a symlink.
                                The transcript names the copied and skipped paths and never a content.
  --copy-local-path <path>      role init only. Repeatable. Add one ignored path of the main work tree to
                                the local-file copy, for example a downloaded specification directory.
                                The path is relative to the main work tree. An absolute path, a path that
                                leaves it or passes through a symlink or junction, a path that holds a
                                tracked file or a file that is not ignored, and use with
                                --no-copy-local-files are refused before any state is written. Every copy rule applies. The init
                                envelope lists the copied files in localFiles.
  --verbose                     Enable debug-level lifecycle logging, including snapshot activity.
  --require-accept              Refuse finish until a reviewer turn reports on the state, and
                                after a worker turn that reviewer turn accepts with a Checks
                                line. Off by default; a repeated refusal, or a refusal with no
                                step budget left, ends the run. A --mode review-only run
                                refuses it outright.
  --pr <pr>                    Declare the run PR work on this pull request. Every finish
                                must end through the --require-ci <pr> gate for the same PR,
                                and a finish that sets unresolvedCompare is refused, because
                                that gate resolves the compare. --pr with --require-ci for
                                another pull request is rejected as a usage error. A
                                declared run with no matching gate cannot finish, and no
                                turn in the run can add the flag. Off by default; a run with
                                neither --pr nor --require-ci keeps the unresolvedCompare
                                marker as the only record of an unresolved compare, until a
                                worker turn opens a PR. The runtime then declares that PR
                                once (ADR 0043). The run then ends through the --require-ci
                                gate for that PR, which the runtime applies (ADR 0045). A
                                --mode review-only run refuses it outright. A run whose
                                repository rulesets are unreadable to the gate, such as
                                a private Free-plan repository, would refuse every finish,
                                so the start refuses --pr there before any turn: omit it. The
                                runtime reads the same sources before it declares a PR that a
                                worker turn opened, and leaves the run undeclared when they are
                                unreadable. A continuation that restored its PR reads nothing at
                                start: the earlier run read at its own --pr start, or before it
                                declared the PR.
  --require-ci <pr>             Refuse finish until the runtime resolves the PR head from
                                this pull request: the PR head must match the reviewed commit,
                                the reviewed tree must be clean, the PR must not be behind its
                                base, must have no merge conflicts, must not be blocked, and
                                every required check must have passed on the commit GitHub
                                evaluates. Refuses a finish that also sets
                                unresolvedCompare. Off by default; without it the
                                unresolvedCompare marker is the only record of an
                                unresolved compare. A --mode review-only run refuses
                                it outright.
  --compare-head <pr>           Refuse finish until this pull request is open, its head equals the
                                reviewed commit, and the reviewed tree is clean (a closed or
                                merged PR refuses). Reads no
                                required-check source and claims no check result, so it serves a
                                repository whose required-check sources are unreadable, such as
                                a private Free-plan repository. A passing finish records a
                                head-compare event and exits 0, distinct from
                                unresolvedCompare (exit 4); a finish that also sets
                                unresolvedCompare is refused. The run names the PR, so use it to
                                update an existing PR. Rejected with --pr, --require-ci, and
                                --mode review-only. A worker-opened PR is not declared in such a
                                run. The transcript records the flag, but --continue-from does
                                not restore it: pass it again, or the continuation runs no
                                runtime compare.
  -h, --help                    Show help. Also valid after role.
  -V, --version                 Print the package version and exit. Must be the first
                                argument.
  --test-cmd <command>          ${wrapHelp(`${TEST_CMD_TEXT} Optional.`)}
  --test-cmd-timeout <seconds>  ${wrapHelp(TEST_CMD_TIMEOUT_TEXT)}
  --reviewer-sandbox <mode>     ${wrapHelp(`${REVIEWER_SANDBOX_TEXT} With --continue-from, an omitted flag keeps the earlier mode, and another value is refused.`)}
  --reviewer-workspace-write    Alias of --reviewer-sandbox workspace-write.

  A value flag also accepts the inline form --flag=value, for example
  --task=-x, which allows a value that starts with a dash. A boolean flag,
  such as --verbose, rejects the inline form.

Environment:

  The loop spawns each agent CLI directly, without a shell. Agents inherit the environment of the process that launched the loop. Start the loop from a shell where direnv or a similar tool already exported the required variables.

Agents:

  ${[...supportedAgents].join("\n  ")}
`.trim(),
  );
}
