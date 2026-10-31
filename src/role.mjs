// `agent-loop role`: run one worker or reviewer turn, or finish/abort/extend a run,
// through the same guards as the headless loop, driven by a lifecycle state
// file instead of an in-process orchestrator. Stdout carries exactly one JSON
// envelope per invocation, except `--help`, which prints plain usage; all logs go
// to stderr.
import { defaultAgents } from "./agents/index.mjs";
import { CHILD_ROLE_KINDS, REVIEW_ONLY_PR_REFUSAL, openCodeOptionsError } from "./lib/args.mjs";
import { DEFAULT_WAIT_SECONDS, waitChecks } from "./lib/check-wait.mjs";
import { isSpawnedByRun } from "./lib/exec.mjs";
import { logInfo, setVerbose, setLogsToStderr } from "./lib/log.mjs";
import {
  TERMINAL_LIFECYCLES,
  cwdHash,
  readState,
  statePaths,
  writeState,
} from "./lib/runstate.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { withStateLock } from "./lib/state-lock.mjs";
import { cancelOnSigInt } from "./lib/sigint.mjs";
import {
  ROLE_USAGE,
  parseRoleArgs,
  rejectInitFlagChanges,
  rejectMisplacedFlags,
  requireParentSessionFlag,
} from "./role-args.mjs";
import { dispatch, readStdin, refuseUnreadableGate, requireState } from "./role-dispatch.mjs";
import { RoleError, printEnvelope, errorResult, writeAllSync } from "./role-envelope.mjs";
import { finishRun } from "./role-finish.mjs";

export { parseRoleArgs };

// Operations that end, extend, or change the PR or a model of a run. A child process of that run
// never runs them.
const RUN_ENDING_OPERATIONS = new Set(["finish", "abort", "extend", "declare-pr", "set-model"]);

/**
 * Runs `fn(state, paths)` under the state lock for a run that is not terminal.
 * Rejects init-flag changes and a terminal lifecycle first. `requireOptions`
 * goes to `requireState`, and `allowed` to `rejectInitFlagChanges`. `checkState`
 * runs on the state between those two, so its refusal wins over both.
 */
function withOpenRun(args, requireOptions, fn, allowed = [], checkState = () => {}) {
  const paths = statePaths({ cwd: args.cwd });
  return withStateLock(paths.lockFile, async () => {
    const state = requireState(await readState(paths.stateFile), args.cwd, requireOptions);
    checkState(state);
    rejectInitFlagChanges(args, state, allowed);
    if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      throw new RoleError(`Run is already ${state.lifecycle}.`);
    }
    return fn(state, paths);
  });
}

/** `finish`: ends an active run through the gate in `finishRun`. */
async function finish(args, { stdin = readStdin, gh, signal } = {}) {
  rejectMisplacedFlags(args, "finish");

  return withOpenRun(args, { needsBudget: true }, (state, paths) =>
    finishRun(args, state, paths, { stdin, gh, signal }),
  );
}

/**
 * `abort`: records the reason and ends the run; accepted from any non-terminal lifecycle. It does
 * not read a damaged recorded reviewer sandbox mode, because it runs no reviewer turn (ADR 0038).
 */
async function abort(args) {
  rejectMisplacedFlags(args, "abort");

  return withOpenRun(
    args,
    {},
    async (state, paths) => {
      state.lifecycle = "aborted";
      state.reason = args.reason;
      await writeState(paths.stateFile, state);
      logInfo(`run aborted: ${args.reason}`);
      return { exitCode: 0, payload: { status: "ok", lifecycle: "aborted" } };
    },
    ["reviewerSandbox"],
  );
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
  rejectMisplacedFlags(args, "extend");
  if (args.maxSteps === null) {
    throw new RoleError("extend requires --max-steps <count>.");
  }
  requireParentSessionFlag(args, "extend");

  return withOpenRun(
    args,
    { needsBudget: true },
    async (state, paths) => {
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
    },
    ["maxSteps"],
    (state) => requireStoredParentSession(args, state),
  );
}

/**
 * `declare-pr`: sets `pr` of an active or interrupted run that declared none at init, for a run
 * whose worker opens the pull request. The change is one way, unset to a number: a run that
 * already holds a PR refuses it, so the declared PR cannot move. After it the run behaves as
 * one that passed `--pr` at init: a reviewer turn supplies the required-check status, and a finish
 * must end through `--require-ci <pr>` (#916). `review-only` refuses it, as it refuses `--pr`.
 */
