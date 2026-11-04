import { redactAndClean } from "./redact.mjs";

// Names that one report lists at most.
const MAX_ENTRIES = 20;

/**
 * Sorts `names`, keeps the first 20, redacts each like the test command output (ADR 0017), because
 * a name is chosen by the turn, and drops the duplicates that redaction creates.
 * @param {Iterable<string>} names
 * @returns {string[]}
 */
export function reportedEntryNames(names) {
  return [...new Set([...names].sort().slice(0, MAX_ENTRIES).map(redactAndClean))];
}

/**
 * Sorts `names`, keeps the first 20, and redacts each like the test command output (ADR 0017),
 * unless `keep` returns true for a name. One entry per raw name stays, so two names that redact to
 * the same text stay two entries.
 * @param {Iterable<string>} names
 * @param {(name: string) => boolean} [keep]
 * @returns {string[]}
 */
export function reportedPathNames(names, keep = () => false) {
  return [...new Set(names)]
    .sort()
    .slice(0, MAX_ENTRIES)
    .map((name) => (keep(name) ? name : redactAndClean(name)));
}

/**
 * Makes the carry pair for a list of entry names on a fatal error. `carry(err, entries)` sets
 * `err[property]`. A frozen error or a throwing setter keeps the original error, and the list stays
 * readable through `failed(err)`, which returns `undefined` when the error carries none.
 * @param {string} property
 */
export function entryCarrier(property) {
  // Lists carried by a fatal error that cannot take the property.
  const carried = new WeakMap();
  return {
    carry(err, entries) {
      carried.set(err, entries);
      try {
        err[property] = entries;
      } catch {}
    },
    failed: (err) => carried.get(err),
  };
}
