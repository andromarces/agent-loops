#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultAgents, normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT,
  MODES,
  REVIEW_ONLY_GATE_REFUSAL,
  REVIEW_ONLY_PR_REFUSAL,
  ROLE_KINDS as ROLES,
  assertOpenCodeOptions,
  modeError,
  readArgValue,
  readInlineValue,
  readMaxSteps,
  readNonNegativeInt,
  readPositiveInt,
  readStdinText,
  readTaskFile,
  roleFlags,
  splitInlineFlag,
  TASK_SOURCE_CONFLICT,
  reviewerWorkspaceWriteError,
  testCmdError,
} from "./lib/args.mjs";
import {
  carryEarlierEvents,
  gateFromTranscript,
  readContinuation,
  restoreSessions,
  verifyResolvedModels,
} from "./lib/continuation.mjs";
import { isEntryPoint } from "./lib/entrypoint.mjs";
import { readProp, redactedText } from "./lib/error-message.mjs";
import {
  runHarnessCheckCommand,
  runInstallCommand,
  runUninstallCommand,
} from "./install/commands.mjs";
import { logWarn, setVerbose } from "./lib/log.mjs";
import { writeFileAtomic } from "./lib/runstate.mjs";
import { assertGitWorkTree, workTreeRoot } from "./lib/snapshot.mjs";
import { redactCommandText } from "./lib/test-cmd.mjs";
import { runLoop, runProbeTurn, UNRESOLVED_COMPARE_EXIT } from "./runtime.mjs";
import { main as runRoleMain } from "./role.mjs";

const ROLE_FLAGS = roleFlags(ROLES);

export function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    task: null,
    taskFile: null,
    maxSteps: DEFAULT_MAX_STEPS,
    timeout: DEFAULT_TIMEOUT,
    transcript: null,
    verbose: false,
    requireAccept: false,
    pr: null,
    requireCi: null,
    testCmd: null,
    testCmdTimeout: null,
    reviewerWorkspaceWrite: false,
    mode: null,
    continueFrom: null,
    copyLocalFiles: true,
  };
  for (const role of ROLES) {
    options[role] = null;
    options[`${role}Model`] = null;
    options[`${role}Effort`] = null;
  }

  const readValue = (flag, index, allowDash) => readArgValue(argv, flag, index, allowDash);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const inline = splitInlineFlag(raw);
    const arg = inline ? inline.flag : raw;
    let inlineUsed = false;
    const readInline = (flag, allowDash) => {
      if (!inline) {
        return readValue(flag, ++i, allowDash);
      }
      inlineUsed = true;
      return readInlineValue(inline, flag);
    };

    if (Object.hasOwn(ROLE_FLAGS, arg)) {
      options[ROLE_FLAGS[arg]] = readInline(arg);
      continue;
    }

    switch (arg) {
      case "--cwd":
        options.cwd = resolve(readInline(arg));
        break;

      case "--task":
        options.task = readInline(arg);
        break;

      case "--task-file":
        options.taskFile = readInline(arg, true);
        break;

      case "--max-steps":
        options.maxSteps = readMaxSteps(readInline("--max-steps"));
        break;

      case "--timeout": {
        const seconds = readNonNegativeInt("--timeout", readInline("--timeout"));
        options.timeout = seconds === 0 ? null : seconds;
        break;
      }

      case "--transcript":
        options.transcript = resolve(readInline(arg));
        break;

      case "--verbose":
        options.verbose = true;
        break;

      case "--require-accept":
        options.requireAccept = true;
        break;

      case "--no-copy-local-files":
        options.copyLocalFiles = false;
        break;

      case "--pr":
        options.pr = readPositiveInt("--pr", readInline("--pr"));
        break;

      case "--require-ci":
        options.requireCi = readPositiveInt("--require-ci", readInline("--require-ci"));
        break;

      case "--test-cmd":
        options.testCmd = readInline(arg);
        break;

      case "--test-cmd-timeout":
        options.testCmdTimeout = readPositiveInt(arg, readInline(arg));
        break;

      case "--reviewer-workspace-write":
        options.reviewerWorkspaceWrite = true;
        break;

      case "--continue-from":
        options.continueFrom = resolve(readInline(arg));
        break;

      case "--mode":
        options.mode = readInline("--mode");
        if (!MODES.has(options.mode)) {
          throw new Error(modeError(options.mode));
        }
        break;

      case "--help":
      case "-h":
        if (inline) {
          throw new Error(`${arg} does not take a value.`);
        }
        printHelp();
        process.exit(0);
        break;

      default:
        throw new Error(`Unknown argument: ${raw}`);
    }

    // A flag that read no value is boolean, so an inline value is an error
    // rather than a silently dropped argument.
    if (inline && !inlineUsed) {
      throw new Error(`${arg} does not take a value.`);
    }
  }

  for (const role of ROLES) {
    if (!options[role]) {
      throw new Error(`Missing required --${role}.`);
    }
    if (!supportedAgents.has(options[role])) {
      throw new Error(`Unsupported ${role}: ${options[role]}`);
    }
  }

  for (const role of ROLES) {
    assertOpenCodeOptions(role, options[role], options[`${role}Model`], options[`${role}Effort`]);
  }
  if (options.task !== null && options.taskFile !== null) {
    throw new Error(TASK_SOURCE_CONFLICT);
  }
  // A task file is read in `main`, which then applies the same check.
  if (options.taskFile === null) {
    assertTask(options.task);
  }

  const testCmdRefusal = testCmdError(options.testCmd, options.testCmdTimeout);
  if (testCmdRefusal) {
    throw new Error(testCmdRefusal);
  }

  const sandboxRefusal = reviewerWorkspaceWriteError(
    options.reviewerWorkspaceWrite,
    options.reviewer,
  );
  if (sandboxRefusal) {
    throw new Error(sandboxRefusal);
  }

  // A review-only run dispatches no worker, so it gates no PR: neither
  // declaration nor gate nor the accept rule has a finish to apply to. All three
  // arrive on this one command line, so the interactive path's refusals move
  // here and keep their wording, shared from one constant each (#337).
  if (options.mode === "review-only") {
    if (options.pr !== null) {
      throw new Error(REVIEW_ONLY_PR_REFUSAL);
    }
    if (options.requireAccept || options.requireCi !== null) {
      throw new Error(REVIEW_ONLY_GATE_REFUSAL);
    }
  }

  // The headless path takes both flags on one command line, so a gate for another
  // pull request is knowable before the run starts. The runtime refuses a finish
  // for that mismatch as a defensive check, and the interactive `role` path keeps
  // the refusal because its `--require-ci` arrives only at `finish` (#302).
  if (options.pr !== null && options.requireCi !== null && options.pr !== options.requireCi) {
    throw new Error(
      `--pr ${options.pr} and --require-ci ${options.requireCi} must name the same pull request.`,
    );
  }

  return options;
}