async function declarePr(args, { gh, signal } = {}) {
  rejectMisplacedFlags(args, "declare-pr");
  if (args.pr === null) {
    throw new RoleError("declare-pr requires --pr <pr>.");
  }
  requireParentSessionFlag(args, "declare-pr");

  return withOpenRun(
    args,
    {},
    async (state, paths) => {
      if (state.mode === "review-only") {
        throw new RoleError(REVIEW_ONLY_PR_REFUSAL);
      }
      if ((state.pr ?? null) !== null) {
        throw new RoleError(
          `declare-pr is refused: the run already declares PR ${state.pr}, and the declaration cannot change.`,
        );
      }
      await refuseUnreadableGate("declare-pr", { pr: args.pr, cwd: args.cwd, gh, signal });
      state.pr = args.pr;
      await writeState(paths.stateFile, state);
      logInfo(`run declared PR ${state.pr} (${state.stepsUsed} steps used)`);
      return {
        exitCode: 0,
        payload: { status: "ok", lifecycle: state.lifecycle, pr: state.pr },
      };
    },
    ["pr"],
    (state) => requireStoredParentSession(args, state),
  );
}

/**
 * `set-model`: replaces the model of one role that has completed no turn, so a model that the CLI
 * refused on the first turn of that role is repaired on the same run, where `abort` and a new run
 * start every role on a new session (#1254). The role is the one whose `--<role>-model` flag the
 * call carries, and exactly one is required. Only an `active` run takes it: a `dispatched` or
 * `interrupted` run can still have a child on the old model. A role with an `ok` turn is refused,
 * because its conversation already ran on the old model. The change is appended to `modelChanges`.
 * The role keeps its stored session id, which is `null` or unconfirmed after a refused first turn.
 */
async function setModel(args) {
  rejectMisplacedFlags(args, "set-model");
  const named = CHILD_ROLE_KINDS.filter((name) => args[`${name}Model`] !== null);
  if (named.length !== 1) {
    throw new RoleError("set-model requires exactly one of --worker-model and --reviewer-model.");
  }
  const [roleName] = named;
  const model = args[`${roleName}Model`];
  requireParentSessionFlag(args, "set-model");

  return withOpenRun(
    args,
    {},
    async (state, paths) => {
      if (state.lifecycle !== "active") {
        throw new RoleError(
          `set-model is refused while the run is ${state.lifecycle}: only an active run takes a model change.`,
        );
      }
      const role = state.roles?.[roleName];
      if (!role) {
        throw new RoleError(`set-model is refused: the run has no ${roleName}.`);
      }
      if (
        !Array.isArray(state.turns) ||
        state.turns.some((turn) => turn.role === roleName && turn.status === "ok")
      ) {
        throw new RoleError(
          `set-model is refused: the ${roleName} completed a turn, or the run kept no turn history, so its conversation may hold the earlier model.`,
        );
      }
      const refusal = openCodeOptionsError(roleName, role.kind, model, role.effort);
      if (refusal) {
        throw new RoleError(refusal);
      }
      const previousModel = role.model ?? null;
      if (model === previousModel) {
        // Idempotent success: no change happened, so no history entry and no state write.
        return {
          exitCode: 0,
          payload: {
            status: "ok",
            lifecycle: state.lifecycle,
            role: roleName,
            model,
            previousModel,
          },
        };
      }
      if (!Array.isArray(state.modelChanges)) {
        state.modelChanges = [];
      }
      state.modelChanges.push({
        role: roleName,
        from: previousModel,
        to: model,
        at: new Date().toISOString(),
      });
      role.model = model;
      await writeState(paths.stateFile, state);
      logInfo(`${roleName} model replaced (${state.stepsUsed} steps used)`);
      return {
        exitCode: 0,
        payload: { status: "ok", lifecycle: state.lifecycle, role: roleName, model, previousModel },
      };
    },
    ["roleModel"],
    (state) => requireStoredParentSession(args, state),
  );
}

/**
 * The caller must pass the run's stored parent session id, the id the parent-edit guard matches.
 * The refusal does not name the stored id.
 * known-limit: the id check does not identify the caller. The spawn-time run marker refuses a
 * child of this run (executeRoleCommand), but a child that clears its environment passes both
 * checks.
 */
function requireStoredParentSession(args, state) {
  if (args.parentSession !== state.parentSession) {
    throw new RoleError("--parent-session does not match the run's parent session.");
  }
}

