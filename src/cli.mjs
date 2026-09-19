#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultAgents, normalizeAgent, supportedAgents } from "./agents/index.mjs";
import { setVerbose } from "./lib/log.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { runLoop } from "./runtime.mjs";

const ROLES = ["orchestrator", "worker", "reviewer"];

export function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    task: null,
    maxSteps: 20,
    timeout: null,
    transcript: null,
    verbose: false,
  };
  for (const role of ROLES) {
    options[role] = null;
    options[`${role}Model`] = null;
    options[`${role}Effort`] = null;
  }

  const readValue = (flag, index) => {
    const value = argv[index];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  const readPositiveInt = (flag, index) => {
    const val = Number(readValue(flag, index));
    if (!Number.isInteger(val) || val < 1) {
      throw new Error(`${flag} must be a positive integer.`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    let matched = false;
    for (const role of ROLES) {
      if (arg === `--${role}`) {
        options[role] = readValue(arg, ++i);
        matched = true;
      } else if (arg === `--${role}-model`) {
        options[`${role}Model`] = readValue(arg, ++i);
        matched = true;
      } else if (arg === `--${role}-effort`) {
        options[`${role}Effort`] = readValue(arg, ++i);
        matched = true;
      }
      if (matched) break;
    }
    if (matched) continue;

    switch (arg) {
      case "--cwd":
        options.cwd = resolve(readValue(arg, ++i));
        break;

      case "--task":
        options.task = readValue(arg, ++i);
        break;

      case "--max-steps":
        options.maxSteps = readPositiveInt("--max-steps", ++i);
        break;

      case "--timeout":
        options.timeout = readPositiveInt("--timeout", ++i);
        break;

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

function assertOpenCodeOptions(role, kind, model, effort) {
  if (normalizeAgent(kind) !== "opencode") {
    return;
  }

  if (effort && !model) {
    throw new Error(`--${role}-effort requires --${role}-model for OpenCode.`);
  }

  if (effort && model.includes("#")) {
    throw new Error(
      `--${role}-model "${model}" already contains a variant and cannot be combined with --${role}-effort.`,
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

The orchestrator selects actions (run_worker, run_reviewer, finish, abort).
The runtime enforces step limits and mutation boundaries.

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
  --cwd <directory>             Working directory for the agents. Must be inside a Git work tree. Defaults to current directory.
  --task <text>                 Task description. Required.
  --max-steps <count>           Maximum child steps. Defaults to 20.
  --timeout <seconds>           Timeout per agent invocation. Optional.
  --transcript <file>           Record execution transcript to a JSON file.
  --verbose                     Enable debug-level lifecycle logging, including snapshot activity.
  -h, --help                    Show help.

Environment:

  The loop spawns each agent CLI directly, without a shell. Agents inherit the environment of the process that launched the loop. Start the loop from a shell where direnv or a similar tool already exported the required variables.

Agents:

  claude
  codex
  agy
  antigravity
  opencode
  copilot
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  });
}
