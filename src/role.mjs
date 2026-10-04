// `agent-loop role`: run one worker or reviewer turn, or finish/abort/extend a run,
// through the same guards as the headless loop, driven by a lifecycle state
// file instead of an in-process orchestrator. Stdout carries exactly one JSON
// envelope per invocation, except `--help`, which prints plain usage; all logs go
// to stderr.
import { readFile, appendFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultAgents, normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  CHILD_ROLE_KINDS,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT,
  MODES,
  REVIEW_ONLY_GATE_REFUSAL,
  REVIEW_ONLY_PR_REFUSAL,
  ROLE_FLAG_BY_OPTION,
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
import { checkCi } from "./lib/ci-gate.mjs";
import { DEFAULT_WAIT_SECONDS, waitChecks } from "./lib/check-wait.mjs";
import { copyLocalFiles } from "./lib/local-files.mjs";
import { logInfo, setVerbose, setLogsToStderr } from "./lib/log.mjs";
import { parseReportBlock, parseVerdict } from "./lib/report.mjs";
import {
  TERMINAL_LIFECYCLES,
  readState,
  statePaths,
  withStateLock,
  writeSessionEntry,
  writeState,
} from "./lib/runstate.mjs";
import { assertGitWorkTree, reviewedState, snapshot } from "./lib/snapshot.mjs";
import { missingGateRefusal, runChild, unresolvedCompareReason } from "./runtime.mjs";
import { validateAction } from "./contracts/orchestrator-action.mjs";

const OPERATIONS = new Set(["dispatch", "finish", "abort", "extend", "wait-checks"]);
const ROLE_NAMES = new Set(CHILD_ROLE_KINDS);
const ROLE_FLAGS = roleFlags(CHILD_ROLE_KINDS);

class RoleError extends Error {}

const ROLE_USAGE = [
  "Usage: agent-loop role [dispatch|finish|abort|extend|wait-checks] [flags]",
  "",
  "Runs one worker or reviewer turn, or ends or extends a run, from a lifecycle",
  "state file. One JSON object on stdout, except this help; logs on stderr.",
  "",
  "Dispatch: agent-loop role dispatch --role worker|reviewer --prompt-file <path>",
  "",
  "-h, --help  Show this help. Run agent-loop --help for every role flag.",
].join("\n");

const INIT_FIELDS = ["task", "mode", "parentSession", "maxSteps", "timeout", "pr"];

/**
 * Parses `agent-loop role [dispatch|finish|abort] [flags]`. Reuses the flag
 * reading rules and OpenCode validation of the headless CLI. Semantics that
 * depend on the state file (init detection, change rejection) are checked at
 * execution time, not parse time.
 */
export function parseRoleArgs(argv) {
  const args = {
    operation: "dispatch",
    cwd: process.cwd(),
    role: null,
    task: null,
    mode: null,
    parentSession: null,
    worker: null,
    workerModel: null,
    workerEffort: null,
    reviewer: null,
    reviewerModel: null,
    reviewerEffort: null,
    maxSteps: null,
    timeout: null,
    promptFile: null,
    transcript: null,
    resumeInterrupted: false,
    noCopyLocalFiles: false,
    reason: null,
    requireAccept: false,
    requireCi: null,
    pr: null,
    verbose: false,
    timeoutProvided: false,
    help: false,
  };

  let index = 0;
  if (argv.length > 0 && OPERATIONS.has(argv[0])) {
    args.operation = argv[0];
    index = 1;
  }

  const readValue = (flag, i) => readArgValue(argv, flag, i);

  for (; index < argv.length; index++) {
    const raw = argv[index];
    const inline = splitInlineFlag(raw);
    const arg = inline ? inline.flag : raw;
    let inlineUsed = false;
    const readInline = (flag) => {
      if (!inline) {
        return readValue(flag, ++index);
      }
      inlineUsed = true;
      return readInlineValue(inline, flag);
    };

    switch (arg) {
      case "--role":
        args.role = readInline(arg);
        if (!ROLE_NAMES.has(args.role)) {
          throw new RoleError(`--role must be worker or reviewer, got: ${args.role}`);
        }
        break;

      case "--cwd":
        args.cwd = resolve(readInline(arg));
        break;

      case "--task":
        args.task = readInline(arg);
        break;

      case "--mode":
        args.mode = readInline(arg);
        if (!MODES.has(args.mode)) {
          throw new RoleError(modeError(args.mode));
        }
        break;

      case "--parent-session":
        args.parentSession = readInline(arg);
        break;

      case "--max-steps":
        args.maxSteps = readMaxSteps(readInline(arg));
        break;

      case "--timeout": {
        const seconds = readNonNegativeInt(arg, readInline(arg));
        args.timeout = seconds === 0 ? null : seconds;
        args.timeoutProvided = true;
        break;
      }

      case "--prompt-file":
        args.promptFile = resolve(readInline(arg));
        break;

      case "--transcript":
        args.transcript = resolve(readInline(arg));
        break;

      case "--resume-interrupted":
        args.resumeInterrupted = true;
        break;

      case "--require-accept":
        args.requireAccept = true;
        break;

      case "--no-copy-local-files":
        args.noCopyLocalFiles = true;
        break;

      case "--require-ci":
        args.requireCi = readPositiveInt(arg, readInline(arg));
        break;

      case "--pr":
        args.pr = readPositiveInt(arg, readInline(arg));
        break;

      case "--reason":
        args.reason = readInline(arg);
        break;

      case "--verbose":
        args.verbose = true;
        break;

      case "--help":
      case "-h":
        args.help = true;
        break;

      default:
        if (!Object.hasOwn(ROLE_FLAGS, arg)) {
          throw new RoleError(`Unknown argument: ${raw}`);
        }
        args[ROLE_FLAGS[arg]] = readInline(arg);
        break;
    }

    // A flag that read no value is boolean, so an inline value is an error
    // rather than a silently dropped argument.
    if (inline && !inlineUsed) {
      throw new RoleError(`${arg} does not take a value.`);
    }
  }

  return args;
}

/**
 * Init detection is keyed on `--task` alone: the first call carries the task;
 * later calls read the configuration from the state file, so a provided flag
 * that matches the state passes through and a changed one is rejected.
 */
function isInitCall(args) {
  return args.task !== null;
}

/**
 * Rejects a non-init call when no state file exists for the work tree.
 *
 * `needsBudget` is set by the operations that read the step budget, so an unsafe
 * stored `maxSteps` is refused before the step-budget guard. `abort` leaves it
 * unset: abort charges no step and reads no budget, and refusing it would block
 * the only route to a terminal lifecycle, because a new init refuses over a
 * non-terminal run (#312).
 */
function requireState(state, cwd, { needsBudget = false } = {}) {
  if (!state) {
    throw new RoleError(
      `No run state for ${cwd}. Start one with: agent-loop role --task "..." --worker ... --reviewer ...`,
    );
  }
  if (needsBudget) {
    assertStateMaxSteps(state);
  }
  return state;
}

/**
 * A stored `maxSteps` is re-checked wherever the budget is read, because a state
 * file written by an earlier version, or hand-edited, reaches the step-budget
 * guard without passing through `--max-steps` validation. Outside the safe
 * integer range the step counter cannot advance by one, so the bound on `turns`
 * would hold for no accepted value. The refusal names the state file field,
 * which is what a maintainer must correct (#312).
 */
function assertStateMaxSteps(state) {
  if (!Number.isSafeInteger(state.maxSteps) || state.maxSteps < 1) {
    throw new RoleError(
      `State file field maxSteps must be a positive safe integer, got: ${JSON.stringify(state.maxSteps ?? null)}.`,
    );
  }
}

function validateInitFlags(args, agents = {}) {
  if (args.task === null || String(args.task).trim() === "") {
    throw new RoleError('Init requires --task, for example --task "Implement the change."');
  }
  // The parent guard is the hard backstop for the prompt-only parent rule, so an
  // interactive run is never left unguarded by default. The headless `agent-loop`
  // command (no subcommand) is the explicit unguarded path.
  if (args.parentSession === null) {
    throw new RoleError(
      "Init requires --parent-session (the harness session id the parent-edit guard matches).",
    );
  }
  // review-only dispatches no worker and rejects --require-ci at finish, so a
  // declared PR there could never be gated. The run would refuse every finish, so
  // the declaration is refused at init instead (#302).
  if (args.pr !== null && (args.mode ?? "work-first") === "review-only") {
    throw new RoleError(REVIEW_ONLY_PR_REFUSAL);
  }
  // review-only never dispatches the worker, so --worker is optional there.
  const requiredRoles =
    (args.mode ?? "work-first") === "review-only" ? ["reviewer"] : CHILD_ROLE_KINDS;
  for (const roleName of requiredRoles) {
    if (args[roleName] === null) {
      throw new RoleError(`Missing required --${roleName}.`);
    }
  }
  // Every supplied role is still validated; review-only may omit the worker.
  // A model or effort without its role kind is an orphan option, not a silent drop.
  for (const roleName of CHILD_ROLE_KINDS) {
    const kind = args[roleName];
    if (kind === null) {
      for (const flag of [`${roleName}Model`, `${roleName}Effort`]) {
        if (args[flag] !== null) {
          throw new RoleError(`${ROLE_FLAG_BY_OPTION[flag]} requires --${roleName}.`);
        }
      }
      continue;
    }
    if (!supportedAgents.has(kind) && !agents[normalizeAgent(kind)]) {
      throw new RoleError(`Unsupported ${roleName}: ${kind}`);
    }
    assertOpenCodeOptions(roleName, kind, args[`${roleName}Model`], args[`${roleName}Effort`]);
  }
}

function initialState(args) {
  return {
    task: args.task,
    mode: args.mode ?? "work-first",
    cwd: args.cwd,
    parentSession: args.parentSession,
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    timeout: args.timeoutProvided ? args.timeout : DEFAULT_TIMEOUT,
    stepsUsed: 0,
    lifecycle: "active",
    pr: args.pr,
    copyLocalFiles: !args.noCopyLocalFiles,
    roles: {
      worker: roleState(args, "worker"),
      reviewer: roleState(args, "reviewer"),
    },
    lastDispatch: null,
    lastResult: null,
    turns: [],
  };
}

/** Role state, or null when the role was not configured at init. */
function roleState(source, roleName) {
  const kind = source[roleName];
  if (kind === null) {
    return null;
  }
  return {
    kind: normalizeAgent(kind),
    model: source[`${roleName}Model`] ?? null,
    effort: source[`${roleName}Effort`] ?? null,
    sessionId: null,
  };
}

/**
 * Archives a terminal state file as `state.<timestamp>.json` so a new run can
 * take its place. Absence is a no-op. Called only after every init check and
 * the prompt read pass, so a rejected init archives nothing (#123).
 */
async function archiveState(paths, existing) {
  if (!existing) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = join(dirname(paths.stateFile), `state.${stamp}.json`);
  await rename(paths.stateFile, archived);
  logInfo(`archived terminal state file to ${archived}`);
}

/**
 * Later calls read configuration from the state file and reject any change.
 * `extend` passes `maxSteps` in `allowed`, because raising it is that operation's
 * purpose; every other init field stays fixed.
 */
function rejectInitFlagChanges(args, state, allowed = []) {
  const provided = [];
  for (const flag of INIT_FIELDS) {
    if (allowed.includes(flag)) {
      continue;
    }
    const isGiven = flag === "timeout" ? args.timeoutProvided : args[flag] !== null;
    if (isGiven) {
      provided.push([flag, args[flag], state[flag]]);
    }
  }
  // The copy runs once at init, so a later call cannot turn it off. A state file
  // written before the field copied nothing, so its absent value counts as on
  // only for this comparison.
  if (args.noCopyLocalFiles && (state.copyLocalFiles ?? true) !== false) {
    throw new RoleError(
      `--no-copy-local-files cannot be changed after init (state holds: ${JSON.stringify(state.copyLocalFiles ?? null)}).`,
    );
  }
  for (const roleName of CHILD_ROLE_KINDS) {
    for (const [flag, path] of [
      [roleName, "kind"],
      [`${roleName}Model`, "model"],
      [`${roleName}Effort`, "effort"],
    ]) {
      const value = args[flag];
      if (value !== null) {
        // Only the role kind is normalized (`antigravity` -> `agy`); model and
        // effort are opaque pass-through strings compared verbatim. A role the
        // init left unset (null) compares as null, so any supplied value is a
        // change.
        const comparable = flag === roleName ? normalizeAgent(value) : value;
        provided.push([flag, comparable, state.roles[roleName]?.[path] ?? null]);
      }
    }
  }
  for (const [flag, value, existing] of provided) {
    if (value !== existing) {
      throw new RoleError(
        `${ROLE_FLAG_BY_OPTION[flag] ?? `--${kebab(flag)}`} cannot be changed after init (state holds: ${JSON.stringify(existing ?? null)}).`,
      );
    }
  }
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

async function readPrompt(args, stdin) {
  const text = args.promptFile ? await readFile(args.promptFile, "utf8") : await stdin(args);
  if (text.trim() === "") {
    throw new RoleError(
      args.promptFile
        ? `Prompt file is empty: ${args.promptFile}`
        : "Prompt on stdin is empty. Pipe a prompt or use --prompt-file.",
    );
  }
  return text;
}

function readStdin() {
  return new Promise((resolveText, reject) => {
    if (process.stdin.isTTY) {
      reject(new RoleError("No prompt received on stdin. Pipe a prompt or use --prompt-file."));
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveText(data));
    process.stdin.on("error", reject);
  });
}

function createEventSink(transcriptFile) {
  const events = [];
  const onEvent = (event) => {
    if (transcriptFile) {
      // Stamped at emit time, like the headless transcript.
      events.push({ ...event, at: new Date().toISOString() });
    }
  };
  // Appends once per invocation so a process exit cannot lose the events.
  onEvent.flush = async () => {
    if (!transcriptFile || events.length === 0) {
      return;
    }
    const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    try {
      await appendFile(transcriptFile, text, "utf8");
    } catch (err) {
      // Transcript failures must not change the command outcome.
      console.error(`Warning: Failed to append transcript to ${transcriptFile}: ${err.message}`);
    }
    events.length = 0;
  };
  return onEvent;
}

/**
 * Dispatch operation: initialize on the first call, then charge the step,
 * mark `dispatched`, run exactly one child turn, and record the result.
 */
async function dispatch(args, { agents, stdin = readStdin, signal, gh }) {
  if (!args.role) {
    throw new RoleError("dispatch requires --role worker or reviewer.");
  }
  if (args.reason !== null) {
    throw new RoleError("--reason is only valid for abort.");
  }
  rejectFinishOnlyFlags(args, "dispatch");

  await assertGitWorkTree(args.cwd);
  const paths = statePaths(
    args.parentSession ? { cwd: args.cwd, parentSession: args.parentSession } : { cwd: args.cwd },
  );
  const onEvent = createEventSink(args.transcript);

  try {
    return await withStateLock(paths.lockFile, () =>
      dispatchLocked(args, { agents, stdin, signal, paths, onEvent, gh }),
    );
  } finally {
    await onEvent.flush();
  }
}

async function dispatchLocked(args, { agents, stdin, signal, paths, onEvent, gh }) {
  const existing = await readState(paths.stateFile);
  const init = isInitCall(args);
  let state;

  if (init) {
    // New-run rule: init over a terminal or absent state file is allowed; init
    // over a non-terminal lifecycle is rejected and the parent must abort it
    // first. Nothing is archived or written until every init check and the
    // prompt read pass, so a rejected init leaves the previous state untouched.
    validateInitFlags(args, agents);
    if (existing && !TERMINAL_LIFECYCLES.has(existing.lifecycle)) {
      throw new RoleError(
        `Existing run is ${existing.lifecycle}; abort it before starting a new run.`,
      );
    }
    state = initialState(args);
  } else {
    state = requireState(existing, args.cwd, { needsBudget: true });
    rejectInitFlagChanges(args, state);
  }

  const roleName = args.role;

  // Hard guard that survives compaction and restart: review-only never runs the worker.
  if (state.mode === "review-only" && roleName === "worker") {
    throw new RoleError("mode review-only rejects --role worker.");
  }

  if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
    throw new RoleError(`Run is ${state.lifecycle}; no further dispatch is possible.`);
  }

  if (state.lifecycle === "interrupted") {
    if (!args.resumeInterrupted) {
      throw new RoleError(
        "Previous turn is interrupted. Use abort, or dispatch --resume-interrupted to continue.",
      );
    }
    state.resumeDecision = { at: new Date().toISOString() };
  } else if (state.lifecycle === "dispatched") {
    // A live lock owner would have thrown in withStateLock, so the previous
    // turn ended uncertainly. The first call after the crash always marks
    // `interrupted`, exits non-zero, and spawns no child; a maintainer can
    // resume from `interrupted` on a later call.
    state.lifecycle = "interrupted";
    // The previous call charged a step and recorded no result for it, so the
    // history is missing that turn. Record it here, marked `interrupted`: no
    // child ran, so there is no verdict and no reviewed head to record. Role
    // and time come from that turn's `lastDispatch`, because this call's
    // `--role` need not be the role that ended uncertainly (#312).
    recordTurn(
      state,
      state.lastDispatch?.role ?? roleName,
      { status: "interrupted" },
      state.lastDispatch?.at ?? new Date().toISOString(),
    );
    await writeState(paths.stateFile, state);
    throw new RoleError(
      "Previous turn ended uncertainly; state marked interrupted. Use abort, or dispatch --resume-interrupted to continue.",
    );
  }

  if (state.stepsUsed >= state.maxSteps) {
    throw new RoleError(`Step budget exhausted (${state.stepsUsed}/${state.maxSteps}).`);
  }

  const prompt = await readPrompt(args, stdin);

  let localFiles = null;
  if (init) {
    // Every check and the prompt read passed. The copy comes first, before the
    // state file exists, so a copy that throws leaves no run to abort, and
    // before the first child turn and snapshot, so every turn sees the files.
    if (state.copyLocalFiles) {
      localFiles = await copyLocalFiles(args.cwd);
      if (localFiles) {
        onEvent({ type: "local-files", ...localFiles });
      }
    }
    // Now archive the old terminal state file, if any, and write the new one.
    await archiveState(paths, existing);
    await writeState(paths.stateFile, state);
    if (args.parentSession) {
      await writeSessionEntry(paths.sessionEntryFile, paths.stateFile);
    }
    logInfo(`initialized run state (mode: ${state.mode}, maxSteps: ${state.maxSteps})`);
  }

  // Charge the step before execution, matching the headless runtime.
  state.stepsUsed += 1;
  state.lifecycle = "dispatched";
  state.lastDispatch = { role: roleName, prompt, at: new Date().toISOString() };
  await writeState(paths.stateFile, state);

  const role = { ...state.roles[roleName] };
  let result;
  try {
    result = await runChild({
      agents,
      role,
      roleName,
      prompt,
      cwd: args.cwd,
      timeout: state.timeout,
      signal,
      stepsUsed: state.stepsUsed,
      // The declared PR is the run's PR input, so a reviewer turn supplies the
      // required-check status the runtime read (#320). A run that declares no PR
      // reads nothing, and the reviewer keeps its own read.
      pr: state.pr ?? null,
      gh,
      onEvent,
    });
  } catch (err) {
    const canceled = Boolean(err?.isCanceled);
    const payload = { role: roleName, status: "error", error: errorMessage(err) };
    // A cancel or a fatal guard error can end the turn after the CLI reported its session, so
    // keep the id for the resume that follows. A null id records a session the fallback cleared.
    state.roles[roleName].sessionId = role.sessionId;
    state.lifecycle = canceled ? "interrupted" : "halted";
    const at = new Date().toISOString();
    state.lastResult = { ...payload, at };
    recordTurn(state, roleName, payload, at);
    await writeState(paths.stateFile, state);
    onEvent({ type: "result", role: roleName, result: payload, stepsUsed: state.stepsUsed });
    return { exitCode: canceled ? 130 : 1, payload: withLocalFiles(payload, localFiles) };
  }

  state.lifecycle = "active";
  const at = new Date().toISOString();
  state.lastResult = { ...result, at };
  recordTurn(state, roleName, result, at);
  state.roles[roleName].sessionId = role.sessionId;
  await writeState(paths.stateFile, state);

  onEvent({ type: "result", role: roleName, result, stepsUsed: state.stepsUsed });

  // The dispatch itself succeeded, but a child error result is still a
  // non-zero command outcome for the calling parent.
  return {
    exitCode: result.status === "ok" ? 0 : 1,
    payload: withLocalFiles(dispatchPayload(roleName, result), localFiles),
  };
}

/** Adds the copied and skipped path names of the init copy to the envelope. */
function withLocalFiles(payload, localFiles) {
  return localFiles ? { ...payload, localFiles } : payload;
}

function errorMessage(err) {
  return err?.message ?? String(err);
}

/**
 * Appends one turn entry to `turns`, which survives every later overwrite of
 * `lastDispatch` and `lastResult`. The entry records the turn's identity, not
 * its text: `role`, `status`, `verdict`, the reviewed `head`, and `at`. Report
 * and response text stay out of it, so the state file cannot grow with the text
 * a child returns (#312).
 *
 * Exactly one entry exists per charged step: an entry is written when a
 * dispatch records its result, when a child fails, and when the recovery call
 * records the turn a crash left uncertain. A dispatch past `maxSteps` is refused
 * before it runs, so the array holds at most `maxSteps` entries. A state file
 * written before this field exists starts with an empty history.
 *
 * `status` is `ok`, `error`, or `interrupted`. `interrupted` marks a charged
 * turn whose outcome is unknown, so it carries no verdict and no reviewed head.
 */
function recordTurn(state, roleName, result, at) {
  if (!Array.isArray(state.turns)) {
    state.turns = [];
  }
  const ok = result.status === "ok";
  state.turns.push({
    role: roleName,
    status: result.status,
    // Only a reviewer turn carries a verdict; the word never comes from a
    // worker response.
    verdict: ok && roleName === "reviewer" ? parseVerdict(result.response) : null,
    head: ok ? (result.reviewed?.head ?? null) : null,
    at,
  });
}

// Builds the envelope for one dispatched turn. When the closing block does not
// parse, `raw` carries the whole response: a bounded tail can drop the head of a
// long block and with it the text the report was meant to preserve (issue #268).
function dispatchPayload(roleName, result) {
  if (result.status !== "ok") {
    return { role: roleName, status: "error", error: result.error };
  }
  const report = parseReportBlock(result.response);
  const payload = { role: roleName, status: "ok", report };
  if (roleName === "reviewer") {
    payload.verdict = parseVerdict(result.response);
    if (result.reviewed) {
      payload.reviewed = result.reviewed;
    }
    // The required-check status the runtime read for a declared PR, so the
    // parent can compare it with the reviewer Checks line (#320). The state file
    // keeps it beside the response in `lastResult`. The turn history entry keeps
    // its fixed shape (ADR 0008), so the status is not recorded there.
    if (result.prChecks) {
      payload.prChecks = result.prChecks;
    }
  }
  if (!report) {
    payload.raw = result.response;
  }
  return payload;
}

/**
 * Runs `fn(state, paths)` under the state lock for a run that is not terminal.
 * Rejects init-flag changes and a terminal lifecycle first. `requireOptions`
 * goes to `requireState`.
 */
function withOpenRun(args, requireOptions, fn) {
  const paths = statePaths({ cwd: args.cwd });
  return withStateLock(paths.lockFile, async () => {
    const state = requireState(await readState(paths.stateFile), args.cwd, requireOptions);
    rejectInitFlagChanges(args, state);
    if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      throw new RoleError(`Run is already ${state.lifecycle}.`);
    }
    return fn(state, paths);
  });
}

