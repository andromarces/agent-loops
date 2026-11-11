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
// Rounds that name the variable.
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
 * Replaces every occurrence of a secret-named environment variable value, raw and JSON-escaped,
 * so a decoded error leaks nothing. Each round finds every occurrence, merges the overlapping ones,
 * and replaces each merged run in one pass, as a linear scan per value. The first two rounds use
 * `[redacted:NAME]`, and a marker that contains a value becomes `[*]`. Later rounds use `[*]`, and
 * after 5 rounds text that still holds a value becomes `[*]`, so the cost is bound for any input.
 * The result holds no complete value in either form, a second call returns it unchanged, and
 * `shrink` makes every marker `[*]`. Exact-value match only, and a later change of the result can
 * form a value again, so a caller redacts after it.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @param {{ shrink?: boolean }} [options]
 */
export function redactEnvSecrets(text, env = process.env, { shrink = false } = {}) {
  // A serialized error holds the escaped text, and a decoder recovers the value from it.
  // An escaped form that holds the raw form adds no match, because the raw match leaves the escape backslash.
  // That shape comes from a value that starts with a quote or a backslash, or ends with a backslash.
  // Guarantee: no complete value survives in the result, raw or escaped.
  // Every occurrence of an input value, or one that a round forms, is replaced in full.
  // Keyed by form text: the first variable in the environment owns a form that two variables share.
  const owners = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      const escaped = JSON.stringify(value).slice(1, -1);
      for (const form of escaped.includes(value) ? [value] : [value, escaped]) {
        if (!owners.has(form)) {
          owners.set(form, name);
        }
      }
    }
  }
  const patterns = [...owners].map(([form, name]) => ({ name, text: form }));
  const formsByLength = new Map();
  for (const form of owners.keys()) {
    formsByLength.set(form.length, (formsByLength.get(form.length) ?? new Set()).add(form));
  }
  // Only a form no longer than the marker can sit inside it.
  const holdsForm = (marker) => {
    for (const [length, forms] of formsByLength) {
      for (let i = 0; i + length <= marker.length; i++) {
        if (forms.has(marker.slice(i, i + length))) return true;
      }
    }
    return false;
  };
  const markers = new Map();
  const markerFor = (name) => {
    if (!markers.has(name)) {
      // The marker holds the name as the environment reports it.
      const named = `[redacted:${name}]`;
      markers.set(name, holdsForm(named) ? SHRINK_MARKER : named);
    }
    return markers.get(name);
  };
  // With `shrink`, every marker is `[*]`, so the result is never longer than `text`.
  // The second round runs because a marker next to text can form a value.
  // It names the variable, and `[*]` is shorter than the match it replaces.
  // Each distinct marker text of the variables in the run gets one marker.
  // Two variables with one value share one match, named for the first variable in the environment.
  const named = (run) => [...new Set([...run.names].map(markerFor))].join("");

  // For one secret-named variable, the result is byte-identical when the raw and escaped occurrences
  // do not overlap.
  // It also needs no complete value in a marker or across a marker and its text.
  // With several values, marker text or an overlap can make the result differ. The differences are
  // not a closed list, and the tests pin examples.
  // Exact-value match only: a secret that the command derives, encodes, or reads from a file is not found.
  // A later change of the result is a cut, a removal of control characters, or a serialization.
  let out = text;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const runs = findRuns(out, patterns);
    if (runs.length === 0) {
      return out;
    }
    out = replaceRuns(out, runs, round < NAMED_ROUNDS && !shrink ? named : () => SHRINK_MARKER);
  }
  // Two exceptions: the escape backslash of a raw match, and text that holds only a piece of a value.
  return findRuns(out, patterns).length === 0 ? out : SHRINK_MARKER;
}

// Control characters other than newline and tab never help a reviewer and can
// hide text in a terminal, so they are dropped.
function stripControl(text) {
  return (
    text
      .replaceAll("\r\n", "\n")
      // oxlint-disable-next-line no-control-regex -- Drops control characters other than a newline and a tab.
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
  );
}

/**
 * Redaction runs before and after the cleanup. A secret can hold a control character that the
 * first pass must match. The cleanup can also join the text around a removed character into a value.
 */
export function redactAndClean(text) {
  return redactEnvSecrets(stripControl(redactEnvSecrets(text)));
}
