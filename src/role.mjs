// `agent-loop role`: run one worker or reviewer turn, or finish/abort a run,
// through the same guards as the headless loop, driven by a lifecycle state
// file instead of an in-process orchestrator. Stdout carries exactly one JSON
// envelope per invocation; all logs go to stderr.
import { readFile, appendFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultAgents, normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  CHILD_ROLE_KINDS,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT,
  ROLE_FLAG_BY_OPTION,
  assertOpenCodeOptions,
  readArgValue,
  readNonNegativeInt,
  readPositiveInt,
  roleFlags,
} from "./lib/args.mjs";
import { logInfo, setVerbose, setLogsToStderr } from "./lib/log.mjs";
import { parseReportBlock, parseVerdict } from "./lib/report.mjs";
import {
  TERMINAL_LIFECYCLES,
  readState,
  statePaths,
  withStateLock,
  writeSessionIndex,
  writeState,
} from "./lib/runstate.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { runChild } from "./runtime.mjs";
import { validateAction } from "./contracts/orchestrator-action.mjs";

const OPERATIONS = new Set(["dispatch", "finish", "abort"]);
const MODES = new Set(["work-first", "review-first", "review-only"]);
const ROLE_NAMES = new Set(CHILD_ROLE_KINDS);
const ROLE_FLAGS = roleFlags(CHILD_ROLE_KINDS);
// Bound for `raw` in the envelope when the closing block could not be parsed.
const RAW_TAIL_LIMIT = 2000;

class RoleError extends Error {}

