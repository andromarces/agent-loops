// Lifecycle logging at operational boundaries (AGENTS.md logging guideline).
// Every line is tagged with its level: "[agent-loop] <level>: <message>".
// info and debug go to stdout, warn and error to stderr; debug is shown only when
// the --verbose gate is on. Every line is length-bounded (an error keeps its final sentence) so untrusted content
// (for example a model echo in a validation error) cannot flood a line; logInfoFull
// prints a trusted, user-facing note in full instead. Every line has secret-named environment
// values redacted first (ADR 0017), so a log line never echoes a secret that an error text held.
import { redactEnvSecrets } from "./redact.mjs";

const MAX_LENGTH = 300;
// An error keeps its final sentence, where the action for the user usually sits, up to this
// many characters. A longer final sentence keeps only its last MAX_FINAL_SENTENCE characters.
const MAX_FINAL_SENTENCE = 200;
const REDACTION_MARKER = /\[redacted:[^\]]*\]/g;
const SENTENCE_END = /[.!?]\s+/g;

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

/**
 * Moves a cut index to the nearest safe position in `step` direction (-1 back, +1 forward):
 * never between the two halves of a surrogate pair, never inside a redaction marker.
 */
function safeCut(message, index, step) {
  const low = message.charCodeAt(index);
  const high = message.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
    index += step;
  }
  for (const marker of message.matchAll(REDACTION_MARKER)) {
    const end = marker.index + marker[0].length;
    if (marker.index < index && index < end) {
      return step < 0 ? marker.index : end;
    }
  }
  return index;
}

/** Start of the last sentence, or 0 when the message holds one sentence. */
function finalSentenceStart(message) {
  const body = message.trimEnd();
  let start = 0;
  for (const end of body.matchAll(SENTENCE_END)) {
    if (end.index + end[0].length < body.length) {
      start = end.index + end[0].length;
    }
  }
  return start;
}

/**
 * Bounds a line to MAX_LENGTH characters plus the "..." elision. Redaction runs first, so a cut
 * never leaves a secret value; it also never splits a marker or a surrogate pair. With
 * `keepFinalSentence`, the cut removes the middle and keeps the final sentence (at most
 * MAX_FINAL_SENTENCE characters) after the head.
 */
function truncate(message, keepFinalSentence = false) {
  message = redactEnvSecrets(message);
  if (message.length <= MAX_LENGTH) {
    return message;
  }
  const tailLength = keepFinalSentence
    ? Math.min(message.length - finalSentenceStart(message), MAX_FINAL_SENTENCE)
    : 0;
  const head = message.slice(0, safeCut(message, MAX_LENGTH - tailLength, -1));
  const tail =
    tailLength > 0 ? message.slice(safeCut(message, message.length - tailLength, 1)) : "";
  return `${head}...${tail}`;
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
  console.error(`[agent-loop] error: ${truncate(message, true)}`);
}
