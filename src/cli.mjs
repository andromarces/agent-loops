#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultAgents, normalizeAgent } from "./agents/index.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { runLoop } from "./runtime.mjs";

const SUPPORTED = new Set(["claude", "codex", "agy", "antigravity", "opencode", "copilot"]);

export function parseArgs(argv) {
  const options = {
    orchestrator: null,
    worker: null,
    reviewer: null,
    orchestratorModel: null,
    orchestratorEffort: null,
    workerModel: null,
    workerEffort: null,
    reviewerModel: null,
    reviewerEffort: null,
    cwd: process.cwd(),
    task: null,
    maxSteps: 20,
    timeout: null,
    transcript: null,
  };

  const readValue = (flag, index) => {
    const value = argv[index];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--orchestrator":
        options.orchestrator = readValue(arg, ++i);
        break;

      case "--worker":
        options.worker = readValue(arg, ++i);
        break;

      case "--reviewer":
        options.reviewer = readValue(arg, ++i);
        break;

      case "--orchestrator-model":
        options.orchestratorModel = readValue(arg, ++i);
        break;

      case "--orchestrator-effort":
        options.orchestratorEffort = readValue(arg, ++i);
        break;

      case "--worker-model":
        options.workerModel = readValue(arg, ++i);
        break;

      case "--worker-effort":
        options.workerEffort = readValue(arg, ++i);
        break;

      case "--reviewer-model":
        options.reviewerModel = readValue(arg, ++i);
        break;

      case "--reviewer-effort":
        options.reviewerEffort = readValue(arg, ++i);
        break;

      case "--cwd":
        options.cwd = resolve(readValue(arg, ++i));
        break;

      case "--task":
        options.task = readValue(arg, ++i);
        break;

      case "--max-steps": {
        const raw = readValue(arg, ++i);
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 1) {
          throw new Error("--max-steps must be a positive integer.");
        }
        options.maxSteps = val;
        break;
      }

      case "--timeout": {
        const raw = readValue(arg, ++i);
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 1) {
          throw new Error("--timeout must be a positive integer.");
        }
        options.timeout = val;
        break;
      }

      case "--transcript":
        options.transcript = resolve(readValue(arg, ++i));
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

  if (!options.orchestrator) {
    throw new Error("Missing required --orchestrator.");
  }
  if (!SUPPORTED.has(options.orchestrator)) {
    throw new Error(`Unsupported orchestrator: ${options.orchestrator}`);
  }

  if (!options.worker) {
    throw new Error("Missing required --worker.");
  }
  if (!SUPPORTED.has(options.worker)) {
    throw new Error(`Unsupported worker: ${options.worker}`);
  }

  if (!options.reviewer) {
    throw new Error("Missing required --reviewer.");
  }
  if (!SUPPORTED.has(options.reviewer)) {
    throw new Error(`Unsupported reviewer: ${options.reviewer}`);
  }

  assertOpenCodeOptions(
    "orchestrator",
    options.orchestrator,
    options.orchestratorModel,
    options.orchestratorEffort,
  );
  assertOpenCodeOptions("worker", options.worker, options.workerModel, options.workerEffort);
  assertOpenCodeOptions(
    "reviewer",
    options.reviewer,
    options.reviewerModel,
    options.reviewerEffort,
  );

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

  const events = [];
  const transcriptData = {
    task: options.task,
    cwd: options.cwd,
    options: {
      maxSteps: options.maxSteps,
      timeout: options.timeout,
    },
    roles: {
      orchestrator: {
        kind: normalizeAgent(options.orchestrator),
        model: options.orchestratorModel,
        effort: options.orchestratorEffort,
        sessionId: null,
      },
      worker: {
        kind: normalizeAgent(options.worker),
        model: options.workerModel,
        effort: options.workerEffort,
        sessionId: null,
      },
      reviewer: {
        kind: normalizeAgent(options.reviewer),
        model: options.reviewerModel,
        effort: options.reviewerEffort,
        sessionId: null,
      },
    },
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
    await assertGitWorkTree(options.cwd);
  } catch (err) {
    process.removeListener("SIGINT", onSigInt);
    await finish({ exitCode: 1, error: err });
    return;
  }

  const onEvent = (event) => {
    events.push({
      ...event,
      at: new Date().toISOString(),
    });

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

    process.removeListener("SIGINT", onSigInt);

    if (result.exitCode === 0) {
      console.log("\n===== SUMMARY =====\n");
      console.log(formatSummary(result.summary));
      await finish({ exitCode: 0, error: null });
    } else if (result.exitCode === 1) {
      await finish({ exitCode: 1, error: new Error(result.reason) });
    } else if (result.exitCode === 2) {
      await finish({ exitCode: 2, error: new Error(result.reason) });
    }
  } catch (err) {
    process.removeListener("SIGINT", onSigInt);
    if (err?.isCanceled) {
      await finish({ exitCode: 130, error: new Error("Interrupted by SIGINT") });
    } else {
      await finish({ exitCode: 1, error: err });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  });
}
