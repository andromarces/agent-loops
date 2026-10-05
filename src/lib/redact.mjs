// ADR 0017. Exact-value redaction of secret-named environment variables, shared by the
// command text, the output tail, and every error text that a CLI entry point prints.
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;

/**
 * Replaces every occurrence of the value of a secret-named environment variable
 * with `[redacted:NAME]`. Exact-value match only: a secret that the command
 * derives, encodes, or reads from a file is not found.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      out = out.split(value).join(`[redacted:${name}]`);
    }
  }
  return out;
}
