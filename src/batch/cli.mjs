// `agent-loop batch start|status|resume|answer|audit` (adr/0106-foreground-batch-scheduling.md,
// adr/0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md,
// adr/0110-release-batch-slots-on-owner-decisions.md). stdout carries one JSON
// object; progress and logs go to stderr.
import { setLogsToStderr, logError } from "../lib/log.mjs";
import { stateRoot } from "../lib/runstate.mjs";
import { cancelOnSigInt } from "../lib/sigint.mjs";
import { parseBatchArgs, prepareBatch, refuseRunsRootInGitWorkTree } from "./args.mjs";
import {
  listAuditStatus,
  newAuditId,
  parseAuditArgs,
  prepareAudit,
  readAudit,
  readAuditStatus,
  readFrozenIssueSet,
  removeAudit,
  runAudit,
} from "./audit.mjs";
import { runGh } from "../lib/gh-api.mjs";
import { answerDecision } from "./decisions.mjs";
import { listBatchStatus, newBatchId, readBatchStatus, runBatch } from "./supervisor.mjs";
import { readManifest } from "./store.mjs";

const BATCH_USAGE = `
Usage:

  agent-loop batch start --repo <dir> --issue <n> [--issue <n> ...] \\
    --orchestrator <cli> --worker <cli> --reviewer <cli> \\
    --loops <n> --max-steps <n> [settings]
  agent-loop batch start --repo <dir> --items-file <path> \\
    --orchestrator <cli> --worker <cli> --reviewer <cli> \\
    --loops <n> --max-steps <n> [settings]
  agent-loop batch start --repo <dir> --from-audit <audit id> \\
    --orchestrator <cli> --worker <cli> --reviewer <cli> \\
    --loops <n> --max-steps <n> [settings]

  agent-loop batch status [--batch <id>]
  agent-loop batch resume --batch <id>
  agent-loop batch answer --batch <id> --decision <decision id> --option <key>

  agent-loop batch audit start --repo <dir> --reviewer <cli> --reviewer <cli> \\
    --worker <cli> [settings]
  agent-loop batch audit status [--audit <id>]
  agent-loop batch audit resume --audit <id>
  agent-loop batch audit approve --audit <id>
  agent-loop batch audit remove --audit <id>

The batch runs one headless loop per item in its own work tree, at most --loops at once.
The item list is explicit --issue entries, a JSON --items-file list, or the frozen issue
set of a created audit with --from-audit; exactly one source is required.
An items-file entry is { kind, number | text, mode, task, id }: kind is issue, pr, or
task; mode is work-first, review-first, or review-only; task replaces the template for
that item; id is required for a task item only. The default mode is work-first for an
issue and a task, and review-first for a pull request.
An issue keeps its own branch and eligibility. A pull request runs on its head branch in
every mode and is skipped before launch when that head moved or it is closed. A task runs
on branch batch/<batch id>/task-<id> in work tree task-<id>, and in work-first or
review-first it delivers through a pull request with no closing keyword.
Settings: --base, --work-tree-root, --task-template, --require-specification, --setup-cmd,
--setup-timeout, --test-cmd, --test-cmd-timeout, --timeout, --reviewer-sandbox, and the
--<role>-model and --<role>-effort flags.

A needs-owner loop becomes a pending decision and releases its slot. \`batch status\` shows
the options and the recommendation. \`batch answer\` binds one listed option to one decision.
A loop whose headless run exits 4 becomes \`needs-owner\` with reason \`pr-head-unresolved\`.
Its status names the pull request and the next action.

The audit runs two or more read-only reviewers on one revision, then one consolidation
worker. It then creates one issue per finding that no open or closed issue covers.
Audit settings: --base, --work-tree-root, --setup-cmd, --setup-timeout, --timeout,
--reviewer-sandbox, --reviewer-model and --reviewer-effort after each --reviewer,
--worker-model and --worker-effort, and --focus <text> or --focus-file <path>. The two
focus flags are mutually exclusive, and an empty focus is refused.

Exit codes: 0 every item succeeded or was skipped, or the audit created its issue set. 1 a
loop failed, the batch waits on an owner decision or merge, the queue paused, or an audit
paused. 2 a refused setting or a refusal before any state write. 130 SIGINT.
`.trim();

