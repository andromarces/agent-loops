// Lifecycle logging at operational boundaries (AGENTS.md logging guideline).
// Every line is tagged with its level: "[agent-loop] <level>: <message>".
// info and debug go to stdout, warn and error to stderr; debug is shown only when
// the --verbose gate is on. Every line is length-bounded so untrusted content
// (for example a model echo in a validation error) cannot flood a line; logInfoFull
// prints a trusted, user-facing note in full instead. Every line has secret-named environment
// values redacted first (ADR 0017), so a log line never echoes a secret that an error text held.
import { redactEnvSecrets } from "./redact.mjs";

const MAX_LENGTH = 300;

let verbose = false;
let stderrOnly = false;

export function setVerbose(value) {
  verbose = Boolean(value);
}

/**
 * Routes info and debug lines to stderr as well. The role subcommand must keep
 * stdout reserved for its single JSON envelope, so it turns this on for its
 * whole lifetime.
 */
export function setLogsToStderr(value) {
  stderrOnly = Boolean(value);
}

function truncate(message) {
  message = redactEnvSecrets(message);
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}...` : message;
}

export function logDebug(message) {
  if (verbose) {
    (stderrOnly ? console.error : console.log)(`[agent-loop] debug: ${truncate(message)}`);
  }
}

function writeInfo(message) {
  (stderrOnly ? console.error : console.log)(`[agent-loop] info: ${message}`);
}

export function logInfo(message) {
  writeInfo(truncate(message));
}

/**
 * Prints an info line in full, without the 300-character bound. A post-install
 * note is trusted guidance the user must read to its last sentence, so the
 * bound that keeps untrusted content from flooding an ordinary line does not
 * apply.
 */
export function logInfoFull(message) {
  writeInfo(redactEnvSecrets(message));
}

export function logWarn(message) {
  console.error(`[agent-loop] warn: ${truncate(message)}`);
}

export function logError(message) {
  console.error(`[agent-loop] error: ${truncate(message)}`);
}
