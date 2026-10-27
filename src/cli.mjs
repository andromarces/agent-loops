#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultAgents, normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT,
  REVIEW_ONLY_COMPARE_HEAD_REFUSAL,
  REVIEW_ONLY_GATE_REFUSAL,
  ROLE_KINDS as ROLES,
  initRefusal,
  parseFlags,
  readPositiveInt,
  readStdinText,
  readTaskFile,
  roleFlags,
  TASK_SOURCE_CONFLICT,
} from "./lib/args.mjs";
import {
  carryEarlierEvents,
  declaredPrFromTranscript,
  refuseDeclaredPrConflict,
  gateFromTranscript,
  earlierReviewerSandbox,
  readContinuation,
  restoreSessions,
  verifyResolvedModels,
} from "./lib/continuation.mjs";
import { COMPARE_HEAD_INPUT_REFUSAL } from "./lib/ci-gate.mjs";
import { refuseHeldSessions } from "./lib/command-line.mjs";
import { isEntryPoint } from "./lib/entrypoint.mjs";
import { cancelOnSigInt } from "./lib/sigint.mjs";
import { readProp, redactedText } from "./lib/error-message.mjs";
import {
  runHarnessCheckCommand,
  runInstallCommand,
  runUninstallCommand,
} from "./install/commands.mjs";
import { setVerbose } from "./lib/log.mjs";
import { resolveWriteTarget } from "./lib/atomic-write.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { runTestSlot } from "./lib/test-slot.mjs";
import { createTranscriptWriter } from "./lib/transcript.mjs";
import { printHelp } from "./help.mjs";
import { runLoop, runProbeTurn, UNRESOLVED_COMPARE_EXIT } from "./runtime.mjs";
import { main as runRoleMain } from "./role.mjs";

const ROLE_FLAGS = roleFlags(ROLES);