/**
 * `wait-checks`: polls the required checks of `--pr`, or every check of its head
 * with `--all`, until none is pending or the bound elapses, then prints the last check states with a `timedOut` flag.
 * `--expect <name>` (repeatable, with `--all`) keeps the wait going until each named check has a run
 * on the head, so a check that registers late is not missed (#978).
 * `--head <sha>` keeps the wait going until the PR head is that commit. The check states are read
 * from the commit by SHA, and the result names that commit in `head` (#961).
 * It reads status only, so it touches no run state and needs no init, but it
 * applies the same `--cwd` rule as `dispatch`, because the read runs in that
 * work tree. The bound starts at command entry, so validation and every read
 * share it, and the command returns within the bound plus the child-exit ceiling
 * the wait adds on a bound it reached. The bound defaults to 300 seconds;
 * `--timeout 0` is refused, because an unbounded wait is the outcome this
 * operation exists to prevent (#329).
 * `assertWorkTree` is the real `assertGitWorkTree` unless a caller injects it,
 * so a test can spend clock time on work-tree validation and check that the time
 * comes out of the wait bound.
 */
async function waitChecksOperation(
  args,
  { gh, signal, now = Date.now, sleep, assertWorkTree = assertGitWorkTree } = {},
) {
  rejectMisplacedFlags(args, "wait-checks");
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
      () => assertWorkTree(args.cwd, { timeoutMs: remaining, signal }),
      "--cwd validation did not complete within the wait bound, so the work tree was not confirmed.",
    );
  }
  const result = await waitChecks({
    pr: args.pr,
    cwd: args.cwd,
    deadline,
    all: args.all,
    expect: args.expect,
    head: args.head,
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
    if (RUN_ENDING_OPERATIONS.has(args.operation) && isSpawnedByRun(cwdHash(args.cwd))) {
      throw new RoleError(
        `${args.operation} is refused for a child role; only the parent session runs it.`,
      );
    }
    switch (args.operation) {
      case "dispatch":
        return await dispatch(args, deps);
      case "finish":
        return await finish(args, deps);
      case "abort":
        return await abort(args);
      case "extend":
        return await extend(args);
      case "declare-pr":
        return await declarePr(args, deps);
      case "set-model":
        return await setModel(args);
      case "wait-checks":
        return await waitChecksOperation(args, deps);
      default:
        throw new RoleError(`Unsupported operation: ${args.operation}`);
    }
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Entry point for `agent-loop role ...`. Prints exactly one JSON envelope on
 * stdout and sets the process exit code, except `--help`, which prints plain
 * usage and exits 0. All lifecycle logging goes to stderr. A stdout write that
 * fails leaves no envelope to print, so it exits non-zero with a stderr message.
 */
export async function main(argv, { agents = defaultAgents } = {}) {
  setLogsToStderr(true);

  const controller = new AbortController();
  // One guard for every envelope of the run, so stdout holds exactly one. The normal path and the
  // second SIGINT share it: a state other than "idle" blocks a second envelope.
  const envelope = { state: "idle", done: null };
  const emitEnvelope = (payload, exitCode) => {
    if (envelope.state !== "idle") return Promise.resolve();
    envelope.state = "writing";
    // Set before the write starts: a SIGINT can arrive inside the write call.
    let settle;
    envelope.done = new Promise((resolve) => {
      settle = resolve;
    });
    return printEnvelope(payload, exitCode).finally(() => {
      envelope.state = "done";
      settle();
    });
  };
  const removeSigIntListener = cancelOnSigInt(controller, {
    onForceExit: () => {
      // A write in flight finishes first, so the exit never cuts it.
      if (envelope.state === "writing") return envelope.done;
      if (envelope.state === "done") return undefined;
      envelope.state = "done";
      writeAllSync(
        1,
        `${JSON.stringify({ status: "error", error: "Interrupted by SIGINT" })}
`,
      );
      return undefined;
    },
  });

  try {
    let args;
    try {
      args = parseRoleArgs(argv);
      setVerbose(args.verbose);
    } catch (err) {
      const { payload } = errorResult(err);
      await emitEnvelope(payload, 1);
      return;
    }

    if (args.help) {
      console.log(ROLE_USAGE);
      return;
    }

    const { exitCode, payload } = await executeRoleCommand(args, {
      agents,
      signal: controller.signal,
    });

    await emitEnvelope(payload, exitCode);
  } finally {
    removeSigIntListener();
  }
}
