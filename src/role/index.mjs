// `agent-loop role`: run one worker or reviewer turn, or one of eight other
// subcommands: finish, abort, extend, recheck-tmpdir, declare-pr, refresh-local, set-model, or
// wait-checks. It runs through the same guards as the headless loop, driven by a lifecycle state
// file instead of an in-process orchestrator. Stdout carries exactly one JSON
// envelope per invocation, except `--help`, which prints plain usage. All logs go
// to stderr.
import { defaultAgents } from "../agents/index.mjs";
import { CHILD_ROLE_KINDS, openCodeOptionsError } from "../lib/args.mjs";
import { REVIEW_ONLY_PR_REFUSAL } from "../lib/gate-refusal.mjs";
import { DEFAULT_WAIT_SECONDS, waitChecks } from "../lib/check-wait.mjs";
import { isSpawnedByRun } from "../lib/exec.mjs";
import { normalizeLocalPath, refreshLocalFile } from "../lib/local-files.mjs";
import { logInfo, setVerbose, setLogsToStderr } from "../lib/log.mjs";
import {
  TERMINAL_LIFECYCLES,
  cwdHash,
  readState,
  statePaths,
  writeState,
} from "../lib/runstate.mjs";
import { assertGitWorkTree } from "../lib/snapshot.mjs";
import { withStateLock } from "../lib/state-lock.mjs";
import { withTimeBound } from "../lib/time-bound.mjs";
import { cancelOnSigInt } from "../lib/sigint.mjs";
import { recheckKeptTurnTmpdir } from "../lib/turn-tmpdir.mjs";
import { presentInheritedTmpdir } from "../lib/tmpdir-entries.mjs";
import { reportedEntryNames } from "../lib/entry-report.mjs";
import {
  parseRoleArgsWithOperations,
  rejectInitFlagChanges,
  rejectMisplacedFlags,
} from "./args.mjs";
import { dispatch } from "./dispatch.mjs";
import { RoleError, printEnvelope, errorResult, writeAllSync } from "./envelope.mjs";
import { finishRun } from "./finish.mjs";
import { readStdin, refuseUnreadableGate, releaseWorkTreeLock, requireState } from "./state.mjs";

// Every operation of `agent-loop role`, in default-first usage order. `runEnding` marks an
// operation that ends, extends, or changes the PR or a model of a run. A child process of that run
// never runs one. `parentOnly` marks a read-only operation that only the parent runs.
const ROLE_OPERATIONS = [
  { name: "dispatch", runEnding: false, run: dispatch },
  { name: "finish", runEnding: true, run: finish },
  { name: "abort", runEnding: true, run: abort },
  { name: "extend", runEnding: true, run: extend },
  { name: "recheck-tmpdir", runEnding: false, parentOnly: true, run: recheckTmpdir },
  { name: "declare-pr", runEnding: true, run: declarePr },
  { name: "refresh-local", runEnding: true, run: refreshLocal },
  { name: "set-model", runEnding: true, run: setModel },
  { name: "wait-checks", runEnding: false, run: waitChecksOperation },
];

const OPERATION_SYNTAX = ROLE_OPERATIONS.map((operation) => operation.name).join("|");

const ROLE_USAGE = [
  `Usage: agent-loop role [${OPERATION_SYNTAX}] [flags]`,
  "",
  "Runs one worker or reviewer turn, or ends, extends, or refreshes a run, from a",
  "lifecycle state file. One JSON object on stdout, except this help; logs on stderr.",
  "",
  "Dispatch: agent-loop role dispatch --role worker|reviewer --prompt-file <path>",
  "Init task: --task <text> or --task-file <path|-> (- reads stdin; then pass --prompt-file).",
  "",
  "-h, --help  Show this help. Run agent-loop --help for every role flag.",
].join("\n");

/**
 * Parses `agent-loop role [<operation>] [flags]` against the operation table, so the table is the
 * one source for the accepted names and the default operation.
 */
export function parseRoleArgs(argv) {
  return parseRoleArgsWithOperations(argv, ROLE_OPERATIONS);
}