function assertTask(task) {
  if (task === null || String(task).trim() === "") {
    throw new Error(
      'Missing required --task. Provide the task, for example --task "Implement the change."',
    );
  }
}

function printHelp() {
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
  wait-checks                   Wait for the required checks on --pr to settle, inside
                                --timeout seconds, and print their states with a
                                timedOut flag. The bound starts at command entry
                                and covers work-tree validation and every read;
                                a read that reaches it is stopped and given five
                                seconds to exit, and an exit the command could
                                not observe is reported as
                                childExitUnconfirmed. The total bound is
                                --timeout plus five seconds. Reads status only,
                                so it needs no run state and changes nothing.

Role flags:

  --role worker|reviewer        Role to dispatch. Required for dispatch.
  --cwd <directory>             Target work tree. Must be inside a Git work tree.
                                Defaults to the current directory.
  --parent-session <id>         Required on the init call and on extend. The harness
                                session id the parent-edit guard matches; later calls
                                reject a changed value, and extend refuses a mismatch. The headless form (no subcommand) is the explicit
                                unguarded path.
  --task / --task-file / --mode / --worker* / --reviewer* / --max-steps / --timeout / --no-copy-local-files
                                First (init) call only. Later calls read these from the
                                state file and reject any attempt to change them.
                                Only extend takes --max-steps after init.
  --prompt-file <path>          Prompt source. Default is stdin.
  --transcript <file>           Append invocation and result events (JSON lines).
  --resume-interrupted          Explicitly continue after an uncertain previous turn.
  --require-accept              finish only: refuse unless the latest reviewer turn
                                accepted the current exact state, with a Checks line
                                (work-first and review-first).
  --pr <pr>                    init only. Declares the run PR work on this pull
                                request, so a finish must end through the
                                --require-ci <pr> gate for the same PR. Refuses a
                                finish with no such gate and a finish that sets
                                unresolvedCompare. A base branch whose required-check
                                sources each state that it holds none does not
                                refuse it; the gate passes on the PR head, the
                                clean reviewed tree, and the merge state, and
                                records that no required check exists. A private
                                GitHub Free-plan repository still refuses a
                                declared run, so it must omit --pr. Later
                                calls read it from the state file and reject any
                                attempt to change it.
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
  --test-cmd <command>          init only. Run this command through the platform shell
                                (/bin/sh -c, or cmd.exe on Windows) in --cwd before each
                                reviewer turn, outside the reviewer sandbox, and supply the
                                exit code and an output tail to the reviewer prompt as
                                advisory evidence. This flag is the only source of the
                                command. It runs with the environment of the runtime, so keep
                                secrets out of the command text. The state file holds only a
                                digest, so pass the same --test-cmd on every reviewer dispatch;
                                a changed or missing value is refused.
  --test-cmd-timeout <seconds>  Bound on one --test-cmd run. Defaults to 600. The command and its
                                command's own process group (POSIX) or process tree (Windows)
                                is killed at the bound, and the run reports timed out. An
                                orphan that left the group, or whose parent exited on Windows,
                                can survive (ADR 0017). Requires --test-cmd.
  --reviewer-workspace-write    init only. Run each Codex reviewer turn in the workspace-write
                                sandbox, instead of read-only, with network access off for the
                                shell commands that the sandbox runs. That limit covers shell
                                commands only: model-side tools such as web_search and other
                                channels outside the sandbox are not blocked. Needs --reviewer
                                codex. The orchestrator turns stay read-only, and the mutation
                                check still halts the run on a change (ADR 0019). Off by default.

Options:

  --orchestrator <agent>        Agent that directs the loop. Required.
  --worker <agent>              Agent that implements changes. Required.
  --reviewer <agent>            Agent that reviews the repository (read-only). Required.
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
                                an omitted one. For claude and copilot, which report the model
                                they resolved, a role whose earlier run recorded one is probed
                                with one read-only turn before any turn of the run, under the
                                mutation check and SIGINT cancel of a child turn. A changed
                                resolved model refuses the run: restore the earlier CLI default
                                or start a new run, because a new --<role>-model value is refused
                                too. A role whose latest recorded turn, failed or not, named no
                                single model, or that has no record, is not checked, and the run
                                warns that the check did not run. codex, agy, and opencode report
                                no model, so a changed CLI default is not detected for them. The
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
                                .env, .envrc, and the other paths in the README) before the first
                                turn, never overwriting a file and never following a symlink. The
                                transcript names the copied and skipped paths and never a content.
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
                                marker as the only record of an unresolved compare. A
                                --mode review-only run refuses it outright.
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
  -h, --help                    Show help. Also valid after role.
  -V, --version                 Print the package version and exit. Must be the first
                                argument.
  --test-cmd <command>          Run this command through the platform shell (/bin/sh -c, or
                                cmd.exe on Windows) in --cwd before each reviewer turn, outside
                                the reviewer sandbox, and supply the exit code and an output
                                tail to the reviewer prompt as advisory evidence. This flag is
                                the only source of the command. It runs with the environment
                                of the runtime, so keep secrets out of the command text.
                                Optional.
  --test-cmd-timeout <seconds>  Bound on one --test-cmd run. Defaults to 600. The command and its
                                command's own process group (POSIX) or process tree (Windows)
                                is killed at the bound, and the run reports timed out. An
                                orphan that left the group, or whose parent exited on Windows,
                                can survive (ADR 0017). Requires --test-cmd.
  --reviewer-workspace-write    Run each Codex reviewer turn in the workspace-write sandbox,
                                instead of read-only, with network access off for the shell
                                commands that the sandbox runs. That limit covers shell
                                commands only: model-side tools such as web_search and other
                                channels outside the sandbox are not blocked. Needs --reviewer
                                codex. The orchestrator turns stay read-only, and the mutation
                                check still halts the run on a change (ADR 0019). Off by default.

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

