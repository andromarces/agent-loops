// Shared CLI argument readers and agent option validation, used by both the
// headless loop (src/cli.mjs) and the role subcommand (src/role.mjs).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readableErrorText, readProp } from "./error-message.mjs";
import { normalizeAgent } from "./agent-kinds.mjs";

function missingValue(flag) {
  return new Error(`Missing value for ${flag}.`);
}

/**
 * Reads the value that follows `flag`. A value that starts with `-` is refused,
 * except a lone `-` where `allowDash` is set (stdin for `--task-file`).
 */
export function readArgValue(argv, flag, index, allowDash = false) {
  const value = argv[index];
  if (!value || (value.startsWith("-") && !(allowDash && value === "-"))) {
    throw missingValue(flag);
  }
  return value;
}

/**
 * Returns the value of an inline `--flag=value`. Throws the shared missing-value
 * error when the value is empty, so every CLI parser reports the same message.
 */
export function readInlineValue(inline, flag) {
  if (inline.value === "") {
    throw missingValue(flag);
  }
  return inline.value;
}

export const TASK_SOURCE_CONFLICT = "--task and --task-file cannot be combined.";

/**
 * Reads the task for `--task-file`: the file at `path`, or stdin through
 * `readStdin` when `path` is `-`. The text is returned verbatim, so the caller
 * applies the empty-task check.
 */
export async function readTaskFile(path, readStdin) {
  if (path === "-") {
    return readStdin();
  }
  try {
    return await readFile(resolve(path), "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read --task-file ${path}: ${readProp(err, "code") ?? readableErrorText(err)}`,
      { cause: err },
    );
  }
}

/**
 * Reads all of stdin as text. Refuses a terminal, which would wait for typed input, with
 * `ttyMessage`.
 */