/**
 * Runs `fn(state, paths)` under the state lock for a run that is not terminal.
 * Rejects init-flag changes and a terminal lifecycle first. `requireOptions`
 * goes to `requireState`, except `releaseTerminalLock`, which releases a stale own lock on a
 * terminal run. `allowed` goes to `rejectInitFlagChanges`, and a set
 * `parentOperation` names a parent-edit operation. A missing `--parent-session` is refused
 * before the lock. One that differs from the stored id is refused on the state between
 * `requireState` and the init-flag check, so that refusal wins over both.
 */
function withOpenRun(args, requireOptions, fn, allowed = [], parentOperation = null) {
  if (parentOperation !== null) requireParentSessionFlag(args, parentOperation);
  const paths = statePaths({ cwd: args.cwd });
  return withStateLock(paths.lockFile, async () => {
    const state = requireState(await readState(paths.stateFile), args.cwd, requireOptions);
    if (parentOperation !== null) requireStoredParentSession(args, state);
    rejectInitFlagChanges(args, state, allowed);
    if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      // A crash between the terminal state write and the unlock leaves the run's own lock behind.
      // A later finish or abort releases that lock, and keeps a lock that names another owner.
      if (requireOptions.releaseTerminalLock) {
        await releaseWorkTreeLock(args.cwd);
      }
      throw new RoleError(`Run is already ${state.lifecycle}.`);
    }
    // A later call on an interrupted run re-checks the turn directory. The call that marked it
    // interrupted kept that directory while a process of the dead child group ran (issue #1329).
    if (state.lifecycle === "interrupted") {
      await recheckKeptTurnTmpdir(state.lastDispatch?.turnTmpdir);
    }
    return fn(state, paths);
  });
}

/** `finish`: ends an active run through the gate in `finishRun`. */
async function finish(args, { stdin = readStdin, gh, signal } = {}) {
  rejectMisplacedFlags(args, "finish");

  return withOpenRun(args, { needsBudget: true, releaseTerminalLock: true }, (state, paths) =>
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
    { releaseTerminalLock: true },
    async (state, paths) => {
      state.lifecycle = "aborted";
      state.reason = args.reason;
      await writeState(paths.stateFile, state);
      await releaseWorkTreeLock(args.cwd);
      logInfo(`run aborted: ${args.reason}`);
      return { exitCode: 0, payload: { status: "ok", lifecycle: "aborted" } };
    },
    ["reviewerSandbox"],
  );
}

/**
 * `recheck-tmpdir`: re-reads the inherited temporary directory and reports the names that the
 * reviewer turns of the run reported and that a later read still holds. It is a read-only status
 * read of a non-terminal run: it writes no run state, deletes nothing, and reports names only,
 * redacted and capped. It requires the stored parent session id, as `extend` does, and a child
 * role is refused. A failed or over-bound read, and a name it cannot re-check, stays listed.
 */
async function recheckTmpdir(args) {
  rejectMisplacedFlags(args, "recheck-tmpdir");
  return withOpenRun(
    args,
    {},
    async (state) => {
      const recorded = inheritedTmpdirNames(state);
      const present = await presentInheritedTmpdir(recorded);
      return {
        exitCode: 0,
        payload: {
          status: "ok",
          lifecycle: state.lifecycle,
          inheritedTmpdirEntries: reportedEntryNames(present),
        },
      };
    },
    [],
    "recheck-tmpdir",
  );
}

// A state file can hold names in three places. They are the field this change writes, the last
// result of an older run, and a turn entry from a hand-edited state. A missing or malformed value
// adds nothing.
function inheritedTmpdirNames(state) {
  const lists = [
    state.inheritedTmpdirNames,
    state.lastResult?.inheritedTmpdirEntries,
    ...(Array.isArray(state.turns) ? state.turns.map((turn) => turn?.inheritedTmpdirEntries) : []),
  ];
  return lists.flatMap((list) => (Array.isArray(list) ? list : []));
}