function sameFile(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function formatSummary(summary) {
  return [
    `Changed: ${summary.changed}`,
    `Verified: ${summary.verified}`,
    `Deferred: ${summary.deferred}`,
    `Not done: ${summary.notDone}`,
    `Open: ${summary.open}`,
  ].join("\n");
}

export async function main(
  argv = process.argv.slice(2),
  agents = defaultAgents,
  { stdin = readStdinText } = {},
) {
  if (argv[0] === "--version" || argv[0] === "-V") {
    // Read on demand: install fixtures copy src without package.json.
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
    console.log(version);
    return;
  }

  if (argv[0] === "role") {
    await runRoleMain(argv.slice(1), { agents });
    return;
  }

  if (argv[0] === "install") {
    await runInstallCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "uninstall") {
    await runUninstallCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "harness-check") {
    await runHarnessCheckCommand(argv.slice(1));
    return;
  }

  let options;
  try {
    options = parseArgs(argv);
    if (options.taskFile !== null) {
      options.task = await readTaskFile(options.taskFile, stdin);
      assertTask(options.task);
    }
  } catch (err) {
    console.error(`\n${redactedText(readProp(err, "message") ?? err)}`);
    process.exitCode = 1;
    return;
  }

  setVerbose(options.verbose);

  const events = [];
  const roles = {};
  for (const role of ROLES) {
    roles[role] = {
      kind: normalizeAgent(options[role]),
      model: options[`${role}Model`],
      effort: options[`${role}Effort`],
      sessionId: null,
    };
  }
  // Created before the continuation check, so a SIGINT during a probe turn cancels it.
  const controller = new AbortController();
  const onSigInt = () => {
    controller.abort();
  };
  process.once("SIGINT", onSigInt);
  let earlierGate = null;
  // A refused continuation writes no transcript: --transcript may name the
  // --continue-from file, and a refusal must not overwrite the sessions it holds.
  if (options.continueFrom) {
    try {
      const earlier = await readContinuation(options.continueFrom);
      restoreSessions(roles, earlier, options.cwd);
      await verifyResolvedModels(roles, {
        probe: (state, role) =>
          runProbeTurn({
            agents,
            state,
            roleName: role,
            cwd: options.cwd,
            timeout: options.timeout,
            signal: controller.signal,
          }),
      });
      earlierGate = gateFromTranscript(earlier);
      // --transcript rewrites its file at exit, so a run that names the file it
      // continues carries the earlier events into the rewrite, then a boundary
      // event that keeps the earlier outcome the rewrite replaces.
      if (options.transcript && sameFile(options.transcript, options.continueFrom)) {
        carryEarlierEvents(events, earlier);
      }
    } catch (err) {
      process.removeListener("SIGINT", onSigInt);
      console.error(`
${redactedText(readProp(err, "message") ?? err)}`);
      process.exitCode = readProp(err, "isCanceled") ? 130 : 1;
      return;
    }
  }
  // The mode is recorded only when the run named one, so a mode-free run writes
  // the transcript shape origin/main wrote and a consumer of that file sees no
  // field this flag introduced (#337).
  const transcriptData = {
    task: options.task,
    cwd: options.cwd,
    options: {
      maxSteps: options.maxSteps,
      timeout: options.timeout,
      requireAccept: options.requireAccept,
      pr: options.pr,
      requireCi: options.requireCi,
      ...(options.testCmd === null
        ? {}
        : { testCmd: redactCommandText(options.testCmd), testCmdTimeout: options.testCmdTimeout }),
      ...(options.reviewerWorkspaceWrite ? { reviewerWorkspaceWrite: true } : {}),
      ...(options.mode === null ? {} : { mode: options.mode }),
      ...(options.continueFrom ? { continueFrom: options.continueFrom } : {}),
      ...(options.copyLocalFiles ? {} : { copyLocalFiles: false }),
    },
    roles,
    events,
    exitCode: 1,
    error: null,
  };

  // The pre-assigned session id of the turn that is running, with the mark that no CLI output
  // confirmed it. It exists only in the written record, never on the role state, so the adapter
  // alone decides what a failed turn keeps (issue #564). Cleared when the CLI call ends.
  let pendingSession = null;

  const writeTranscript = async () => {
    if (!options.transcript) return;
    try {
      const { role, id } = pendingSession ?? {};
      const data = pendingSession
        ? {
            ...transcriptData,
            roles: {
              ...roles,
              [role]: { ...roles[role], sessionId: id, sessionUnconfirmed: true },
            },
          }
        : transcriptData;
      // Atomic, because the file can be the --continue-from source: a crash or a
      // failed write must leave the earlier record whole.
      await writeFileAtomic(options.transcript, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(
        redactedText(
          `Warning: Failed to write transcript to ${options.transcript}: ${redactedText(readProp(err, "message"))}`,
        ),
      );
    }
  };

  // The orchestrator and the reviewer run under the mutation check, which covers the whole Git work
  // tree, not only --cwd. A transcript inside that tree is written during their turn, so the check
  // exempts that one path and still covers every other (issue #581). Returns the path from the
  // repository root with `/` separators, or null when the transcript is outside the tree.
  const transcriptTreePath = async () => {
    const real = (path) => realpath(path).catch(() => resolve(path));
    const root = await real(await workTreeRoot(options.cwd));
    const from = relative(
      root,
      join(await real(dirname(options.transcript)), basename(options.transcript)),
    );
    // Segment test: a directory named `..records` is inside.
    return from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)
      ? null
      : from.split(sep).join("/");
  };
  const onSessionAssigned = async (role, id) => {
    pendingSession = id ? { role, id } : null;
    await writeTranscript();
  };

  // The command result and work tree compare of a turn that ended in a fatal error. The
  // run has no result event for that turn, so the error report carries them, and a parent
  // that gave no --transcript still receives the evidence the runtime read (ADR 0017).
  let fatalTestRun = null;

  // `failed` is explicit, because a thrown value can be falsy (null, 0, "") and must still record.
  // An empty error text gets a fallback so a failed run never records or prints a blank error.
  const finish = async ({ exitCode, error, failed }) => {
    const errorText = failed
      ? redactedText(readProp(error, "message") ?? error) ||
        redactedText("Run failed with an empty error message.")
      : null;
    transcriptData.exitCode = exitCode;
    transcriptData.error = errorText;
    await writeTranscript();
    if (failed) {
      console.error(`\n${errorText}`);
      if (fatalTestRun) {
        console.error(
          `\nTest command result before the failed turn (advisory):\n${JSON.stringify(fatalTestRun, null, 2)}`,
        );
      }
    }
    process.exitCode = exitCode;
  };

  try {
    try {
      await assertGitWorkTree(options.cwd);
    } catch (err) {
      await finish({ exitCode: 1, error: err, failed: true });
      return;
    }

    const onEvent = (event) => {
      if (event.type === "invocation") {
        pendingSession = null;
      }
      if (event.type === "test-run") {
        fatalTestRun = event.testRun;
      }
      if (options.transcript) {
        events.push({
          ...event,
          at: new Date().toISOString(),
        });
      }

      if (event.type === "action") {
        console.log("\n===== ORCHESTRATOR =====\n");
        console.log(JSON.stringify(event.action, null, 2));
      } else if (event.type === "result") {
        const banner =
          event.role === "worker" ? `WORKER ${event.stepsUsed}` : `REVIEWER ${event.stepsUsed}`;
        console.log(`\n===== ${banner} =====\n`);
        if (event.result.status === "ok") {
          console.log(event.result.response);
        } else {
          console.log(`Error: ${event.result.error}`);
        }
      }
    };

    try {
      const exemptPath = options.transcript ? await transcriptTreePath() : null;
      const result = await runLoop({
        task: options.task,
        cwd: options.cwd,
        maxSteps: options.maxSteps,
        timeout: options.timeout,
        requireAccept: options.requireAccept,
        pr: options.pr,
        requireCi: options.requireCi,
        testCmd: options.testCmd,
        testCmdTimeout: options.testCmdTimeout,
        reviewerWorkspaceWrite: options.reviewerWorkspaceWrite,
        mode: options.mode,
        continued: Boolean(options.continueFrom),
        earlierGate,
        copyLocalFiles: options.copyLocalFiles,
        // A rewrite of the transcript before the CLI starts keeps the pre-assigned id across a
        // parent crash. known-limit: a failed write only warns, as at exit, and runs that share
        // one transcript path have no write coordination (issue #564).
        ...(options.transcript ? { onSessionAssigned, exemptPath } : {}),
        signal: controller.signal,
        roles: transcriptData.roles,
        agents,
        onEvent,
      });
      // The last event of a run that returned an exit code: its gate state, which a
      // later --continue-from checks against a replay of the events (#393). A
      // thrown error leaves none.
      if (options.transcript) {
        events.push({ type: "gate", ...result.gate, at: new Date().toISOString() });
      }

      if (result.exitCode === 0) {
        // A recorded unresolved PR-head compare keeps the summary and gains its
        // own exit code, so a consumer that reads only the exit code can tell it
        // from a verified finish (#279).
        const exitCode = result.unresolvedCompare ? UNRESOLVED_COMPARE_EXIT : 0;
        console.log("\n===== SUMMARY =====\n");
        console.log(formatSummary(result.summary));
        await finish({ exitCode, failed: false });
      } else {
        await finish({ exitCode: result.exitCode, error: new Error(result.reason), failed: true });
      }
    } catch (err) {
      if (readProp(err, "isCanceled")) {
        await finish({ exitCode: 130, error: new Error("Interrupted by SIGINT"), failed: true });
      } else {
        await finish({ exitCode: 1, error: err, failed: true });
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigInt);
  }
}

if (isEntryPoint(import.meta.filename)) {
  main().catch((error) => {
    console.error(
      `\n${redactedText(readProp(error, "stack") ?? readProp(error, "message") ?? error)}`,
    );
    process.exitCode = 1;
  });
}