const AUDIT_USAGE = `
Usage:

  agent-loop batch audit start --repo <dir> --reviewer <cli> --reviewer <cli> \\
    --worker <cli> [--reviewer-model <model>] [--reviewer-effort <effort>] \\
    [--worker-model <model>] [--worker-effort <effort>] \\
    [--focus <text> | --focus-file <path>] \\
    [--base <branch>] [--work-tree-root <dir>] [--setup-cmd <command>] \\
    [--setup-timeout <seconds>] [--timeout <seconds>] [--reviewer-sandbox <mode>]

  agent-loop batch audit status [--audit <id>]
  agent-loop batch audit resume --audit <id>
  agent-loop batch audit approve --audit <id>
  agent-loop batch audit remove --audit <id>

Two or more reviewers audit one frozen revision in one read-only work tree. After every
requested audit succeeds, or after the owner approves the partial results with approve,
one worker consolidates the findings against the open and closed issues and the runtime
creates one issue per finding that no issue covers. A failed audit creates no issue until
a retry succeeds or the owner approves the partial results. The created issue set is frozen.
--focus <text> or --focus-file <path> sets the only goal of each reviewer; the two are
mutually exclusive, and an empty focus is refused. Without a focus, reviewers report any
item someone can act on, defects included. A resume or approve reuses the stored focus,
and status shows it.

remove deletes the work tree and store of a finished audit with a frozen issue set. A
paused, needs-owner, or interrupted audit, and one whose issue write is unreconciled,
keeps both.

Exit codes: 0 the issue set is created or the audit is removed, 1 the audit paused or
remove kept it, 2 a refused setting or a refusal before any state write, 130 SIGINT.
`.trim();

function readIdFlag(argv, name) {
  let id = null;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    if (flag === name) {
      const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
      if (!value) throw Object.assign(new Error(`Missing value for ${name}.`), { usage: true });
      id = value;
      continue;
    }
    if (flag === "--help" || flag === "-h") return { help: true, id };
    throw Object.assign(new Error(`Unknown argument: ${raw}`), { usage: true });
  }
  return { help: false, id };
}

function readAnswerArgs(argv) {
  const values = { batch: null, decision: null, option: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    if (flag === "--help" || flag === "-h") {
      values.help = true;
      continue;
    }
    const key = { "--batch": "batch", "--decision": "decision", "--option": "option" }[flag];
    if (key === undefined) {
      throw Object.assign(new Error(`Unknown argument: ${raw}`), { usage: true });
    }
    const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
    if (!value) throw Object.assign(new Error(`Missing value for ${flag}.`), { usage: true });
    values[key] = value;
  }
  return values;
}

const readBatchFlag = (argv) => readIdFlag(argv, "--batch");

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
    requireSpecification: settings.requireSpecification === true,
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

function preparedFromAudit(state, mode) {
  return {
    id: state.id,
    repo: state.repo,
    repoKey: state.repoKey,
    base: state.base,
    revision: state.revision,
    workTreeRoot: state.workTreeRoot,
    focus: state.focus ?? null,
    reviewers: state.settings?.reviewers ?? [],
    worker: state.settings?.worker ?? { kind: null, model: null, effort: null },
    timeout: state.settings?.timeout ?? null,
    reviewerSandbox: state.settings?.reviewerSandbox ?? null,
    setupCmd: state.settings?.setupCmd ?? null,
    setupTimeout: state.settings?.setupTimeout,
    mode,
  };
}

async function runAuditCommand({ prepared, runsRoot }) {
  const controller = new AbortController();
  const removeSigIntListener = cancelOnSigInt(controller);
  try {
    const { exitCode, summary } = await runAudit({
      prepared,
      runsRoot,
      gh: runGh,
      signal: controller.signal,
    });
    console.log(JSON.stringify(summary, null, 2));
    return exitCode;
  } finally {
    removeSigIntListener();
  }
}

