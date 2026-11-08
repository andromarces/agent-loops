// `agent-loop batch start|status|resume` (ADR 0106 decision 1). stdout carries one JSON object;
// progress and logs go to stderr.
import { setLogsToStderr, logError } from "../lib/log.mjs";
import { stateRoot } from "../lib/runstate.mjs";
import { parseBatchArgs, prepareBatch } from "./args.mjs";
import { runGh } from "../lib/gh-api.mjs";
import { listBatchStatus, newBatchId, readBatchStatus, runBatch } from "./supervisor.mjs";
import { readManifest } from "./store.mjs";

const BATCH_USAGE = `
Usage:

  agent-loop batch start --repo <dir> --issue <n> [--issue <n> ...] \\
    --orchestrator <cli> --worker <cli> --reviewer <cli> \\
    --loops <n> --max-steps <n> [settings]

  agent-loop batch status [--batch <id>]
  agent-loop batch resume --batch <id>

The batch runs one headless loop per issue in its own work tree, at most --loops at once.
Settings: --base, --work-tree-root, --task-template, --setup-cmd, --setup-timeout,
--test-cmd, --test-cmd-timeout, --timeout, --reviewer-sandbox, and the
--<role>-model and --<role>-effort flags.

Exit codes: 0 every issue succeeded or was skipped, 1 a loop failed or needs an owner or
the queue paused, 2 a refused setting or a refusal before any state write, 130 SIGINT.
`.trim();

function readBatchFlag(argv) {
  let id = null;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    if (flag === "--batch") {
      const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
      if (!value) throw Object.assign(new Error("Missing value for --batch."), { usage: true });
      id = value;
      continue;
    }
    if (flag === "--help" || flag === "-h") return { help: true, id };
    throw Object.assign(new Error(`Unknown argument: ${raw}`), { usage: true });
  }
  return { help: false, id };
}

async function preparedForResume(manifest) {
  const settings = manifest.settings ?? {};
  const roles = settings.roles ?? {};
  return prepareBatch({
    id: manifest.id,
    repo: manifest.repo,
    issues: manifest.issues,
    base: manifest.base,
    workTreeRoot: manifest.workTreeRoot,
    loops: settings.loops,
    maxSteps: settings.maxSteps,
    taskTemplate: settings.taskTemplate,
    setupCmd: settings.setupCmd ?? null,
    setupTimeout: settings.setupTimeout,
    testCmd: settings.testCmd ?? null,
    testCmdTimeout: settings.testCmdTimeout ?? null,
    timeout: settings.timeout,
    reviewerSandbox: settings.reviewerSandbox ?? null,
    orchestrator: roles.orchestrator?.kind ?? null,
    worker: roles.worker?.kind ?? null,
    reviewer: roles.reviewer?.kind ?? null,
    orchestratorModel: roles.orchestrator?.model ?? null,
    workerModel: roles.worker?.model ?? null,
    reviewerModel: roles.reviewer?.model ?? null,
    orchestratorEffort: roles.orchestrator?.effort ?? null,
    workerEffort: roles.worker?.effort ?? null,
    reviewerEffort: roles.reviewer?.effort ?? null,
  });
}

/**
 * Runs one `agent-loop batch` command.
 * @param {string[]} argv the words after `batch`
 * @returns {Promise<number>} the process exit code
 */
export async function runBatchMain(argv) {
  setLogsToStderr(true);
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(BATCH_USAGE);
    return 0;
  }
  const runsRoot = stateRoot();
  try {
    if (command === "start") {
      const options = parseBatchArgs(argv.slice(1));
      const id = newBatchId();
      const prepared = await prepareBatch({ ...options, id });
      const { exitCode, summary } = await runBatch({
        prepared,
        runsRoot,
        gh: runGh,
      });
      console.log(JSON.stringify(summary, null, 2));
      return exitCode;
    }
    if (command === "status") {
      const { help, id } = readBatchFlag(argv.slice(1));
      if (help) {
        console.log(BATCH_USAGE);
        return 0;
      }
      if (id === null) {
        console.log(JSON.stringify(await listBatchStatus({ runsRoot }), null, 2));
        return 0;
      }
      console.log(JSON.stringify(await readBatchStatus({ runsRoot, id }), null, 2));
      return 0;
    }
    if (command === "resume") {
      const { help, id } = readBatchFlag(argv.slice(1));
      if (help) {
        console.log(BATCH_USAGE);
        return 0;
      }
      if (id === null) {
        throw Object.assign(new Error("Missing required --batch."), { usage: true });
      }
      const manifest = await readManifest(runsRoot, id);
      if (manifest === null) {
        throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
      }
      const prepared = await preparedForResume(manifest);
      prepared.resume = true;
      const { exitCode, summary } = await runBatch({ prepared, runsRoot, gh: runGh });
      console.log(JSON.stringify(summary, null, 2));
      return exitCode;
    }
    throw Object.assign(new Error(`Unknown batch command: ${command}`), { usage: true });
  } catch (err) {
    if (err?.usage) {
      logError(err.message);
      return 2;
    }
    logError(err?.message ?? String(err));
    return 1;
  }
}
