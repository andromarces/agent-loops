// Validation of the init flags of `agent-loop role`: the checks that run at init, and the refusal of
// a flag that a later call changes.
import { normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  CHILD_ROLE_KINDS,
  REVIEW_ONLY_PR_REFUSAL,
  ROLE_FLAG_BY_OPTION,
  assertOpenCodeOptions,
  reviewerWorkspaceWriteError,
  testCmdError,
} from "./lib/args.mjs";
import { sha256 } from "./lib/hash.mjs";
import { RoleError } from "./role-error.mjs";

const INIT_FIELDS = [
  "task",
  "mode",
  "parentSession",
  "maxSteps",
  "timeout",
  "pr",
  "testCmdTimeout",
];

export function validateInitFlags(args, agents = {}) {
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
  const testCmdRefusal = testCmdError(args.testCmd, args.testCmdTimeout);
  if (testCmdRefusal) {
    throw new RoleError(testCmdRefusal);
  }
  const sandboxRefusal = reviewerWorkspaceWriteError(
    args.reviewerWorkspaceWrite,
    args.reviewer === null ? null : normalizeAgent(args.reviewer),
  );
  if (sandboxRefusal) {
    throw new RoleError(sandboxRefusal);
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
  // The opt-in is fixed at init, so a later call cannot widen the sandbox of a read-only run.
  // Omitting the flag is not a change: the stored value governs.
  if (args.reviewerWorkspaceWrite && state.reviewerWorkspaceWrite !== true) {
    throw new RoleError(
      "--reviewer-workspace-write cannot be changed after init (state holds: null).",
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