/**
 * `finish`: accepts the five-key summary as JSON on stdin, from active only.
 * `--require-accept` and `--require-ci` gate the finish; every applicable
 * refusal is collected and reported in one error, in the order the headless list
 * uses, because a finish that breaks two rules must name both. An optional
 * `unresolvedCompare` boolean beside the five
 * keys records an unresolved PR-head compare, which the envelope and the state
 * file then carry, so the finish stays distinct from a verified one (#281). An
 * omitted marker is that same accepted gap the contract documents beside the
 * field, because this subcommand without `--require-ci` never resolves the PR
 * head (#286). The headless loop resolves it under the same flag (#293). A run
 * that declared `--pr <pr>` at init must end through the `--require-ci <pr>`
 * gate: a finish with no gate, or with a gate for another PR, is refused, and so
 * is one that carries the marker (#302). A gate that passes on a base branch
 * with no required check verified the PR head, the clean reviewed tree, and the
 * merge state, so the finish records `noRequiredChecks` in the envelope and the
 * state file (#336).
 */
async function finish(args, { stdin = readStdin, gh } = {}) {
  if (args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }

  return withOpenRun(args, { needsBudget: true }, async (state, paths) => {
    if (state.lifecycle !== "active") {
      throw new RoleError(`finish is accepted only from active; run is ${state.lifecycle}.`);
    }

    if ((args.requireAccept || args.requireCi !== null) && state.mode === "review-only") {
      throw new RoleError(REVIEW_ONLY_GATE_REFUSAL);
    }

    const text = await stdin(args);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RoleError("finish summary must be a JSON object on stdin.");
    }
    // The summary arrives unwrapped, so the marker the headless action carries
    // beside `summary` sits beside the five keys here. The validator drops it
    // from the summary and keeps its own boolean check (#281).
    const action = { action: "finish", summary: value };
    if (value?.unresolvedCompare !== undefined) {
      action.unresolvedCompare = value.unresolvedCompare;
    }
    const validated = validateAction(action);
    if (!validated.ok) {
      throw new RoleError(validated.error);
    }
    // Every applicable refusal is collected and reported in one error, in the
    // order the headless list uses, minus the `review-only` reviewer-turn
    // condition this path cannot reach: the marker condition, the completion
    // rule, then the declared-PR gate condition, then the gate. A finish that
    // breaks two rules must name both, or the parent spends a `finish` call per
    // condition. The gate runs only when nothing above refused, so a refused
    // finish never reads GitHub, which the headless loop cannot promise because
    // it owns the whole run (#302).
    const refusals = [];
    // The headless gate refuses the same combination with the same words, so the
    // message is one function rather than two copies (#293).
    const markerReason = unresolvedCompareReason({
      pr: state.pr ?? null,
      requireCi: args.requireCi,
    });
    const markerRefused = markerReason !== null && validated.value.unresolvedCompare;
    if (markerRefused) {
      refusals.push(markerReason);
    }
    if (args.requireAccept) {
      const reason = await acceptGateReason(state, args.cwd);
      if (reason) {
        refusals.push(reason);
      }
    }
    // The init-time `--pr` declaration is the run's PR input, so a declared run
    // can only end through the gate for that PR. A state file written before this
    // field has no `pr`, so an absent declaration keeps the marker-only behavior.
    const declaredPr = state.pr ?? null;
    if (declaredPr !== null && args.requireCi !== declaredPr) {
      refusals.push(missingGateRefusal(declaredPr, args.requireCi).reason);
    }
    if (refusals.length > 0) {
      // The marker contradiction against a gate was its own error text before
      // collect-then-report, and a run that declares no PR still returns that text
      // on its own, because it has the same single refusal it always had (#302).
      if (refusals.length === 1 && markerRefused && declaredPr === null) {
        throw new RoleError(`${markerReason}.`);
      }
      throw new RoleError(`Finish refused: ${refusals.join("; ")}.`);
    }
    let noRequiredChecks = false;
    if (args.requireCi !== null) {
      const gate = await checkCi({
        pr: args.requireCi,
        reviewed: state.lastResult?.reviewed ?? null,
        cwd: args.cwd,
        gh,
      });
      if (!gate.ok) {
        throw new RoleError(`Finish refused: ${gate.reason}.`);
      }
      noRequiredChecks = gate.noRequiredChecks === true;
    }

    state.lifecycle = "finished";
    state.summary = validated.value.summary;
    const payload = { status: "ok", lifecycle: "finished" };
    if (noRequiredChecks) {
      // A base branch with no required check leaves the gate verifying the PR
      // head, the clean reviewed tree, and the merge state only. The finish
      // records that, so a reader never reads it as a pass on a checked branch
      // (#336).
      state.noRequiredChecks = true;
      payload.noRequiredChecks = true;
      logInfo(
        "no required check exists for the base branch; the gate verified the PR head, the reviewed tree, and the merge state",
      );
    }
    if (validated.value.unresolvedCompare) {
      // Recorded in the envelope and beside the summary in the state file, so a
      // recorded unresolved compare never reads as a verified finish (#281). A
      // verified finish keeps the current envelope and state.
      state.unresolvedCompare = true;
      payload.unresolvedCompare = true;
    }
    await writeState(paths.stateFile, state);
    logInfo(`run finished (${state.stepsUsed} steps used)`);
    return { exitCode: 0, payload };
  });
}

