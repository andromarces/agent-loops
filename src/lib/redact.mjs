// ADR 0017. Exact-value redaction of secret-named environment variables, shared by the
// command text, the output tail, and every error text that a CLI entry point prints.
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;
// Shorter than MIN_SECRET_LENGTH, so it cannot hold a value, and it replaces a match that is longer.
const SHRINK_MARKER = "[*]";
// Scans of the text: the first on the input, then one for each marker that can form a value.
const MAX_ROUNDS = 5;
// Rounds that name the variable, as the replacement of one value after the other did.
const NAMED_ROUNDS = 2;

/** Yields `[start, end)` of every occurrence of `pattern` in `text`, overlapping ones included. Linear. */
function* occurrences(text, pattern) {
  const fail = Array.from({ length: pattern.length }, () => 0);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fail[k - 1];
    if (pattern[i] === pattern[k]) k++;
    fail[i] = k;
  }
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== pattern[k]) k = fail[k - 1];
    if (text[i] === pattern[k]) k++;
    if (k === pattern.length) {
      yield [i + 1 - k, i + 1];
      k = fail[k - 1];
    }
  }
}

/** Merged hits of every pattern in `text`, sorted by start. A merged hit lists its patterns' names. */
function findRuns(text, patterns) {
  const hits = [];
  for (const { name, text: pattern } of patterns) {
    for (const [start, end] of occurrences(text, pattern)) {
      hits.push({ start, end, name });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const runs = [];
  for (const hit of hits) {
    const last = runs.at(-1);
    if (last && hit.start < last.end) {
      last.end = Math.max(last.end, hit.end);
      last.names.add(hit.name);
    } else {
      runs.push({ start: hit.start, end: hit.end, names: new Set([hit.name]) });
    }
  }
  return runs;
}

function replaceRuns(text, runs, markerOf) {
  let out = "";
  let pos = 0;
  for (const run of runs) {
    out += text.slice(pos, run.start) + markerOf(run);
    pos = run.end;
  }
  return out + text.slice(pos);
}

/**
 * Replaces every occurrence of the value of a secret-named environment variable,
 * in its raw form and in its JSON-escaped form, because a serialized error holds the
 * escaped text and a decoder recovers the value from it. An escaped form that holds the raw
 * form, as for a value that starts with a quote or a backslash or ends with a backslash, adds
 * no match: the raw match leaves the escape backslash in place, as the replacement of one
 * value after the other did.
 *
 * Each round finds every occurrence on the current text, merges the overlapping ones, and
 * replaces each merged run in one pass. A round is a linear scan for each value. The first
 * two rounds use `[redacted:NAME]`, with one marker for each distinct marker text of the
 * variables in the run. A variable whose marker would hold a value gets `[*]`. The marker
 * holds the name as the environment reports it. The second round exists because a marker
 * next to text can form a value, and it names the variable as the earlier replacement did.
 * Later rounds use `[*]`, which is shorter than the match that it replaces.
 * After at most 5 rounds, text that still holds a value becomes `[*]`, so the cost is bound
 * for any input.
 *
 * The result holds no complete value in either form. A second call on the result returns it
 * unchanged. With `shrink`, every marker is `[*]`, so the result is never longer than `text`.
 * Compared with the replacement of one value after the other, the result is equal for text
 * in which no occurrence overlaps another and the earlier result holds no complete value. In
 * the other cases the earlier result holds a value or a piece of an overlapping occurrence.
 *
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found. A later change of the result, such as a cut, removal of control
 * characters, or serialization, can form a value again, so a caller redacts after it.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @param {{ shrink?: boolean }} [options]
 */
export function redactEnvSecrets(text, env = process.env, { shrink = false } = {}) {
  const patterns = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      patterns.push({ name, text: value });
      const escaped = JSON.stringify(value).slice(1, -1);
      if (!escaped.includes(value)) {
        patterns.push({ name, text: escaped });
      }
    }
  }
  const markers = new Map();
  const markerFor = (name) => {
    if (!markers.has(name)) {
      const named = `[redacted:${name}]`;
      markers.set(name, patterns.some((p) => named.includes(p.text)) ? SHRINK_MARKER : named);
    }
    return markers.get(name);
  };
  const named = (run) => [...new Set([...run.names].map(markerFor))].join("");

  let out = text;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const runs = findRuns(out, patterns);
    if (runs.length === 0) {
      return out;
    }
    out = replaceRuns(out, runs, round < NAMED_ROUNDS && !shrink ? named : () => SHRINK_MARKER);
  }
  return findRuns(out, patterns).length === 0 ? out : SHRINK_MARKER;
}
