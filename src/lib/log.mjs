// Lifecycle logging at operational boundaries (AGENTS.md logging guideline).
// Every line is tagged with its level: "[agent-loop] <level>: <message>".
// info and debug go to stdout, warn and error to stderr; debug is shown only when
// the --verbose gate is on. Warn and error lines are length-bounded so untrusted
// content (for example a model echo in a validation error) cannot flood a line.
const MAX_LENGTH = 300;

let verbose = false;

export function setVerbose(value) {
  verbose = Boolean(value);
}

function truncate(message) {
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}...` : message;
}

export function logDebug(message) {
  if (verbose) {
    console.log(`[agent-loop] debug: ${truncate(message)}`);
  }
}

export function logInfo(message) {
  console.log(`[agent-loop] info: ${truncate(message)}`);
}

export function logWarn(message) {
  console.error(`[agent-loop] warn: ${truncate(message)}`);
}

export function logError(message) {
  console.error(`[agent-loop] error: ${truncate(message)}`);
}