async function runAuditMain(argv, runsRoot) {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(AUDIT_USAGE);
    return 0;
  }
  if (command === "status") {
    const { help, id } = readIdFlag(argv.slice(1), "--audit");
    if (help) {
      console.log(AUDIT_USAGE);
      return 0;
    }
    if (id === null) {
      console.log(JSON.stringify(await listAuditStatus(runsRoot), null, 2));
      return 0;
    }
    console.log(JSON.stringify(await readAuditStatus({ runsRoot, id }), null, 2));
    return 0;
  }
  if (command === "start") {
    if (argv.slice(1).includes("--help") || argv.slice(1).includes("-h")) {
      console.log(AUDIT_USAGE);
      return 0;
    }
    const options = parseAuditArgs(argv.slice(1));
    const id = newAuditId();
    const prepared = await prepareAudit({ ...options, id });
    prepared.mode = "start";
    await refuseRunsRootInGitWorkTree(runsRoot);
    return runAuditCommand({ prepared, runsRoot });
  }
  if (command === "resume" || command === "approve") {
    const { help, id } = readIdFlag(argv.slice(1), "--audit");
    if (help) {
      console.log(AUDIT_USAGE);
      return 0;
    }
    if (id === null) {
      throw Object.assign(new Error("Missing required --audit."), { usage: true });
    }
    const state = await readAudit(runsRoot, id);
    if (state === null) {
      throw Object.assign(new Error(`No audit ${id}.`), { usage: true });
    }
    await refuseRunsRootInGitWorkTree(runsRoot);
    return runAuditCommand({ prepared: preparedFromAudit(state, command), runsRoot });
  }
  if (command === "remove") {
    const { help, id } = readIdFlag(argv.slice(1), "--audit");
    if (help) {
      console.log(AUDIT_USAGE);
      return 0;
    }
    if (id === null) {
      throw Object.assign(new Error("Missing required --audit."), { usage: true });
    }
    const state = await readAudit(runsRoot, id);
    if (state === null) {
      throw Object.assign(new Error(`No audit ${id}.`), { usage: true });
    }
    await refuseRunsRootInGitWorkTree(runsRoot);
    const { exitCode, summary } = await removeAudit({ runsRoot, id });
    console.log(JSON.stringify(summary, null, 2));
    return exitCode;
  }
  throw Object.assign(new Error(`Unknown audit command: ${command}`), { usage: true });
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
    if (command === "audit") {
      return await runAuditMain(argv.slice(1), runsRoot);
    }
    if (command === "start") {
      if (argv.slice(1).includes("--help") || argv.slice(1).includes("-h")) {
        console.log(BATCH_USAGE);
        return 0;
      }
      const options = parseBatchArgs(argv.slice(1));
      if (options.fromAudit !== null) {
        options.issues = await readFrozenIssueSet({
          runsRoot,
          id: options.fromAudit,
          repo: options.repo,
        });
      }
      const id = newBatchId();
      const prepared = await prepareBatch({ ...options, id });
      await refuseRunsRootInGitWorkTree(runsRoot);
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
    if (command === "answer") {
      const values = readAnswerArgs(argv.slice(1));
      if (values.help) {
        console.log(BATCH_USAGE);
        return 0;
      }
      if (values.batch === null)
        throw Object.assign(new Error("Missing required --batch."), {
          usage: true,
        });
      if (values.decision === null) {
        throw Object.assign(new Error("Missing required --decision."), { usage: true });
      }
      if (values.option === null) {
        throw Object.assign(new Error("Missing required --option."), { usage: true });
      }
      const result = await answerDecision({
        runsRoot,
        batchId: values.batch,
        decisionId: values.decision,
        option: values.option,
      });
      if (!result.ok) {
        logError(result.reason);
        return result.usage ? 2 : 1;
      }
      console.log(
        JSON.stringify(
          {
            batchId: values.batch,
            decisionId: values.decision,
            option: values.option,
            status: "answered",
          },
          null,
          2,
        ),
      );
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
      await refuseRunsRootInGitWorkTree(runsRoot);
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
