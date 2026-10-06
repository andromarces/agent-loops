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
 * Occurrences are found on the original text only, overlapping ones included. Intervals
 * that overlap or touch merge into one, and each merged interval becomes one marker, so a
 * crossing, self-overlapping, or prefix-sharing secret leaves no fragment. The output is
 * never rescanned, so a marker is never redacted or split. A merged interval that covers
 * several variables takes the lexicographically smallest of their names.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  const intervals = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      for (const needle of new Set([value, JSON.stringify(value).slice(1, -1)])) {
        for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
          intervals.push({ start: at, end: at + needle.length, name });
        }
      }
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  let out = "";
  let copied = 0;
  for (let i = 0; i < intervals.length;) {
    let { end, name } = intervals[i];
    const { start } = intervals[i];
    for (i++; i < intervals.length && intervals[i].start <= end; i++) {
      end = Math.max(end, intervals[i].end);
      name = intervals[i].name < name ? intervals[i].name : name;
    }
    out += `${text.slice(copied, start)}[redacted:${name}]`;
    copied = end;
  }
  return out + text.slice(copied);
}