export async function readStdinText(
  ttyMessage = "--task-file - reads the task from stdin, but stdin is a terminal. Pipe the task.",
) {
  if (process.stdin.isTTY) {
    throw new Error(ttyMessage);
  }
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

/**
 * Splits the inline form `--flag=value`. Returns `{ flag, value }` when `arg`
 * is that form, or null when it is not. The value is everything after the first
 * `=`, verbatim, so a leading `-` is valid. The value can be empty. The caller
 * decides whether the flag takes a value: it rejects an empty or unused inline
 * value, so a boolean flag cannot silently drop the value and an unknown flag
 * still reports the full token.
 */
export function splitInlineFlag(arg) {
  if (!arg.startsWith("--")) {
    return null;
  }
  const eq = arg.indexOf("=");
  if (eq === -1) {
    return null;
  }
  const flag = arg.slice(0, eq);
  return { flag, value: arg.slice(eq + 1) };
}

// Both readers accept a safe integer only. Above `Number.MAX_SAFE_INTEGER`, an
// integer double has no room for `value + 1`, so a step counter built from it
// stops advancing and `--max-steps` stops bounding anything (#312).
function readPositiveInt(flag, value) {
  const val = Number(value);
  if (!Number.isSafeInteger(val) || val < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return val;
}

function readNonNegativeInt(flag, value) {
  const val = Number(value);
  if (!Number.isSafeInteger(val) || val < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return val;
}

/**
 * The `--test-cmd` pair, validated once for both paths (ADR 0017). The command
 * must be non-blank, and the bound has no meaning without it.
 * @returns {string | null} the refusal, or null when the pair is valid
 */
function testCmdError(testCmd, testCmdTimeout) {
  if (testCmd !== null && testCmd.trim() === "") {
    return "--test-cmd must not be blank.";
  }
  if (testCmd === null && testCmdTimeout !== null) {
    return "--test-cmd-timeout requires --test-cmd.";
  }
  return null;
}

// The reviewer sandbox modes of a Codex reviewer (ADR 0038). `none` is the default of a new run
// and has no flag. The flag names only the two sandboxed modes.
const REVIEWER_SANDBOX_FLAG_MODES = ["read-only", "workspace-write"];
export const REVIEWER_SANDBOX_MODES = ["none", ...REVIEWER_SANDBOX_FLAG_MODES];

/**
 * The mode of a run that recorded none: a state file or a transcript from before ADR 0038. A legacy
 * run never gets `none`, so it never loses its sandbox.
 * @param {boolean | undefined} reviewerWorkspaceWrite the legacy field
 * @returns {"read-only" | "workspace-write"}
 */
function legacyReviewerSandbox(reviewerWorkspaceWrite) {
  return reviewerWorkspaceWrite === true ? "workspace-write" : "read-only";
}

/**
 * The mode a run recorded, or the legacy mode when it recorded none.
 * @param {unknown} recorded the recorded `reviewerSandbox` field
 * @param {boolean | undefined} legacyFlag the legacy `reviewerWorkspaceWrite` field
 * @returns {"none" | "read-only" | "workspace-write" | null} null when the recorded value is not a mode
 */
export function recordedReviewerSandbox(recorded, legacyFlag) {
  if (recorded === undefined) return legacyReviewerSandbox(legacyFlag);
  return REVIEWER_SANDBOX_MODES.includes(recorded) ? recorded : null;
}

/**
 * The `--reviewer-sandbox` flag, validated once for both paths (ADR 0038). Only the Codex adapter
 * reads the reviewer sandbox input, so any other reviewer would run as before while the prompt
 * said otherwise.
 * @returns {string | null} the refusal, or null when the flag is absent or valid
 */
function reviewerSandboxError(reviewerSandbox, reviewerKind) {
  if (reviewerSandbox !== null && reviewerKind !== "codex") {
    return "--reviewer-sandbox requires --reviewer codex.";
  }
  return null;
}

// The parsed option objects that used the `--reviewer-workspace-write` alias, for the conflict text.
const aliasUsers = new WeakSet();

function setReviewerSandbox(args, value, viaAlias) {
  const earlier = args.reviewerSandbox;
  if (earlier !== null && earlier !== value) {
    const alias = viaAlias || aliasUsers.has(args);
    const shown = viaAlias ? earlier : value;
    throw new Error(
      alias
        ? `--reviewer-workspace-write conflicts with --reviewer-sandbox ${shown}.`
        : `--reviewer-sandbox ${value} conflicts with --reviewer-sandbox ${earlier}.`,
    );
  }
  if (viaAlias) aliasUsers.add(args);
  args.reviewerSandbox = value;
}

// Defaults shared by the headless CLI, the role subcommand, and the loop runtime.
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_TIMEOUT = 3600;

// Loop modes, shared by the headless `--mode` and the role subcommand `--mode`
// so both paths accept the same values and refuse the same PR flags in
// review-only (#337).
const MODES = new Set(["work-first", "review-first", "review-only"]);

function modeError(value) {
  return `--mode must be one of work-first, review-first, review-only, got: ${value}`;
}

// One wording per refusal, shared by both paths, because the interactive path
// states these rules and the headless path must not drift from it (#337).
export const REVIEW_ONLY_PR_REFUSAL =
  "--pr declares PR work, which needs the --require-ci gate; review-only rejects that gate.";
export const REVIEW_ONLY_COMPARE_HEAD_REFUSAL =
  "--compare-head compares a PR head, and review-only has no PR work; review-only accepts a flagless finish.";
export const REVIEW_ONLY_GATE_REFUSAL =
  "--require-accept and --require-ci apply only to work-first and review-first; review-only accepts any verdict.";
// The review-only worker refusal, worded after the interactive `--role worker` guard it mirrors, so
// a parent reads one rule on both paths.
export const REVIEW_ONLY_WORKER_REFUSAL = "mode review-only rejects a run_worker action";

/**
 * The refusal of a declaration of a PR that the gate can never pass. `label` names the refused
 * input, for example `--pr 42`, and `reason` is the text of `unreadableGateReason`. `finish` is the
 * recovery clause that follows "omit --pr, then".
 * @param {string} label
 * @param {string} reason
 * @param {string} [finish]
 * @returns {string}
 */
export function unreadableGateRefusal(
  label,
  reason,
  finish = "finish with the unresolvedCompare marker after you compare the PR head with the reviewed commit yourself",
) {
  return `${label} is refused: ${reason}, so the --require-ci gate would refuse every finish of a declared run. Do not declare the PR: omit --pr, then ${finish}.`;
}

// The marker refusal a gated run gets, kept as a constant so the shared reason
// function cannot drift apart on the wording.
const UNRESOLVED_COMPARE_WITH_CI =
  "unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved";

/**
 * The marker refusal for the run's PR input, or null when the run declares
 * neither a gate nor a PR, where the marker stays the only record. A declared
 * PR run needs the gate the same way a gated run does, so it refuses the marker
 * too and names the gate it must reach instead of a flag it never carried
 * (#302). The two paths share this function so the wording cannot drift.
 * @param {object} options
 * @returns {string | null}
 */
export function unresolvedCompareReason({ pr = null, requireCi = null }) {
  if (requireCi !== null) {
    return UNRESOLVED_COMPARE_WITH_CI;
  }
  if (pr !== null) {
    return `unresolvedCompare cannot be combined with a run that declares PR ${pr} (--pr): the run must end through the --require-ci ${pr} gate, which resolves that PR head, so that compare is not unresolved`;
  }
  return null;
}

/**
 * The refusal of the headless `--compare-head` beside `--pr` or `--require-ci`. Both declare or gate
 * a PR, so the run must end through the gate that reads the required checks and resolves the head.
 */
export const COMPARE_HEAD_INPUT_REFUSAL =
  "--compare-head cannot be combined with --pr or --require-ci: a run that declares or gates a PR ends through the --require-ci gate, which resolves the PR head and reads the required checks, so pass one of them";

/**
 * The refusal of `--compare-head` beside a flag or marker that already settles the PR head, or null.
 * `--require-ci` resolves the head in its gate, and `unresolvedCompare` records that no one did, so
 * either one with this verified compare would record two outcomes for one head (#1098).
 * `flag` is false for the compare of a worker-opened PR that the runtime left undeclared (#1111),
 * which no flag selected, so the refusal names the compare and not the flag.
 * @param {{ requireCi: number | null, unresolvedCompare: boolean, flag?: boolean }} options
 * @returns {string | null}
 */
export function compareHeadConflict({ requireCi, unresolvedCompare, flag = true }) {
  if (requireCi !== null) {
    return "--compare-head cannot be combined with --require-ci: the gate resolves the PR head and reads the required checks, so pass one of them";
  }
  if (unresolvedCompare) {
    return `${flag ? "--compare-head" : "the head compare of the undeclared PR"} cannot be combined with unresolvedCompare: the compare either resolved the PR head or did not`;
  }
  return null;
}

/**
 * The refusal a `--pr <pr>` declaration gives when the run carries no gate for
 * that PR, whether the gate is absent or names another pull request. A gate flag
 * is a run input, so no turn in the run can supply it and the refusal ends the
 * run; the recovery names `abort` as the only outcome the orchestrator owns.
 * @param {number | null} pr the declared PR, or null when the run declares none
 * @param {number | null} requireCi the gate PR, or null when no gate was passed
 * @returns {{ reason: string, recovery: string } | null} null when the run declares no PR or gates it
 */
export function missingGateRefusal(pr, requireCi) {
  if (pr === null || requireCi === pr) {
    return null;
  }
  const state =
    requireCi === null
      ? "this run carries no --require-ci gate"
      : `this run gates PR ${requireCi} instead`;
  return {
    reason: `this run declares PR ${pr}, so a finish must end through the --require-ci ${pr} gate, and ${state}`,
    recovery: `The gate flag is a run input, so no worker or reviewer turn can supply it, and a re-finish repeats this refusal. The only outcome you own is abort with the reason naming the missing --require-ci ${pr} gate, because this run cannot end through finish. A finish that records the unresolved compare is refused with this, because the gate resolves that PR head.`,
  };
}

// Role flags: `--<role>[-model|-effort]` to option key. The headless CLI reads
// all three roles, the role subcommand reads the child roles.
export const CHILD_ROLE_KINDS = ["worker", "reviewer"];
export const ROLE_KINDS = ["orchestrator", ...CHILD_ROLE_KINDS];

export function roleFlags(roles) {
  return Object.fromEntries(
    roles.flatMap((role) => [
      [`--${role}`, role],
      [`--${role}-model`, `${role}Model`],
      [`--${role}-effort`, `${role}Effort`],
    ]),
  );
}

export const ROLE_FLAG_BY_OPTION = Object.fromEntries(
  Object.entries(roleFlags(ROLE_KINDS)).map(([flag, option]) => [option, flag]),
);

/** Role state, or null when the role was not configured at init. */
export function roleState(source, roleName) {
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
 * The OpenCode model and effort pair of one role, validated once for both paths.
 * @returns {string | null} the refusal, or null when the pair is valid or the kind is not OpenCode
 */
export function openCodeOptionsError(role, kind, model, effort) {
  if (kind && normalizeAgent(kind) !== "opencode") {
    return null;
  }

  if (effort && !model) {
    return `--${role}-effort requires --${role}-model for opencode.`;
  }

  if (effort && model?.includes("#")) {
    return `--${role}-model "${model}" already contains a variant and cannot be combined with --${role}-effort.`;
  }
  return null;
}

/**
 * The init checks that the headless command and `role` init share. Each caller throws its own
 * error type for the returned text. The checks that only one path has run in `pathRefusal`, at
 * the point where that path ran them: after the first group of shared checks and before the rest.
 * The headless order is roles, then task and flags. The `role` order is task, then flags and roles.
 * @param {object} args parsed options
 * @param {object} config
 * @param {string[]} config.roles roles whose kind, model, and effort are validated
 * @param {string[]} config.requiredRoles roles that must have a kind
 * @param {(kind: string) => boolean} config.isSupportedAgent
 * @param {string | null} config.blankTaskText refusal for a blank task, or null to skip the check
 * @param {boolean} config.rolesFirst true to run the role checks before the task check
 * @param {() => string | null} config.pathRefusal checks of one path, run between the two groups
 * @returns {string | null} the first refusal, or null when every check passes
 */
export function initRefusal(
  args,
  { roles, requiredRoles, isSupportedAgent, blankTaskText, rolesFirst, pathRefusal },
) {
  const taskCheck = () =>
    blankTaskText !== null && (args.task === null || String(args.task).trim() === "")
      ? blankTaskText
      : null;
  const flagChecks = () => {
    const testCmdRefusal = testCmdError(args.testCmd, args.testCmdTimeout);
    if (testCmdRefusal) {
      return testCmdRefusal;
    }
    const sandboxRefusal = reviewerSandboxError(
      args.reviewerSandbox,
      args.reviewer === null ? null : normalizeAgent(args.reviewer),
    );
    if (sandboxRefusal) {
      return sandboxRefusal;
    }
    // review-only dispatches no worker and rejects --require-ci at finish, so a
    // declared PR there could never be gated (#302, #337).
    if (args.pr !== null && (args.mode ?? "work-first") === "review-only") {
      return REVIEW_ONLY_PR_REFUSAL;
    }
    return null;
  };
  const roleChecks = () => {
    for (const role of requiredRoles) {
      if (args[role] === null) {
        return `Missing required --${role}.`;
      }
    }
    // Every supplied role is still validated. A model or effort without its
    // role kind is an orphan option, not a silent drop.
    for (const role of roles) {
      const kind = args[role];
      if (kind === null) {
        for (const flag of [`${role}Model`, `${role}Effort`]) {
          if (args[flag] !== null) {
            return `${ROLE_FLAG_BY_OPTION[flag]} requires --${role}.`;
          }
        }
        continue;
      }
      if (!isSupportedAgent(kind)) {
        return `Unsupported ${role}: ${kind}`;
      }
      const openCodeRefusal = openCodeOptionsError(
        role,
        kind,
        args[`${role}Model`],
        args[`${role}Effort`],
      );
      if (openCodeRefusal) {
        return openCodeRefusal;
      }
    }
    return null;
  };

  const [first, rest] = rolesFirst
    ? [[roleChecks], [taskCheck, flagChecks]]
    : [[taskCheck], [flagChecks, roleChecks]];
  for (const check of [...first, pathRefusal, ...rest]) {
    const refusal = check();
    if (refusal) {
      return refusal;
    }
  }
  return null;
}

/** Returned by an `onFlag` handler to end the walk after the flag it consumed. */
export const STOP_FLAG_WALK = Symbol("stop flag walk");

/**
 * Walks `argv[start..]` and hands each flag to `onFlag(arg, readInline, inline)`, which returns true
 * when it consumed `arg`, `STOP_FLAG_WALK` to consume it and end the walk, or false for an unknown
 * flag. `readInline(flag, allowDash)` reads the value of the flag, inline or from the next argument.
 * A flag whose handler read no value is boolean, so an inline value on it is an error rather than a
 * silently dropped argument.
 * @param {string[]} argv
 * @param {number} start index of the first flag
 * @param {(arg: string, readInline: (flag: string, allowDash?: boolean) => string, inline: object | null) => boolean | symbol} onFlag
 */
export function walkFlags(argv, start, onFlag) {
  for (let i = start; i < argv.length; i++) {
    const raw = argv[i];
    const inline = splitInlineFlag(raw);
    const arg = inline ? inline.flag : raw;
    let inlineUsed = false;
    const readInline = (flag, allowDash) => {
      if (!inline) {
        return readArgValue(argv, flag, ++i, allowDash);
      }
      inlineUsed = true;
      return readInlineValue(inline, flag);
    };

    const consumed = onFlag(arg, readInline, inline);
    if (!consumed) {
      throw new Error(`Unknown argument: ${raw}`);
    }
    if (inline && !inlineUsed) {
      throw new Error(`${arg} does not take a value.`);
    }
    if (consumed === STOP_FLAG_WALK) {
      return;
    }
  }
}

/**
 * Runs the flag loop of the headless CLI and the role subcommand over `argv[start..]`, writing into
 * `args`. The flags both commands read are handled here. `onFlag` handles the rest as in
 * `walkFlags`. `--timeout` also sets `args.timeoutProvided` when `args` carries that key.
 * @param {string[]} argv
 * @param {object} args parsed options; mutated
 * @param {object} config
 * @param {number} [config.start] index of the first flag
 * @param {Record<string, string>} config.roleFlagMap `--<role>[-model|-effort]` flag to option key
 * @param {Parameters<typeof walkFlags>[2]} config.onFlag
 */
export function parseFlags(argv, args, { start = 0, roleFlagMap, onFlag }) {
  walkFlags(argv, start, (arg, readInline, inline) => {
    if (Object.hasOwn(roleFlagMap, arg)) {
      args[roleFlagMap[arg]] = readInline(arg);
      return true;
    }
    return applyCommonFlag(args, arg, readInline) || onFlag(arg, readInline, inline);
  });
}

// The flags that both commands read into the same option keys. Returns false for any other flag.
function applyCommonFlag(args, arg, readInline) {
  switch (arg) {
    case "--cwd":
      args.cwd = resolve(readInline(arg));
      break;
    case "--task":
      args.task = readInline(arg);
      break;
    case "--task-file":
      args.taskFile = readInline(arg, true);
      break;
    case "--max-steps":
      args.maxSteps = readPositiveInt(arg, readInline(arg));
      break;
    case "--timeout": {
      const seconds = readNonNegativeInt(arg, readInline(arg));
      args.timeout = seconds === 0 ? null : seconds;
      if ("timeoutProvided" in args) {
        args.timeoutProvided = true;
      }
      break;
    }
    case "--transcript":
      args.transcript = resolve(readInline(arg));
      break;
    case "--verbose":
      args.verbose = true;
      break;
    case "--require-accept":
      args.requireAccept = true;
      break;
    case "--pr":
      args.pr = readPositiveInt(arg, readInline(arg));
      break;
    case "--require-ci":
      args.requireCi = readPositiveInt(arg, readInline(arg));
      break;
    case "--test-cmd":
      args.testCmd = readInline(arg);
      break;
    case "--test-cmd-timeout":
      args.testCmdTimeout = readPositiveInt(arg, readInline(arg));
      break;
    case "--reviewer-sandbox": {
      const value = readInline(arg);
      if (!REVIEWER_SANDBOX_FLAG_MODES.includes(value)) {
        throw new Error(
          `--reviewer-sandbox must be one of ${REVIEWER_SANDBOX_FLAG_MODES.join(", ")}, got: ${value}`,
        );
      }
      setReviewerSandbox(args, value, false);
      break;
    }
    case "--reviewer-workspace-write":
      setReviewerSandbox(args, "workspace-write", true);
      break;
    case "--compare-head":
      args.compareHead = readPositiveInt(arg, readInline(arg));
      break;
    case "--mode":
      args.mode = readInline(arg);
      if (!MODES.has(args.mode)) {
        throw new Error(modeError(args.mode));
      }
      break;
    default:
      return false;
  }
  return true;
}