/** `--require-accept` and `--require-ci` gate `finish`; every other operation rejects them. */
function rejectFinishOnlyFlags(args, operation) {
  if (args.requireAccept || args.requireCi !== null) {
    throw new RoleError(
      `--require-accept and --require-ci are only valid for finish, not ${operation}.`,
    );
  }
}

/**
 * `--require-accept`: the latest turn must be a reviewer `verdict: accept` of
 * the current exact state, and the accepted review must carry a Checks line.
 * The current snapshot is compared against the reviewed head and digest, so a
 * change to an uncommitted state at the same head is detected. Returns null
 * when the gate holds, or a reason that names the failing condition.
 */
async function acceptGateReason(state, cwd) {
  const last = state.lastResult;
  if (!last || last.role !== "reviewer" || last.status !== "ok") {
    return "no reviewer turn after the latest worker turn";
  }
  if (parseVerdict(last.response) !== "accept") {
    return "the latest reviewer turn did not return Verdict: accept";
  }
  if (!parseReportBlock(last.response)?.checks) {
    return "the accepted review has no Checks line";
  }
  if (!last.reviewed) {
    return "the reviewer turn carries no reviewed state";
  }
  if (!last.reviewed.exact) {
    return "the reviewed snapshot is not exact";
  }
  const current = reviewedState(await snapshot(cwd));
  if (!current.exact) {
    return "the current snapshot is not exact";
  }
  if (current.head !== last.reviewed.head) {
    return "the work tree HEAD changed after the accepted review";
  }
  if (current.digest !== last.reviewed.digest) {
    return "the work tree changed after the accepted review";
  }
  return null;
}