const INIT_FIELDS = ["task", "mode", "parentSession", "maxSteps", "timeout"];

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
    reason: null,
    verbose: false,
    timeoutProvided: false,
  };

  let index = 0;
  if (argv.length > 0 && OPERATIONS.has(argv[0])) {
    args.operation = argv[0];
    index = 1;
  }

  const readValue = (flag, i) => readArgValue(argv, flag, i);

  for (; index < argv.length; index++) {
    const arg = argv[index];

    switch (arg) {
      case "--role":
        args.role = readValue(arg, ++index);
        if (!ROLE_NAMES.has(args.role)) {
          throw new RoleError(`--role must be worker or reviewer, got: ${args.role}`);
        }
        break;

      case "--cwd":
        args.cwd = resolve(readValue(arg, ++index));
        break;

      case "--task":
        args.task = readValue(arg, ++index);
        break;

      case "--mode":
        args.mode = readValue(arg, ++index);
        if (!MODES.has(args.mode)) {
          throw new RoleError(
            `--mode must be one of work-first, review-first, review-only, got: ${args.mode}`,
          );
        }
        break;

      case "--parent-session":
        args.parentSession = readValue(arg, ++index);
        break;

      case "--max-steps":
        args.maxSteps = readPositiveInt(arg, readValue(arg, ++index));
        break;

      case "--timeout": {
        const seconds = readNonNegativeInt(arg, readValue(arg, ++index));
        args.timeout = seconds === 0 ? null : seconds;
        args.timeoutProvided = true;
        break;
      }

      case "--prompt-file":
        args.promptFile = resolve(readValue(arg, ++index));
        break;

      case "--transcript":
        args.transcript = resolve(readValue(arg, ++index));
        break;

      case "--resume-interrupted":
        args.resumeInterrupted = true;
        break;

      case "--reason":
        args.reason = readValue(arg, ++index);
        break;

      case "--verbose":
        args.verbose = true;
        break;

      default:
        if (!Object.hasOwn(ROLE_FLAGS, arg)) {
          throw new RoleError(`Unknown argument: ${arg}`);
        }
        args[ROLE_FLAGS[arg]] = readValue(arg, ++index);
        break;
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

/** Rejects a non-init call when no state file exists for the work tree. */
function requireState(state, cwd) {
  if (!state) {
    throw new RoleError(
      `No run state for ${cwd}. Start one with: agent-loop role --task "..." --worker ... --reviewer ...`,
    );
  }
  return state;
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
    roles: {
      worker: roleState(args, "worker"),
      reviewer: roleState(args, "reviewer"),
    },
    lastDispatch: null,
    lastResult: null,
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

/** Later calls read configuration from the state file and reject any change. */
function rejectInitFlagChanges(args, state) {
  const provided = [];
  for (const flag of INIT_FIELDS) {
    const isGiven = flag === "timeout" ? args.timeoutProvided : args[flag] !== null;
    if (isGiven) {
      provided.push([flag, args[flag], state[flag]]);
    }
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
async function dispatch(args, { agents, stdin = readStdin, signal }) {
  if (!args.role) {
    throw new RoleError("dispatch requires --role worker or reviewer.");
  }
  if (args.reason !== null) {
    throw new RoleError("--reason is only valid for abort.");
  }

  await assertGitWorkTree(args.cwd);
  const paths = statePaths(
    args.parentSession ? { cwd: args.cwd, parentSession: args.parentSession } : { cwd: args.cwd },
  );
  const onEvent = createEventSink(args.transcript);

  try {
    return await withStateLock(paths.lockFile, () =>
      dispatchLocked(args, { agents, stdin, signal, paths, onEvent }),
    );
  } finally {
    await onEvent.flush();
  }
}

async function dispatchLocked(args, { agents, stdin, signal, paths, onEvent }) {
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
    state = requireState(existing, args.cwd);
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
    await writeState(paths.stateFile, state);
    throw new RoleError(
      "Previous turn ended uncertainly; state marked interrupted. Use abort, or dispatch --resume-interrupted to continue.",
    );
  }

  if (state.stepsUsed >= state.maxSteps) {
    throw new RoleError(`Step budget exhausted (${state.stepsUsed}/${state.maxSteps}).`);
  }

  const prompt = await readPrompt(args, stdin);

  if (init) {
    // Every check and the prompt read passed; now archive the old terminal
    // state file, if any, and write the new one.
    await archiveState(paths, existing);
    await writeState(paths.stateFile, state);
    if (args.parentSession) {
      await writeSessionIndex(paths.sessionIndexFile, paths.stateFile);
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
      onEvent,
    });
  } catch (err) {
    const canceled = Boolean(err?.isCanceled);
    const payload = { role: roleName, status: "error", error: errorMessage(err) };
    state.lifecycle = canceled ? "interrupted" : "halted";
    state.lastResult = { ...payload, at: new Date().toISOString() };
    await writeState(paths.stateFile, state);
    onEvent({ type: "result", role: roleName, result: payload, stepsUsed: state.stepsUsed });
    return { exitCode: canceled ? 130 : 1, payload };
  }

  state.lifecycle = "active";
  state.lastResult = { ...result, at: new Date().toISOString() };
  if (role.sessionId) {
    state.roles[roleName].sessionId = role.sessionId;
  }
  await writeState(paths.stateFile, state);

  onEvent({ type: "result", role: roleName, result, stepsUsed: state.stepsUsed });

  // The dispatch itself succeeded, but a child error result is still a
  // non-zero command outcome for the calling parent.
  return { exitCode: result.status === "ok" ? 0 : 1, payload: dispatchPayload(roleName, result) };
}

function errorMessage(err) {
  return err?.message ?? String(err);
}

function dispatchPayload(roleName, result) {
  if (result.status !== "ok") {
    return { role: roleName, status: "error", error: result.error };
  }
  const report = parseReportBlock(result.response);
  const payload = { role: roleName, status: "ok", report };
  if (roleName === "reviewer") {
    payload.verdict = parseVerdict(result.response);
  }
  if (!report) {
    payload.raw = result.response.slice(-RAW_TAIL_LIMIT);
  }
  return payload;
}

/**
 * `finish`: accepts the five-key summary as JSON on stdin, from active only.
 */
async function finish(args, { stdin = readStdin }) {
  if (args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }

  const paths = statePaths({ cwd: args.cwd });
  return withStateLock(paths.lockFile, async () => {
    const state = requireState(await readState(paths.stateFile), args.cwd);
    rejectInitFlagChanges(args, state);
    if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      throw new RoleError(`Run is already ${state.lifecycle}.`);
    }
    if (state.lifecycle !== "active") {
      throw new RoleError(`finish is accepted only from active; run is ${state.lifecycle}.`);
    }

    const text = await stdin(args);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RoleError("finish summary must be a JSON object on stdin.");
    }
    const validated = validateAction({ action: "finish", summary: value });
    if (!validated.ok) {
      throw new RoleError(validated.error);
    }

    state.lifecycle = "finished";
    state.summary = validated.value.summary;
    await writeState(paths.stateFile, state);
    logInfo(`run finished (${state.stepsUsed} steps used)`);
    return { exitCode: 0, payload: { status: "ok", lifecycle: "finished" } };
  });
}

/** `abort`: records the reason and ends the run; accepted from any non-terminal lifecycle. */
async function abort(args) {
  if (args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }
  if (args.reason === null) {
    throw new RoleError("abort requires --reason.");
  }

  const paths = statePaths({ cwd: args.cwd });
  return withStateLock(paths.lockFile, async () => {
    const state = requireState(await readState(paths.stateFile), args.cwd);
    rejectInitFlagChanges(args, state);
    if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      throw new RoleError(`Run is already ${state.lifecycle}.`);
    }
    state.lifecycle = "aborted";
    state.reason = args.reason;
    await writeState(paths.stateFile, state);
    logInfo(`run aborted: ${args.reason}`);
    return { exitCode: 0, payload: { status: "ok", lifecycle: "aborted" } };
  });
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
      default:
        throw new RoleError(`Unsupported operation: ${args.operation}`);
    }
  } catch (err) {
    return { exitCode: 1, payload: { status: "error", error: errorMessage(err) } };
  }
}

/**
 * Entry point for `agent-loop role ...`. Prints exactly one JSON envelope on
 * stdout and sets the process exit code. All lifecycle logging goes to stderr.
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
