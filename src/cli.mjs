#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultAgents, normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  ROLE_KINDS as ROLES,
  assertOpenCodeOptions,
  readArgValue,
  readNonNegativeInt,
  readPositiveInt,
  roleFlags,
} from "./lib/args.mjs";
import { isEntryPoint } from "./lib/entrypoint.mjs";
import {
  runHarnessCheckCommand,
  runInstallCommand,
  runUninstallCommand,
} from "./install/commands.mjs";
import { setVerbose } from "./lib/log.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { runLoop } from "./runtime.mjs";
import { main as runRoleMain } from "./role.mjs";

const ROLE_FLAGS = roleFlags(ROLES);

export function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    task: null,
    maxSteps: 20,
    timeout: 3600,
    transcript: null,
    verbose: false,
  };
  for (const role of ROLES) {
    options[role] = null;
    options[`${role}Model`] = null;
    options[`${role}Effort`] = null;
  }

  const readValue = (flag, index) => readArgValue(argv, flag, index);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (Object.hasOwn(ROLE_FLAGS, arg)) {
      options[ROLE_FLAGS[arg]] = readValue(arg, ++i);
      continue;
    }

    switch (arg) {
      case "--cwd":
        options.cwd = resolve(readValue(arg, ++i));
        break;

      case "--task":
        options.task = readValue(arg, ++i);
        break;

      case "--max-steps":
        options.maxSteps = readPositiveInt("--max-steps", readValue("--max-steps", ++i));
        break;

      case "--timeout": {
        const seconds = readNonNegativeInt("--timeout", readValue("--timeout", ++i));
        options.timeout = seconds === 0 ? null : seconds;
        break;
      }

      case "--transcript":
        options.transcript = resolve(readValue(arg, ++i));
        break;

      case "--verbose":
        options.verbose = true;
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      default:
        throw new Error(`Unknown argument: ${arg}`);
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

The orchestrator selects actions (run_worker, run_reviewer, finish, abort).
The runtime enforces step limits and mutation boundaries.

Subcommands:

  agent-loop role               Run a single worker or reviewer turn, or finish/abort
                                a run, from a lifecycle state file (see below). One JSON
                                object on stdout; logs on stderr.
  agent-loop install            Install harness entry points and parent guards at user
                                scope. Interactive, or --harness <list> --yes.
  agent-loop uninstall          Remove the installed entry points and guards. Restores
                                files that install changed.
  agent-loop harness-check      Exit 0 only when the nearest harness process above the
                                shell matches the named harness; used by the Codex and
                                Antigravity skills.

Role operations:

  dispatch (default)            Run one --role turn for the run state at --cwd.
  finish                        End the run; the five-key summary arrives as JSON on stdin.
  abort                         End the run with --reason.

Role flags:

  --role worker|reviewer        Role to dispatch. Required for dispatch.
  --cwd <directory>             Target work tree. Defaults to the current directory.
  --task / --mode / --parent-session / --worker* / --reviewer* / --max-steps / --timeout
                                First (init) call only. Later calls read these from the
                                state file and reject any attempt to change them.
  --prompt-file <path>          Prompt source. Default is stdin.
  --transcript <file>           Append invocation and result events (JSON lines).
  --resume-interrupted          Explicitly continue after an uncertain previous turn.

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
  --max-steps <count>           Maximum child steps. Defaults to 20.
  --timeout <seconds>           Timeout per agent invocation. Defaults to 3600. 0 disables the bound.
  --transcript <file>           Record execution transcript to a JSON file.
  --verbose                     Enable debug-level lifecycle logging, including snapshot activity.
  -h, --help                    Show help.

Environment:

  The loop spawns each agent CLI directly, without a shell. Agents inherit the environment of the process that launched the loop. Start the loop from a shell where direnv or a similar tool already exported the required variables.

Agents:

  ${[...supportedAgents].join("\n  ")}
`.trim(),
  );
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
  const transcriptData = {
    task: options.task,
    cwd: options.cwd,
    options: {
      maxSteps: options.maxSteps,
      timeout: options.timeout,
    },
    roles,
    events,
    exitCode: 1,
    error: null,
  };

  const writeTranscript = async () => {
    if (!options.transcript) return;
    try {
      await writeFile(options.transcript, JSON.stringify(transcriptData, null, 2), "utf8");
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
        signal: controller.signal,
        roles: transcriptData.roles,
        agents,
        onEvent,
      });

      if (result.exitCode === 0) {
        console.log("\n===== SUMMARY =====\n");
        console.log(formatSummary(result.summary));
        await finish({ exitCode: 0, error: null });
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
