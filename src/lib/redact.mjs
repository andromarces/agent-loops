// ADR 0017. Exact-value redaction of secret-named environment variables, shared by the
// command text, the output tail, and every error text that a CLI entry point prints.
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;

/** Marker text that replaces the value of the secret-named variable `name`. */
export function redactionMarker(name) {
  return `[redacted:${name}]`;
}

/**
 * Names of the environment variables whose values `redactEnvSecrets` replaces.
 * @param {NodeJS.ProcessEnv} env
 */
export function redactedEnvNames(env = process.env) {
  return Object.keys(env).filter(
    (name) =>
      SECRET_NAME.test(name) &&
      typeof env[name] === "string" &&
      env[name].length >= MIN_SECRET_LENGTH,
  );
}

/**
 * Replaces every occurrence of the value of a secret-named environment variable
 * with `[redacted:NAME]`, in its raw form and in its JSON-escaped form, because a
 * serialized error holds the escaped text and a decoder recovers the value from it.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  let out = text;
  for (const name of redactedEnvNames(env)) {
    const value = env[name];
    const marker = redactionMarker(name);
    out = out.split(value).join(marker);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) {
      out = out.split(escaped).join(marker);
    }
  }
  return out;
}
