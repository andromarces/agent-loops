// Lifecycle logging at operational boundaries (AGENTS.md logging guideline).
// Levels: info to stdout; warn and error to stderr; debug only when the --verbose gate is on.
let verbose = false;

export function setVerbose(value) {
  verbose = Boolean(value);
}

export function logDebug(message) {
  if (verbose) {
    console.log(`[agent-loop] ${message}`);
  }
}

export function logInfo(message) {
  console.log(`[agent-loop] ${message}`);
}

export function logWarn(message) {
  console.error(`[agent-loop] ${message}`);
}

export function logError(message) {
  console.error(`[agent-loop] ${message}`);
}
