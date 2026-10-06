// ADR 0017. Exact-value redaction of secret-named environment variables, shared by the
// command text, the output tail, and every error text that a CLI entry point prints.
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;

/**
 * Replaces every occurrence of the value of a secret-named environment variable
 * with `[redacted:NAME]`, in its raw form and in its JSON-escaped form, because a
 * serialized error holds the escaped text and a decoder recovers the value from it.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found.
 * known-limit: crossing or self-overlapping occurrences and a secret value inside a marker name
 * are not covered (pre-existing); tracked as a separate follow-up.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  let out = text;
  // Longest value first, so a secret that is a prefix of another leaves no suffix of the longer one.
  const byLength = Object.entries(env).sort(([, a], [, b]) => String(b).length - String(a).length);
  for (const [name, value] of byLength) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      const marker = `[redacted:${name}]`;
      out = out.split(value).join(marker);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) {
        out = out.split(escaped).join(marker);
      }
    }
  }
  return out;
}
