// Arguments of `agent-loop role`: parsing, the refusal of a flag that belongs to another operation,
// the checks that run at init, and the refusal of an init flag that a later call changes.
import { resolve } from "node:path";
import { normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  CHILD_ROLE_KINDS,
  ROLE_FLAG_BY_OPTION,
  REVIEWER_SANDBOX_MODES,
  TASK_SOURCE_CONFLICT,
  initRefusal,
  parseFlags,
  recordedReviewerSandbox,
  roleFlags,
} from "./lib/args.mjs";
import { isFullSha } from "./lib/git-sha.mjs";
import { sha256 } from "./lib/hash.mjs";
import { normalizeLocalPath } from "./lib/local-files.mjs";
import { RoleError } from "./role-envelope.mjs";

const INIT_FIELDS = [
  "task",
  "mode",
  "parentSession",
  "maxSteps",
  "timeout",
  "pr",
  "testCmdTimeout",
];

/**
 * The reviewer sandbox mode that a state file holds, or null for a reviewer that is not Codex. A
 * state file from before ADR 0038 has no `reviewerSandbox` field: it gets `workspace-write` when it
 * holds the legacy `reviewerWorkspaceWrite: true` and `read-only` otherwise, never `none`. A field
 * that is present with any other value, `null` included, is refused for every reviewer kind, because
 * the run cannot tell which sandbox it recorded.
 * @throws {RoleError} when the field is present and is not one of the three modes
 */
export function storedReviewerSandbox(state) {
  const mode = recordedReviewerSandbox(state.reviewerSandbox, state.reviewerWorkspaceWrite);
  if (mode === null) {
    throw new RoleError(
      `State file field reviewerSandbox must be one of ${REVIEWER_SANDBOX_MODES.join(", ")}, got: ${JSON.stringify(state.reviewerSandbox)}.`,
    );
  }
  return state.roles?.reviewer?.kind === "codex" ? mode : null;
}

/**
 * The `--copy-local-path` values of `args` as sorted, unique, root-relative paths.
 * @throws {RoleError} for a path that `normalizeLocalPath` refuses
 */
export function normalizedLocalPaths(args) {
  try {
    return [...new Set(args.copyLocalPaths.map(normalizeLocalPath))].sort();
  } catch (err) {
    throw new RoleError(err.message);
  }
}

export function validateInitFlags(args, agents = {}) {
  if (args.copyLocalPaths.length > 0) {
    normalizedLocalPaths(args);
    if (args.noCopyLocalFiles) {
      throw new RoleError("--copy-local-path cannot be combined with --no-copy-local-files.");
    }
  }
  // review-only never dispatches the worker, so --worker is optional there.
  const refusal = initRefusal(args, {
    roles: CHILD_ROLE_KINDS,
    requiredRoles: (args.mode ?? "work-first") === "review-only" ? ["reviewer"] : CHILD_ROLE_KINDS,
    isSupportedAgent: (kind) => supportedAgents.has(kind) || Boolean(agents[normalizeAgent(kind)]),
    blankTaskText: 'Init requires --task, for example --task "Implement the change."',
    rolesFirst: false,
    // The parent guard is the hard backstop for the prompt-only parent rule, so an
    // interactive run is never left unguarded by default. The headless `agent-loop`
    // command (no subcommand) is the explicit unguarded path.
    pathRefusal: () =>
      args.parentSession === null
        ? "Init requires --parent-session (the harness session id the parent-edit guard matches)."
        : null,
  });
  if (refusal) {
    throw new RoleError(refusal);
  }
}

/**
 * Later calls read configuration from the state file and reject any change.
 * `extend` passes `maxSteps` in `allowed`, because raising it is that operation's
 * purpose; every other init field stays fixed.
 */
