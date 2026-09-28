// Shared CLI argument readers and agent option validation, used by both the
// headless loop (src/cli.mjs) and the role subcommand (src/role.mjs).
import { normalizeAgent } from "../agents/index.mjs";

function missingValue(flag) {
  return new Error(`Missing value for ${flag}.`);
}

export function readArgValue(argv, flag, index) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
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

// Defaults shared by the headless CLI, the role subcommand, and the loop runtime.
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_TIMEOUT = 3600;

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