/** `abort`: records the reason and ends the run; accepted from any non-terminal lifecycle. */
async function abort(args) {
  if (args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }
  if (args.reason === null) {
    throw new RoleError("abort requires --reason.");
  }
  rejectFinishOnlyFlags(args, "abort");

  return withOpenRun(args, {}, async (state, paths) => {
    state.lifecycle = "aborted";
    state.reason = args.reason;
    await writeState(paths.stateFile, state);
    logInfo(`run aborted: ${args.reason}`);
    return { exitCode: 0, payload: { status: "ok", lifecycle: "aborted" } };
  });
}

/**
 * `extend`: raises `maxSteps` of a non-terminal run in place, so the stored role
 * session ids and first-turn tracking keep working where a new run would start
 * every role on a new session (#361). The new value must exceed both `stepsUsed`
 * and the current `maxSteps`; `--max-steps` already passed the init range check
 * at parse time. The change is appended to `budgetChanges` with the steps used at
 * that point, so the history shows where the budget moved (ADR 0014). The
 * lifecycle is left as it is: an `interrupted` run stays interrupted.
 */
async function extend(args) {
  if (args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }
  if (args.reason !== null) {
    throw new RoleError("--reason is only valid for abort.");
  }
  rejectFinishOnlyFlags(args, "extend");
  if (args.maxSteps === null) {
    throw new RoleError("extend requires --max-steps <count>.");
  }
  if (args.parentSession === null) {
    throw new RoleError(
      "extend requires --parent-session (the harness session id the run was started with).",
    );
  }

  const paths = statePaths({ cwd: args.cwd });
  return withStateLock(paths.lockFile, async () => {
    const state = requireState(await readState(paths.stateFile), args.cwd, { needsBudget: true });
    // The caller must pass the run's stored parent session id, the id the
    // parent-edit guard matches. The refusal does not name the stored id.
    // known-limit: the check compares the id only and does not identify the
    // caller, so a caller that read the id from the state file passes; the rule
    // that a child never calls extend rests on the orchestrator instructions.
    if (args.parentSession !== state.parentSession) {
      throw new RoleError("--parent-session does not match the run's parent session.");
    }
    rejectInitFlagChanges(args, state, ["maxSteps"]);
    if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      throw new RoleError(`Run is already ${state.lifecycle}.`);
    }
    if (args.maxSteps <= state.stepsUsed) {
      throw new RoleError(
        `--max-steps must be larger than stepsUsed (${state.stepsUsed}), got: ${args.maxSteps}.`,
      );
    }
    if (args.maxSteps <= state.maxSteps) {
      throw new RoleError(
        `--max-steps must be larger than the current maxSteps (${state.maxSteps}), got: ${args.maxSteps}.`,
      );
    }
    if (!Array.isArray(state.budgetChanges)) {
      state.budgetChanges = [];
    }
    state.budgetChanges.push({
      from: state.maxSteps,
      to: args.maxSteps,
      stepsUsed: state.stepsUsed,
      at: new Date().toISOString(),
    });
    state.maxSteps = args.maxSteps;
    await writeState(paths.stateFile, state);
    logInfo(`step budget raised to ${state.maxSteps} (${state.stepsUsed} steps used)`);
    return {
      exitCode: 0,
      payload: {
        status: "ok",
        lifecycle: state.lifecycle,
        maxSteps: state.maxSteps,
        stepsUsed: state.stepsUsed,
      },
    };
  });
}