export function rejectInitFlagChanges(args, state, allowed = []) {
  // The command is compared by digest, so the refusal never prints a stored value.
  if (args.testCmd !== null && sha256(args.testCmd) !== (state.testCmdSha256 ?? null)) {
    throw new RoleError(
      `--test-cmd cannot be changed after init (state holds: ${state.testCmdSha256 ? "a different command" : "null"}).`,
    );
  }
  // The mode is fixed at init, so a later call cannot widen or narrow the reviewer sandbox. Omitting
  // the flag is not a change: the stored value governs (ADR 0038). The stored value is read on every
  // later call, so a damaged field is refused here, before any operation acts on the state.
  // `abort` passes `reviewerSandbox` in `allowed`: it runs no reviewer turn, so a damaged field must
  // not block the only route to a terminal lifecycle. It then compares the flag only when the field
  // is valid.
  let heldSandbox;
  try {
    heldSandbox = storedReviewerSandbox(state);
  } catch (err) {
    if (!allowed.includes("reviewerSandbox")) throw err;
  }
  if (
    heldSandbox !== undefined &&
    args.reviewerSandbox !== null &&
    args.reviewerSandbox !== heldSandbox
  ) {
    throw new RoleError(
      `--reviewer-sandbox cannot be changed after init (state holds: ${heldSandbox}).`,
    );
  }
  // A task file is read only at init, so a later call never holds it as `task`.
  if (args.taskFile !== null) {
    throw new RoleError(
      `--task-file cannot be changed after init (state holds: ${JSON.stringify(state.task ?? null)}).`,
    );
  }
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
  // The paths are fixed at init, like the opt-out. A later call that names any must name the
  // stored set.
  if (args.copyLocalPaths.length > 0) {
    const held = state.copyLocalPaths ?? [];
    if (JSON.stringify(normalizedLocalPaths(args)) !== JSON.stringify(held)) {
      throw new RoleError(
        `--copy-local-path cannot be changed after init (state holds: ${JSON.stringify(held)}).`,
      );
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

const OPERATIONS = new Set(["dispatch", "finish", "abort", "extend", "declare-pr", "wait-checks"]);
const ROLE_NAMES = new Set(CHILD_ROLE_KINDS);
const ROLE_FLAGS = roleFlags(CHILD_ROLE_KINDS);

export const ROLE_USAGE = [
  "Usage: agent-loop role [dispatch|finish|abort|extend|declare-pr|wait-checks] [flags]",
  "",
  "Runs one worker or reviewer turn, or ends or extends a run, from a lifecycle",
  "state file. One JSON object on stdout, except this help; logs on stderr.",
  "",
  "Dispatch: agent-loop role dispatch --role worker|reviewer --prompt-file <path>",
  "Init task: --task <text> or --task-file <path|-> (- reads stdin; then pass --prompt-file).",
  "",
  "-h, --help  Show this help. Run agent-loop --help for every role flag.",
].join("\n");

/**
 * Parses `agent-loop role [dispatch|finish|abort|extend|declare-pr|wait-checks] [flags]`. Reuses the flag
 * reading rules of the headless CLI. The OpenCode validation runs later through
 * `validateInitFlags`. Semantics that depend on the state file (init detection, change rejection)
 * are checked at execution time, not parse time.
 */
export function parseRoleArgs(argv) {
  const args = {
    operation: "dispatch",
    cwd: process.cwd(),
    role: null,
    task: null,
    taskFile: null,
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
    copyLocalPaths: [],
    reason: null,
    requireAccept: false,
    requireCi: null,
    compareHead: null,
    pr: null,
    all: false,
    expect: [],
    head: null,
    testCmd: null,
    testCmdTimeout: null,
    reviewerSandbox: null,
    verbose: false,
    timeoutProvided: false,
    help: false,
  };

  let index = 0;
  if (argv.length > 0 && OPERATIONS.has(argv[0])) {
    args.operation = argv[0];
    index = 1;
  }

  parseFlags(argv, args, {
    start: index,
    roleFlagMap: ROLE_FLAGS,
    onFlag: (arg, readInline) => {
      switch (arg) {
        case "--role":
          args.role = readInline(arg);
          if (!ROLE_NAMES.has(args.role)) {
            throw new RoleError(`--role must be worker or reviewer, got: ${args.role}`);
          }
          return true;

        case "--parent-session":
          args.parentSession = readInline(arg);
          return true;

        case "--prompt-file":
          args.promptFile = resolve(readInline(arg));
          return true;

        case "--resume-interrupted":
          args.resumeInterrupted = true;
          return true;

        case "--all":
          args.all = true;
          return true;

        case "--expect": {
          const name = readInline(arg).trim();
          if (name === "") {
            throw new RoleError("--expect needs a non-empty check name.");
          }
          args.expect.push(name);
          return true;
        }

        case "--head":
          args.head = readInline(arg);
          if (!isFullSha(args.head)) {
            throw new RoleError(
              `--head must be a full lowercase commit SHA of 40 or 64 hex digits, got: ${args.head}`,
            );
          }
          return true;

        case "--no-copy-local-files":
          args.noCopyLocalFiles = true;
          return true;

        case "--copy-local-path":
          args.copyLocalPaths.push(readInline(arg));
          return true;

        case "--reason":
          args.reason = readInline(arg);
          return true;

        case "--help":
        case "-h":
          args.help = true;
          return true;

        default:
          return false;
      }
    },
  });

  if (args.task !== null && args.taskFile !== null) {
    throw new RoleError(TASK_SOURCE_CONFLICT);
  }

  return args;
}

/**
 * Rejects each flag that belongs to another operation: `--role` is for dispatch,
 * `--reason` for abort, `--all`, `--expect`, and `--head` for wait-checks, and
 * `--compare-head`, `--require-accept`, and `--require-ci` for finish. It also
 * refuses `--expect` without `--all` on wait-checks.
 * The checks run in a fixed order, and abort's missing `--reason` is reported
 * before a finish gate, so each refusal keeps its error text.
 */
export function rejectMisplacedFlags(args, operation) {
  if (operation !== "dispatch" && args.role !== null) {
    throw new RoleError("--role is only valid for dispatch.");
  }
  if (operation !== "abort" && args.reason !== null) {
    throw new RoleError("--reason is only valid for abort.");
  }
  if (operation === "abort" && args.reason === null) {
    throw new RoleError("abort requires --reason.");
  }
  if (operation !== "wait-checks" && args.all) {
    throw new RoleError("--all is only valid for wait-checks.");
  }
  if (operation !== "wait-checks" && args.expect.length > 0) {
    throw new RoleError("--expect is only valid for wait-checks.");
  }
  if (operation === "wait-checks" && args.expect.length > 0 && !args.all) {
    throw new RoleError(
      "--expect needs --all: the required wait already waits on each required check.",
    );
  }
  if (operation !== "wait-checks" && args.head !== null) {
    throw new RoleError("--head is only valid for wait-checks.");
  }
  if (operation !== "finish" && args.compareHead !== null) {
    throw new RoleError(`--compare-head is only valid for finish, not ${operation}.`);
  }
  if (operation !== "finish" && (args.requireAccept || args.requireCi !== null)) {
    throw new RoleError(
      `--require-accept and --require-ci are only valid for finish, not ${operation}.`,
    );
  }
}

export function requireParentSessionFlag(args, operation) {
  if (args.parentSession === null) {
    throw new RoleError(
      `${operation} requires --parent-session (the harness session id the run was started with).`,
    );
  }
}
