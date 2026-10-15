// Validation of the init flags of `agent-loop role`: the checks that run at init, and the refusal of
// a flag that a later call changes.
import { normalizeAgent, supportedAgents } from "./agents/index.mjs";
import {
  CHILD_ROLE_KINDS,
  ROLE_FLAG_BY_OPTION,
  REVIEWER_SANDBOX_MODES,
  initRefusal,
  legacyReviewerSandbox,
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

/**
 * The reviewer sandbox mode that a state file holds, or null for a reviewer that is not Codex. A
 * state file from before ADR 0038 has no `reviewerSandbox` field: it gets `workspace-write` when it
 * holds the legacy `reviewerWorkspaceWrite: true` and `read-only` otherwise, never `none`. A field
 * that is present with any other value, `null` included, is refused for every reviewer kind, because
 * the run cannot tell which sandbox it recorded.
 * @throws {RoleError} when the field is present and is not one of the three modes
 */
export function storedReviewerSandbox(state) {
  const recorded = state.reviewerSandbox;
  if (recorded !== undefined && !REVIEWER_SANDBOX_MODES.includes(recorded)) {
    throw new RoleError(
      `State file field reviewerSandbox must be one of ${REVIEWER_SANDBOX_MODES.join(", ")}, got: ${JSON.stringify(recorded)}.`,
    );
  }
  if (state.roles?.reviewer?.kind !== "codex") return null;
  return recorded ?? legacyReviewerSandbox(state.reviewerWorkspaceWrite);
}

export function validateInitFlags(args, agents = {}) {
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