/**
 * `extend`: raises `maxSteps` of a non-terminal run in place. The stored role
 * session ids and first-turn tracking keep working, where a new run starts
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
    "extend",
  );
}

/**
 * `declare-pr`: sets `pr` of an active or interrupted run that declared none at init, for a run
 * whose worker opens the pull request. The change is one way, unset to a number: a run that
 * already holds a PR refuses it, so the declared PR cannot move. After it the run behaves as
 * one that passed `--pr` at init. A reviewer turn supplies the required-check status, and a finish
 * must end through `--require-ci <pr>` (#916). `review-only` refuses it, as it refuses `--pr`.
 */
async function declarePr(args, { gh, signal } = {}) {
  rejectMisplacedFlags(args, "declare-pr");
  if (args.pr === null) {
    throw new RoleError("declare-pr requires --pr <pr>.");
  }

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
    "declare-pr",
  );
}

/**
 * `refresh-local`: copies one copied local file's source over its run copy and stores the new hash.
 * The call needs the stored parent session id on a non-terminal run, and a child role cannot run it.
 * The path must be one that init copied, with a stored hash.
 * The copy must still equal that hash, so a turn edit is refused and stays reported as a breach.
 * Other paths keep their stored hashes. The envelope names the path only, never content or a hash.
 */
async function refreshLocal(args, { signal } = {}) {
  rejectMisplacedFlags(args, "refresh-local");
  if (args.localPath === null) {
    throw new RoleError("refresh-local requires --path <path>.");
  }

  return withOpenRun(
    args,
    {},
    async (state, paths) => {
      if (state.copyLocalFiles === false || !Array.isArray(state.localFilesCopied)) {
        throw new RoleError("refresh-local is refused: the run copied no local files.");
      }
      let rel;
      try {
        rel = normalizeLocalPath(args.localPath);
      } catch (err) {
        throw new RoleError(err.message.replace(/^--copy-local-path/, "refresh-local --path"));
      }
      if (!state.localFilesCopied.includes(rel)) {
        throw new RoleError(
          `refresh-local --path ${JSON.stringify(rel)} is refused: init did not copy it.`,
        );
      }
      const hashes = state.localFilesCopiedSha256;
      const expected =
        hashes !== null && typeof hashes === "object" && !Array.isArray(hashes)
          ? hashes[rel]
          : undefined;
      if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
        throw new RoleError(
          `refresh-local --path ${JSON.stringify(rel)} is refused: the run holds no stored hash for it, so it cannot prove the copy unchanged.`,
        );
      }
      let hash;
      try {
        hash = await refreshLocalFile(args.cwd, rel, { signal, expectedCopyHash: expected });
      } catch (err) {
        if (err?.isCanceled) {
          throw err;
        }
        throw new RoleError(err.message);
      }
      state.localFilesCopiedSha256 = { ...hashes, [rel]: hash };
      await writeState(paths.stateFile, state);
      logInfo(`local file refreshed: ${rel} (${state.stepsUsed} steps used)`);
      return {
        exitCode: 0,
        payload: { status: "ok", lifecycle: state.lifecycle, path: rel },
      };
    },
    [],
    "refresh-local",
  );
}

/**
 * `set-model`: replaces the model of one role that has completed no turn.
 * A model that the CLI refused on the first turn of that role is repaired on the same run.
 * `abort` and a new run start every role on a new session (#1254). The role is the one whose
 * `--<role>-model` flag the call carries, and exactly one is required. Only an `active` run takes
 * it: a `dispatched` or `interrupted` run can still have a child on the old model. A role with an
 * `ok` turn is refused, because its conversation already ran on the old model.
 */
async function setModel(args) {
  rejectMisplacedFlags(args, "set-model");
  const named = CHILD_ROLE_KINDS.filter((name) => args[`${name}Model`] !== null);
  if (named.length !== 1) {
    throw new RoleError("set-model requires exactly one of --worker-model and --reviewer-model.");
  }
  const [roleName] = named;
  const model = args[`${roleName}Model`];

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
      // The change is appended to `modelChanges`.
      state.modelChanges.push({
        role: roleName,
        from: previousModel,
        to: model,
        at: new Date().toISOString(),
      });
      // The role keeps its stored session id, which is `null` or unconfirmed after a refused first turn.
      role.model = model;
      await writeState(paths.stateFile, state);
      logInfo(`${roleName} model replaced (${state.stepsUsed} steps used)`);
      return {
        exitCode: 0,
        payload: { status: "ok", lifecycle: state.lifecycle, role: roleName, model, previousModel },
      };
    },
    ["roleModel"],
    "set-model",
  );
}