/**
 * `wait-checks`: polls the required checks of `--pr` until none is pending or
 * the bound elapses, then prints the last check states with a `timedOut` flag.
 * It reads status only, so it touches no run state and needs no init, but it
 * applies the same `--cwd` rule as `dispatch`, because the read runs in that
 * work tree. The bound starts at command entry, so validation and every read
 * share it, and the command returns within the bound plus the child-exit ceiling
 * the wait adds on a bound it reached. The bound defaults to 300 seconds;
 * `--timeout 0` is refused, because an unbounded wait is the outcome this
 * operation exists to prevent (#329).
 */
// `assertWorkTree` is the real `assertGitWorkTree` unless a caller injects it,
// so a test can spend clock time on work-tree validation and check that the time
// comes out of the wait bound.
async function waitChecksOperation(
  args,
  { gh, signal, now = Date.now, sleep, assertWorkTree = assertGitWorkTree } = {},
) {
  if (args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }
  if (args.reason !== null) {
    throw new RoleError("--reason is only valid for abort.");
  }
  rejectFinishOnlyFlags(args, "wait-checks");
  if (args.pr === null) {
    throw new RoleError("wait-checks requires --pr <pr>.");
  }
  if (args.timeoutProvided && args.timeout === null) {
    throw new RoleError("wait-checks refuses --timeout 0: the wait must stay bounded.");
  }
  // Taken at command entry, so no step of the command pushes it past the stated
  // bound: work-tree validation, every read, and the pauses between reads all
  // come out of it (#329).
  const deadline = now() + (args.timeout ?? DEFAULT_WAIT_SECONDS) * 1000;
  const remaining = deadline - now();
  if (remaining > 0) {
    // The validation runs inside the same bound, so a hung `git` cannot add its
    // own time to the command. It refuses on the bound, because a work tree the
    // probe never confirmed is not one this command may read.
    await withinBound(
      remaining,
      () => assertWorkTree(args.cwd, { timeoutMs: remaining }),
      "--cwd validation did not complete within the wait bound, so the work tree was not confirmed.",
    );
  }
  const result = await waitChecks({
    pr: args.pr,
    cwd: args.cwd,
    deadline,
    gh,
    now,
    sleep,
    signal,
  });
  return { exitCode: 0, payload: { status: "ok", pr: args.pr, ...result } };
}

