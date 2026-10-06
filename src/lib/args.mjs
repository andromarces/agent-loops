// Shared CLI argument readers and agent option validation, used by both the
// headless loop (src/cli.mjs) and the role subcommand (src/role.mjs).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readableErrorText, readProp } from "./error-message.mjs";
import { normalizeAgent } from "../agents/index.mjs";

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

/** Reads all of stdin as text. Refuses a terminal, which would wait for typed input. */
export async function readStdinText() {
  if (process.stdin.isTTY) {
    throw new Error(
      "--task-file - reads the task from stdin, but stdin is a terminal. Pipe the task.",
    );
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
export function readPositiveInt(flag, value) {
  const val = Number(value);
  if (!Number.isSafeInteger(val) || val < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return val;
}

export function readNonNegativeInt(flag, value) {
  const val = Number(value);
  if (!Number.isSafeInteger(val) || val < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return val;
}

/**
 * The step budget, as `readPositiveInt` reads it, named so `--max-steps` can
 * state its accepted range where the budget is documented. The value is a step
 * count and a loop bound, so it must stay a safe integer.
 */
export function readMaxSteps(value) {
  return readPositiveInt("--max-steps", value);
}

/**
 * The `--test-cmd` pair, validated once for both paths (ADR 0017). The command
 * must be non-blank, and the bound has no meaning without it.
 * @returns {string | null} the refusal, or null when the pair is valid
 */
export function testCmdError(testCmd, testCmdTimeout) {
  if (testCmd !== null && testCmd.trim() === "") {
    return "--test-cmd must not be blank.";
  }
  if (testCmd === null && testCmdTimeout !== null) {
    return "--test-cmd-timeout requires --test-cmd.";
  }
  return null;
}

/**
 * The `--reviewer-workspace-write` opt-in, validated once for both paths (ADR 0019). Only the
 * Codex adapter reads the reviewer sandbox input, so any other reviewer would run read-only
 * while the prompt said otherwise.
 * @returns {string | null} the refusal, or null when the opt-in is off or valid
 */
export function reviewerWorkspaceWriteError(reviewerWorkspaceWrite, reviewerKind) {
  if (reviewerWorkspaceWrite && reviewerKind !== "codex") {
    return "--reviewer-workspace-write requires --reviewer codex.";
  }
  return null;
}

// Defaults shared by the headless CLI, the role subcommand, and the loop runtime.
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_TIMEOUT = 3600;

// Loop modes, shared by the headless `--mode` and the role subcommand `--mode`
// so both paths accept the same values and refuse the same PR flags in
// review-only (#337).
export const MODES = new Set(["work-first", "review-first", "review-only"]);

export function modeError(value) {
  return `--mode must be one of work-first, review-first, review-only, got: ${value}`;
}

// One wording per refusal, shared by both paths, because the interactive path
// states these rules and the headless path must not drift from it (#337).
export const REVIEW_ONLY_PR_REFUSAL =
  "--pr declares PR work, which needs the --require-ci gate; review-only rejects that gate.";
export const REVIEW_ONLY_GATE_REFUSAL =
  "--require-accept and --require-ci apply only to work-first and review-first; review-only accepts any verdict.";

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

export function assertOpenCodeOptions(role, kind, model, effort) {
  if (kind && normalizeAgent(kind) !== "opencode") {
    return;
  }

  if (effort && !model) {
    throw new Error(`--${role}-effort requires --${role}-model for opencode.`);
  }

  if (effort && model?.includes("#")) {
    throw new Error(
      `--${role}-model "${model}" already contains a variant and cannot be combined with --${role}-effort.`,
    );
  }
}
