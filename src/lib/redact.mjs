// ADR 0017. Exact-value redaction of secret-named environment variables, shared by the
// command text, the output tail, and every error text that a CLI entry point prints.
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;
// Shorter than MIN_SECRET_LENGTH, so it cannot hold a value, and it replaces a match that is longer.
const SHRINK_MARKER = "[*]";

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
 * escaped text and a decoder recovers the value from it.
 * Step 1 finds every occurrence on the original text, merges the overlapping ones, and
 * replaces each merged run with `[redacted:NAME]`, one marker for each distinct name in the
 * run. A name that holds a value is shown as `[*]`. For text in which no occurrence overlaps
 * another, no marker rebuilds a value, and no value holds a marker, the result equals the
 * result of replacing the values one after the other.
 * Step 2 scans the result again, because a marker next to text can form a value. Each match
 * is replaced by `[*]`, which is shorter than the match, until no match is left.
 * The loop ends because the text gets strictly shorter in each round.
 * The result holds no complete value in either form, and a second call on the result
 * returns it unchanged. The marker characters are printable ASCII.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found. A later change of the result, such as a cut, removal of control
 * characters, or serialization, can form a value again, so a caller redacts after it.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
export function redactEnvSecrets(text, env = process.env) {
  const patterns = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      patterns.push({ name, text: value });
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) {
        patterns.push({ name, text: escaped });
      }
    }
  }
  let runs = findRuns(text, patterns);
  if (runs.length === 0) {
    return text;
  }
  const markers = new Map();
  const markerFor = (name) => {
    if (!markers.has(name)) {
      const named = `[redacted:${name}]`;
      markers.set(name, patterns.some((p) => named.includes(p.text)) ? SHRINK_MARKER : named);
    }
    return markers.get(name);
  };
  let out = replaceRuns(text, runs, (run) => [...new Set([...run.names].map(markerFor))].join(""));
  // known-limit: a round costs one scan per value; text built to rebuild a value after every
  // round needs a round for each, at most one per 5 characters. Realistic text needs none.
  for (runs = findRuns(out, patterns); runs.length > 0; runs = findRuns(out, patterns)) {
    out = replaceRuns(out, runs, () => SHRINK_MARKER);
  }
  return out;
}