/**
 * Runs `work` and rejects when it has not settled within `ms`, so a step that
 * hangs cannot outlive the bound the caller owns. The work promise is consumed
 * either way, so a late failure after the bound is not an unhandled rejection.
 */
async function withinBound(ms, work, message) {
  let timer;
  try {
    const guarded = Promise.resolve(work()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ expired: true }), ms);
    });
    const outcome = await Promise.race([guarded, expired]);
    if (outcome.expired) {
      throw new RoleError(message);
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes one parsed role command. Returns `{ exitCode, payload }`; the
 * payload is the JSON envelope. Unexpected failures become `status: "error"`
 * envelopes instead of stack traces on stdout.
 */
export async function executeRoleCommand(args, deps = {}) {
  try {
    switch (args.operation) {
      case "dispatch":
        return await dispatch(args, deps);
      case "finish":
        return await finish(args, deps);
      case "abort":
        return await abort(args, deps);
      case "extend":
        return await extend(args);
      case "wait-checks":
        return await waitChecksOperation(args, deps);
      default:
        throw new RoleError(`Unsupported operation: ${args.operation}`);
    }
  } catch (err) {
    return { exitCode: 1, payload: { status: "error", error: errorMessage(err) } };
  }
}

/**
 * Entry point for `agent-loop role ...`. Prints exactly one JSON envelope on
 * stdout and sets the process exit code, except `--help`, which prints plain
 * usage and exits 0. All lifecycle logging goes to stderr.
 */
export async function main(argv, { agents = defaultAgents } = {}) {
  setLogsToStderr(true);

  const controller = new AbortController();
  const onSigInt = () => {
    controller.abort();
  };
  process.once("SIGINT", onSigInt);

  try {
    let args;
    try {
      args = parseRoleArgs(argv);
      setVerbose(args.verbose);
    } catch (err) {
      console.log(JSON.stringify({ status: "error", error: errorMessage(err) }));
      process.exitCode = 1;
      return;
    }

    if (args.help) {
      console.log(ROLE_USAGE);
      return;
    }

    let exitCode;
    let payload;
    try {
      ({ exitCode, payload } = await executeRoleCommand(args, {
        agents,
        signal: controller.signal,
      }));
    } catch (err) {
      if (err?.isCanceled) {
        exitCode = 130;
        payload = { status: "error", error: "Interrupted by SIGINT" };
      } else {
        exitCode = 1;
        payload = { status: "error", error: errorMessage(err) };
      }
    }

    console.log(JSON.stringify(payload));
    process.exitCode = exitCode;
  } finally {
    process.removeListener("SIGINT", onSigInt);
  }
}