/**
 * Parses the headless `agent-loop` argv into an options object and throws on an
 * invalid flag. Side effect: `--help` or `-h` prints the help text and calls
 * `process.exit(0)` inside the parser, so it never returns for that flag.
 * @param {string[]} argv
 */
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
    compareHead: null,
    testCmd: null,
    testCmdTimeout: null,
    reviewerSandbox: null,
    mode: null,
    continueFrom: null,
    copyLocalFiles: true,
  };
  for (const role of ROLES) {
    options[role] = null;
    options[`${role}Model`] = null;
    options[`${role}Effort`] = null;
  }

  parseFlags(argv, options, {
    roleFlagMap: ROLE_FLAGS,
    onFlag: (arg, readInline, inline) => {
      switch (arg) {
        case "--no-copy-local-files":
          options.copyLocalFiles = false;
          return true;

        case "--compare-head":
          options.compareHead = readPositiveInt(arg, readInline(arg));
          return true;

        case "--continue-from":
          options.continueFrom = resolve(readInline(arg));
          return true;

        case "--help":
        case "-h":
          if (inline) {
            throw new Error(`${arg} does not take a value.`);
          }
          printHelp();
          process.exit(0);

        default:
          return false;
      }
    },
  });

  // A task file is read in `main`, which then applies the same check.
  const refusal = initRefusal(options, {
    roles: ROLES,
    requiredRoles: ROLES,
    isSupportedAgent: (kind) => supportedAgents.has(kind),
    blankTaskText: options.taskFile === null ? MISSING_TASK_TEXT : null,
    rolesFirst: true,
    pathRefusal: () =>
      options.task !== null && options.taskFile !== null ? TASK_SOURCE_CONFLICT : null,
  });
  if (refusal) {
    throw new Error(refusal);
  }

  // A review-only run dispatches no worker, so it gates no PR: neither
  // declaration nor gate nor the accept rule has a finish to apply to. All three
  // arrive on this one command line, so the interactive path's refusals move
  // here and keep their wording, shared from one constant each (#337). The PR
  // declaration is refused in `initRefusal`.
  if (options.mode === "review-only" && (options.requireAccept || options.requireCi !== null)) {
    throw new Error(REVIEW_ONLY_GATE_REFUSAL);
  }

  // The compare is the operator's choice for a repository whose required-check sources are
  // unreadable, so a run that declares or gates a PR, or has no PR work, never takes it (#1104).
  if (options.compareHead !== null) {
    if (options.pr !== null || options.requireCi !== null) {
      throw new Error(COMPARE_HEAD_INPUT_REFUSAL);
    }
    if (options.mode === "review-only") {
      throw new Error(REVIEW_ONLY_COMPARE_HEAD_REFUSAL);
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

const MISSING_TASK_TEXT =
  'Missing required --task. Provide the task, for example --task "Implement the change."';

function assertTask(task) {
  if (task === null || String(task).trim() === "") {
    throw new Error(MISSING_TASK_TEXT);
  }
}

// Compares the write targets, so a file symlink and its target count as one file (#658).
async function sameFile(a, b) {
  const [left, right] = await Promise.all([resolveWriteTarget(a), resolveWriteTarget(b)]);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
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

/**
 * Restores the sessions of a `--continue-from` run onto `roles` and verifies them.
 * A refused continuation writes no transcript: --transcript may name the --continue-from file,
 * and a refusal must not overwrite the sessions it holds.
 * @returns {Promise<{ earlierGate: object | null, earlierPr: number | null, reviewerSandbox: string | null } | null>}
 *   `null` after printing the refusal and setting `process.exitCode`.
 */
async function loadContinuation({ options, roles, events, agents, signal, reviewerSandbox }) {
  try {
    const earlier = await readContinuation(options.continueFrom);
    // Before any session check or probe turn, so a refusal runs no child.
    const earlierPr = declaredPrFromTranscript(earlier);
    refuseDeclaredPrConflict(earlierPr, options);
    // Read for every reviewer kind, so a damaged record is refused, never skipped.
    const held = earlierReviewerSandbox(earlier, options.continueFrom);
    if (reviewerSandbox !== null) {
      if (options.reviewerSandbox !== null && options.reviewerSandbox !== held) {
        throw new Error(
          `--reviewer-sandbox cannot be changed by --continue-from (the earlier run held: ${held}).`,
        );
      }
      reviewerSandbox = held;
    }
    restoreSessions(roles, earlier, options.cwd);
    await refuseHeldSessions(roles, { signal });
    await verifyResolvedModels(roles, {
      probe: (state, role) =>
        runProbeTurn({
          agents,
          state,
          roleName: role,
          cwd: options.cwd,
          timeout: options.timeout,
          signal,
        }),
    });
    const earlierGate = gateFromTranscript(earlier);
    // --transcript rewrites its file at exit, so a run that names the file it
    // continues carries the earlier events into the rewrite, then a boundary
    // event that keeps the earlier outcome the rewrite replaces.
    if (options.transcript && (await sameFile(options.transcript, options.continueFrom))) {
      carryEarlierEvents(events, earlier);
    }
    return { earlierGate, earlierPr, reviewerSandbox };
  } catch (err) {
    console.error(`
${redactedText(readProp(err, "message") ?? err)}`);
    process.exitCode = readProp(err, "isCanceled") ? 130 : 1;
    return null;
  }
}

/**
 * Builds the `onEvent` callback of the loop: prints the action and result events, and, when
 * `recordEvents` is set, pushes each event with a timestamp onto `events` for the transcript.
 */
function createEventHandler({ recordEvents, events, onInvocation, onTestRun }) {
  return (event) => {
    if (event.type === "invocation") {
      onInvocation();
    }
    if (event.type === "test-run") {
      onTestRun(event.testRun);
    }
    if (recordEvents) {
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
}

export async function main(
  argv = process.argv.slice(2),
  agents = defaultAgents,
  { stdin = readStdinText, gh } = {},
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

  if (argv[0] === "test-slot") {
    process.exitCode = await runTestSlot(argv.slice(1));
    return;
  }

  if (argv[0] === "harness-check") {
    const controller = new AbortController();
    const removeSigIntListener = cancelOnSigInt(controller);
    try {
      await runHarnessCheckCommand(argv.slice(1), { signal: controller.signal });
    } finally {
      removeSigIntListener();
    }
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
  // The mode of a Codex reviewer: `none` for a new run without the flag, and the earlier run's mode
  // for a continued run. A reviewer that is not Codex has none (ADR 0038).
  let reviewerSandbox =
    roles.reviewer.kind === "codex" ? (options.reviewerSandbox ?? "none") : null;
  // Created before the continuation check, so a SIGINT during a probe turn cancels it.
  const controller = new AbortController();
  // Set once the transcript data exists. A refused continuation writes none, so it stays a no-op.
  let writeTranscriptOnForceExit = () => {};
  const removeSigIntListener = cancelOnSigInt(controller, {
    onForceExit: () => writeTranscriptOnForceExit(),
  });
  try {
    let earlierGate = null;
    let earlierPr = null;
    if (options.continueFrom) {
      const continuation = await loadContinuation({
        options,
        roles,
        events,
        agents,
        signal: controller.signal,
        reviewerSandbox,
      });
      if (continuation === null) return;
      ({ earlierGate, earlierPr, reviewerSandbox } = continuation);
    }
    const transcript = createTranscriptWriter({
      options,
      roles,
      events,
      reviewerSandbox,
      signal: controller.signal,
    });
    const transcriptData = transcript.data;
    const { writeTranscript, chooseSaveMode, onSessionAssigned } = transcript;
    writeTranscriptOnForceExit = transcript.writeOnForceExit;

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
      await assertGitWorkTree(options.cwd, { signal: controller.signal });
    } catch (err) {
      await finish({ exitCode: readProp(err, "isCanceled") ? 130 : 1, error: err, failed: true });
      return;
    }

    const onEvent = createEventHandler({
      recordEvents: Boolean(options.transcript),
      events,
      onInvocation: transcript.clearPendingSession,
      onTestRun: (testRun) => {
        fatalTestRun = testRun;
      },
    });

    try {
      if (options.transcript) {
        // The record binds to a transcript file that exists, so the file is written once before the
        // first turn, outside every mutation check.
        if ((await chooseSaveMode()) === "record") await writeTranscript();
      }
      const result = await runLoop({
        task: options.task,
        cwd: options.cwd,
        maxSteps: options.maxSteps,
        timeout: options.timeout,
        requireAccept: options.requireAccept,
        pr: options.pr,
        requireCi: options.requireCi,
        compareHead: options.compareHead,
        testCmd: options.testCmd,
        testCmdTimeout: options.testCmdTimeout,
        reviewerSandbox,
        mode: options.mode,
        continued: Boolean(options.continueFrom),
        earlierGate,
        earlierPr,
        gh,
        copyLocalFiles: options.copyLocalFiles,
        // A rewrite of the transcript before the CLI starts keeps the pre-assigned id across a
        // parent crash. known-limit: a failed write only warns, as at exit, and runs that share
        // one transcript path have no write coordination (issue #564).
        ...(options.transcript ? { onSessionAssigned } : {}),
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
        // A canceled snapshot says what it could not read, such as the changed-path evidence, so the
        // reason stays in the transcript and the error report.
        // `redactedText` converts any message safely, so a hostile one cannot lose exit 130.
        const message = readProp(err, "name") === "SnapshotError" ? readProp(err, "message") : null;
        const reason = message == null ? "" : redactedText(message);
        await finish({
          exitCode: 130,
          error: new Error(reason ? `Interrupted by SIGINT: ${reason}` : "Interrupted by SIGINT"),
          failed: true,
        });
      } else {
        await finish({ exitCode: 1, error: err, failed: true });
      }
    }
  } finally {
    removeSigIntListener();
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
