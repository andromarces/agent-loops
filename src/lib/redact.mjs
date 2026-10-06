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
 * One pass with the longest value first, so a secret that is a prefix of another secret
 * never leaves the suffix of the longer one, and a marker is never rescanned.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  const markers = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      const marker = `[redacted:${name}]`;
      for (const needle of [value, JSON.stringify(value).slice(1, -1)]) {
        if (!markers.has(needle)) {
          markers.set(needle, marker);
        }
      }
    }
  }
  if (markers.size === 0) {
    return text;
  }
  const needles = [...markers.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    needles.map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  return text.replace(pattern, (match) => markers.get(match));
}