function requireParentSessionFlag(args, operation) {
  if (args.parentSession === null) {
    throw new RoleError(
      `${operation} requires --parent-session (the harness session id the run was started with).`,
    );
  }
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
 * `wait-checks`: polls the required checks of `--pr`, or every check of its head with `--all`.
 * It stops when none is pending, a conflict is read, or the bound elapses, then prints the states.
 * `--expect <name>` (repeatable, with `--all`) waits until each named check has a run on the head,
 * so a late check is not missed (#978).
 * `--head <sha>` waits until the PR head is that commit, and the result names that commit in `head` (#961).
 * It reads status only, so it touches no run state and needs no init, and it applies the same `--cwd` rule as `dispatch`.
 * The bound starts at command entry, defaults to 300 seconds, and refuses `--timeout 0` (#329).
 */
async function waitChecksOperation(
  args,
  {
    gh,
    signal,
    // The same monotonic clock that the wait uses, in whole milliseconds.
    // The bound cannot move with wall time, and every child timeout stays an integer.
    now = () => Math.floor(performance.now()),
    sleep,
    assertWorkTree = assertGitWorkTree,
    // `assertWorkTree` is the real `assertGitWorkTree` unless a caller injects it.
    // A test can spend clock time on validation and check that the time comes out of the bound.
    // Injectable so a test can use a short ceiling; production keeps the wait default (issue #1465).
    childExitCeilingMs,
  } = {},
) {
  rejectMisplacedFlags(args, "wait-checks");
  if (args.pr === null) {
    throw new RoleError("wait-checks requires --pr <pr>.");
  }
  if (args.timeoutProvided && args.timeout === null) {
    // An unbounded wait is the outcome this operation exists to prevent.
    throw new RoleError("wait-checks refuses --timeout 0: the wait must stay bounded.");
  }
  // Taken at command entry, so no step of the command pushes it past the stated bound.
  // Work-tree validation, every read, and the pauses between reads all come out of it (#329).
  // Validation and every read share the bound, and the read runs in the `--cwd` work tree.
  const deadline = now() + (args.timeout ?? DEFAULT_WAIT_SECONDS) * 1000;
  const remaining = deadline - now();
  if (remaining > 0) {
    // The validation runs inside the same bound, so a hung `git` cannot add its
    // own time to the command. It refuses on the bound, because this command
    // reads only a work tree that the probe confirmed.
    await withTimeBound(
      remaining,
      "--cwd validation did not complete within the wait bound, so the work tree was not confirmed.",
      ({ stopped }) =>
        Promise.race([assertWorkTree(args.cwd, { timeoutMs: remaining, signal }), stopped]),
    );
  }
  // The command returns within the bound plus the child-exit ceiling the wait adds on a bound it reached.
  // The check states are read from the commit by SHA.
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
    childExitCeilingMs,
    signal,
  });
  return { exitCode: 0, payload: { status: "ok", pr: args.pr, ...result } };
}

/**
 * Executes one parsed role command. Returns `{ exitCode, payload }`; the
 * payload is the JSON envelope. Unexpected failures become `status: "error"`
 * envelopes instead of stack traces on stdout.
 */
export async function executeRoleCommand(args, deps = {}) {
  try {
    const operation = ROLE_OPERATIONS.find((entry) => entry.name === args.operation);
    if (!operation) {
      throw new RoleError(`Unsupported operation: ${args.operation}`);
    }
    if ((operation.runEnding || operation.parentOnly) && isSpawnedByRun(cwdHash(args.cwd))) {
      throw new RoleError(
        `${args.operation} is refused for a child role; only the parent session runs it.`,
      );
    }
    return await operation.run(args, deps);
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
      const { payload } = errorResult({ isCanceled: true });
      writeAllSync(1, `${JSON.stringify(payload)}\n`);
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
