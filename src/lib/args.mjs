// Shared CLI argument readers and agent option validation, used by both the
// headless loop (src/cli.mjs) and the role subcommand (src/role.mjs).
import { normalizeAgent } from "../agents/index.mjs";

export function readArgValue(argv, flag, index) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function readPositiveInt(flag, value) {
  const val = Number(value);
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return val;
}

export function readNonNegativeInt(flag, value) {
  const val = Number(value);
  if (!Number.isInteger(val) || val < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return val;
}

// Role flags: `--<role>[-model|-effort]` to option key. The headless CLI reads
// all three roles, the role subcommand reads the worker and reviewer.
export const ROLE_KINDS = ["orchestrator", "worker", "reviewer"];

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
