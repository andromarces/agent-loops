#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  roleFlags,
  splitInlineFlag,
} from "./lib/args.mjs";
import { carryEarlierEvents, readContinuation, restoreSessions } from "./lib/continuation.mjs";
import { isEntryPoint } from "./lib/entrypoint.mjs";
import {
  runHarnessCheckCommand,
  runInstallCommand,
  runUninstallCommand,
} from "./install/commands.mjs";
import { setVerbose } from "./lib/log.mjs";
import { writeFileAtomic } from "./lib/runstate.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { runLoop, UNRESOLVED_COMPARE_EXIT } from "./runtime.mjs";
import { main as runRoleMain } from "./role.mjs";

const ROLE_FLAGS = roleFlags(ROLES);

export function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    task: null,
    maxSteps: DEFAULT_MAX_STEPS,
    timeout: DEFAULT_TIMEOUT,
    transcript: null,
    verbose: false,
    requireAccept: false,
    pr: null,
    requireCi: null,
    mode: null,
    continueFrom: null,
    copyLocalFiles: true,
  };
  for (const role of ROLES) {
    options[role] = null;
    options[`${role}Model`] = null;
    options[`${role}Effort`] = null;
  }

  const readValue = (flag, index) => readArgValue(argv, flag, index);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const inline = splitInlineFlag(raw);
    const arg = inline ? inline.flag : raw;
    let inlineUsed = false;
    const readInline = (flag) => {
      if (!inline) {
        return readValue(flag, ++i);
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
  if (options.task === null || options.task === undefined || String(options.task).trim() === "") {
    throw new Error(
      'Missing required --task. Provide the task, for example --task "Implement the change."',
    );
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
  --task / --mode / --worker* / --reviewer* / --max-steps / --timeout / --no-copy-local-files
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
  --task <text>                 Task description. Required.
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
                                an omitted one, and a change of a CLI's own default model between
                                the two runs is not detected. The
                                completion gate is reset, not restored: no reviewer accept carries
                                over, so a finish after work needs a reviewer turn in this run. The
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

export async function main(argv = process.argv.slice(2), agents = defaultAgents) {
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
  } catch (err) {
    console.error(`\n${err.message}`);
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
  // A refused continuation writes no transcript: --transcript may name the
  // --continue-from file, and a refusal must not overwrite the sessions it holds.
  if (options.continueFrom) {
    try {
      const earlier = await readContinuation(options.continueFrom);
      restoreSessions(roles, earlier, options.cwd);
      // --transcript rewrites its file at exit, so a run that names the file it
      // continues carries the earlier events into the rewrite, then a boundary
      // event that keeps the earlier outcome the rewrite replaces.
      if (options.transcript && sameFile(options.transcript, options.continueFrom)) {
        carryEarlierEvents(events, earlier);
      }
    } catch (err) {
      console.error(`
${err.message}`);
      process.exitCode = 1;
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
      ...(options.mode === null ? {} : { mode: options.mode }),
      ...(options.continueFrom ? { continueFrom: options.continueFrom } : {}),
      ...(options.copyLocalFiles ? {} : { copyLocalFiles: false }),
    },
    roles,
    events,
    exitCode: 1,
    error: null,
  };

  const writeTranscript = async () => {
    if (!options.transcript) return;
    try {
      // Atomic, because the file can be the --continue-from source: a crash or a
      // failed write must leave the earlier record whole.
      await writeFileAtomic(options.transcript, JSON.stringify(transcriptData, null, 2));
    } catch (err) {
      console.error(`Warning: Failed to write transcript to ${options.transcript}: ${err.message}`);
    }
  };

  const finish = async ({ exitCode, error }) => {
    transcriptData.exitCode = exitCode;
    transcriptData.error = error ? (error.message ?? String(error)) : null;
    await writeTranscript();
    if (error) {
      console.error(`\n${error.message ?? error}`);
    }
    process.exitCode = exitCode;
  };

  const controller = new AbortController();
  const onSigInt = () => {
    controller.abort();
  };
  process.once("SIGINT", onSigInt);

  try {
    try {
      await assertGitWorkTree(options.cwd);
    } catch (err) {
      await finish({ exitCode: 1, error: err });
      return;
    }

    const onEvent = (event) => {
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
      const result = await runLoop({
        task: options.task,
        cwd: options.cwd,
        maxSteps: options.maxSteps,
        timeout: options.timeout,
        requireAccept: options.requireAccept,
        pr: options.pr,
        requireCi: options.requireCi,
        mode: options.mode,
        continued: Boolean(options.continueFrom),
        copyLocalFiles: options.copyLocalFiles,
        signal: controller.signal,
        roles: transcriptData.roles,
        agents,
        onEvent,
      });

      if (result.exitCode === 0) {
        // A recorded unresolved PR-head compare keeps the summary and gains its
        // own exit code, so a consumer that reads only the exit code can tell it
        // from a verified finish (#279).
        const exitCode = result.unresolvedCompare ? UNRESOLVED_COMPARE_EXIT : 0;
        console.log("\n===== SUMMARY =====\n");
        console.log(formatSummary(result.summary));
        await finish({ exitCode, error: null });
      } else {
        await finish({ exitCode: result.exitCode, error: new Error(result.reason) });
      }
    } catch (err) {
      if (err?.isCanceled) {
        await finish({ exitCode: 130, error: new Error("Interrupted by SIGINT") });
      } else {
        await finish({ exitCode: 1, error: err });
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigInt);
  }
}

if (isEntryPoint(import.meta.filename)) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  });
}
