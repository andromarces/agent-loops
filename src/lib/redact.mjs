// ADR 0017. Exact-value redaction of secret-named environment variables, shared by the
// command text, the output tail, and every error text that a CLI entry point prints.
// Only an environment value this long is redacted; a shorter one would match
// ordinary words and ruin the tail.
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /token|secret|passw|key|credential|auth/i;
// Marker brackets, tried in order. The first pair is the standard `[redacted:NAME]`.
const BRACKETS = [
  ["[", "]"],
  ["(", ")"],
  ["<", ">"],
  ["{", "}"],
  ["\u00ab", "\u00bb"],
];

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

const holdsSecret = (text, patterns) => patterns.some((p) => !occurrences(text, p).next().done);

/**
 * Replaces every occurrence of the value of a secret-named environment variable
 * with `[redacted:NAME]`, in its raw form and in its JSON-escaped form, because a
 * serialized error holds the escaped text and a decoder recovers the value from it.
 * All occurrences are found on the original text and merged, so overlapping, crossing,
 * and prefix-sharing values leave no fragment. A merged run gets one marker per variable
 * that it holds. A variable name that holds a secret value gets the marker `[*]`.
 * The result holds no value in either form. If the standard markers next to the text would
 * rebuild a value, the markers use the first bracket pair from `BRACKETS` that no value
 * contains, and a pair of private-use characters after that. Otherwise the output is the
 * original text with each run replaced by its marker.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found.
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
  const hits = [];
  for (const { name, text: pattern } of patterns) {
    for (const [start, end] of occurrences(text, pattern)) {
      hits.push({ start, end, name });
    }
  }
  if (hits.length === 0) {
    return text;
  }
  hits.sort((a, b) => a.start - b.start);
  const forms = patterns.map((p) => p.text);

  const render = ([open, close]) => {
    const markers = new Map();
    const markerFor = (name) => {
      if (!markers.has(name)) {
        const named = `${open}redacted:${name}${close}`;
        markers.set(name, holdsSecret(named, forms) ? `${open}*${close}` : named);
      }
      return markers.get(name);
    };
    let out = "";
    let pos = 0;
    for (let i = 0; i < hits.length;) {
      let end = hits[i].end;
      const names = new Set([hits[i].name]);
      let j = i + 1;
      for (; j < hits.length && hits[j].start < end; j++) {
        end = Math.max(end, hits[j].end);
        names.add(hits[j].name);
      }
      out += text.slice(pos, hits[i].start);
      out += [...new Set([...names].map(markerFor))].join("");
      pos = end;
      i = j;
    }
    return out + text.slice(pos);
  };

  const out = render(BRACKETS[0]);
  if (!holdsSecret(out, forms)) {
    return out;
  }
  // A bracket character that no value holds cannot join a value across a marker boundary.
  const unused = (c) => !forms.some((f) => f.includes(c));
  const pair =
    BRACKETS.find(([open, close]) => unused(open) && unused(close)) ?? privateUsePair(unused);
  return render(pair);
}

function privateUsePair(unused) {
  const free = [];
  for (let code = 0xe000; free.length < 2; code++) {
    const c = String.fromCharCode(code);
    if (unused(c)) free.push(c);
  }
  return free;
}
