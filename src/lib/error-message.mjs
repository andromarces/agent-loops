import { redactEnvSecrets } from "./redact.mjs";

export const UNSERIALIZABLE_MESSAGE = "[unserializable message]";
export const UNREADABLE_MESSAGE = "Unreadable error";

/**
 * Error value for an envelope. A string message returns with secret-named environment values
 * redacted (ADR 0017), because a refusal can echo an argument that holds one. Any other
 * message is serialized once under the key `error`, as the envelope did before,
 * so a `toJSON` that redacts by key keeps its output and runs exactly once. The
 * returned plain JSON value serializes the same on every later call, so the
 * stdout envelope and the state file hold one value. A message that cannot
 * serialize, or whose serialization yields no value (a function, a Symbol, a
 * `toJSON` that returns `undefined`), returns a fixed placeholder, or its digits
 * for a BigInt. An error envelope therefore always carries `error`. Throws when
 * reading `err.message` throws.
 */
export function errorMessage(err) {
  const message = err?.message ?? String(err);
  if (typeof message === "string") {
    return redactEnvSecrets(message);
  }
  try {
    const serialized = JSON.parse(JSON.stringify({ error: message }));
    // A valid value, including null, is kept. Only an absent key means no value.
    return Object.hasOwn(serialized, "error")
      ? redactJsonValue(serialized.error)
      : UNSERIALIZABLE_MESSAGE;
  } catch {
    return typeof message === "bigint"
      ? redactEnvSecrets(message.toString())
      : UNSERIALIZABLE_MESSAGE;
  }
}

// A plain JSON value keeps its shape unless it holds a secret-named environment value, which
// turns it into its redacted JSON text.
function redactJsonValue(value) {
  const text = JSON.stringify(value);
  const redacted = text === undefined ? text : redactEnvSecrets(text);
  return redacted === text ? value : redacted;
}

/**
 * Text for any thrown value or message, with secret-named environment values redacted (ADR 0017).
 * A string passes through, any other value is serialized, and a value that cannot be read or
 * serialized returns a fixed placeholder, so a hostile getter or `toString` never escapes a
 * print path.
 */
export function redactedText(value) {
  try {
    if (typeof value === "string") return redactEnvSecrets(value);
    const text =
      typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    return redactEnvSecrets(text ?? UNSERIALIZABLE_MESSAGE);
  } catch {
    return UNSERIALIZABLE_MESSAGE;
  }
}

/** `errorMessage` that returns a fixed placeholder when reading the message throws. */
export function readableErrorMessage(err) {
  try {
    return errorMessage(err);
  } catch {
    return UNREADABLE_MESSAGE;
  }
}

/**
 * `readableErrorMessage` as text for a log line or a reason. A non-string message is its JSON
 * form, because a plain string conversion of a parsed object with its own `toString` key throws.
 */
export function readableErrorText(err) {
  const message = readableErrorMessage(err);
  return typeof message === "string" ? message : JSON.stringify(message);
}

/** Reads `err[key]`, and returns `undefined` when the read throws, so a hostile getter never escapes an error path. */
export function readProp(err, key) {
  try {
    return err?.[key];
  } catch {
    return undefined;
  }
}
