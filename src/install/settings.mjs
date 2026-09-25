// Settings-file merge for the installer (#139). A settings target records where
// its one entry lives with a locator:
//   - `{ kind: "array", path: ["hooks", "PreToolUse"], matcher, matcherKey }`
//     inserts one element into the array at `path` (for example a Claude or
//     Codex hook entry).
//   - `{ kind: "key", key }` sets one top-level key (the Antigravity named hook
//     group in `~/.gemini/config/hooks.json`).
// The visible entry is the only ownership key: find and remove compare the
// recorded entry by deep equality, so a package move or an upgrade that changes
// a path still finds the old record.
import { deepEqual } from "./fsutil.mjs";

export function parseSettings(text, path) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`Settings file does not parse: ${path} (${err.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Settings file is not a JSON object: ${path}`);
  }
  return value;
}

export function serializeSettings(value, originalText) {
  const newline =
    originalText === null || originalText === undefined || originalText.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(value, null, 2)}${newline}`;
}

function existingArray(settings, locator) {
  let node = settings;
  for (const key of locator.path) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      return null;
    }
    node = node[key];
  }
  return Array.isArray(node) ? node : null;
}

/** Returns the array a target writes into, creating missing objects if asked. */
export function arrayAt(settings, locator, { create = false } = {}) {
  const existing = existingArray(settings, locator);
  if (existing || !create) {
    return existing;
  }
  let node = settings;
  for (const key of locator.path) {
    if (node[key] === null || typeof node[key] !== "object") {
      node[key] = key === locator.path[locator.path.length - 1] ? [] : {};
    }
    node = node[key];
  }
  return node;
}

export function findEntryIndex(settings, locator, entry) {
  if (locator.kind === "key") {
    return Object.hasOwn(settings, locator.key) && deepEqual(settings[locator.key], entry) ? 0 : -1;
  }
  const array = existingArray(settings, locator);
  return array ? array.findIndex((candidate) => deepEqual(candidate, entry)) : -1;
}

/**
 * Inserts the entry. Returns `{ status: "inserted" | "conflict" | "duplicate" }`.
 * An array locator appends a new entry even when another entry shares its
 * matcher, because harnesses such as Claude Code allow several entries per
 * matcher and a same-matcher user entry is never replaced. A key locator owns
 * exactly one key, so a key occupied by different content is a conflict.
 */
export function insertEntry(settings, locator, entry) {
  if (locator.kind === "key") {
    if (Object.hasOwn(settings, locator.key)) {
      return deepEqual(settings[locator.key], entry)
        ? { status: "duplicate" }
        : { status: "conflict" };
    }
    settings[locator.key] = entry;
    return { status: "inserted" };
  }
  const array = arrayAt(settings, locator, { create: true });
  if (findEntryIndex(settings, locator, entry) !== -1) {
    return { status: "duplicate" };
  }
  array.push(entry);
  return { status: "inserted" };
}

/** Replaces `current` with `next` in place. Returns true when `current` was found. */
export function replaceEntry(settings, locator, current, next) {
  if (locator.kind === "key") {
    if (!Object.hasOwn(settings, locator.key) || !deepEqual(settings[locator.key], current)) {
      return false;
    }
    settings[locator.key] = next;
    return true;
  }
  const array = existingArray(settings, locator);
  const index = array ? array.findIndex((candidate) => deepEqual(candidate, current)) : -1;
  if (index === -1) {
    return false;
  }
  array[index] = next;
  return true;
}

/** Removes the recorded entry by deep equality. Returns true when it was found. */
export function removeEntry(settings, locator, entry) {
  if (locator.kind === "key") {
    if (!Object.hasOwn(settings, locator.key) || !deepEqual(settings[locator.key], entry)) {
      return false;
    }
    delete settings[locator.key];
    return true;
  }
  const array = existingArray(settings, locator);
  const index = array ? array.findIndex((candidate) => deepEqual(candidate, entry)) : -1;
  if (index === -1) {
    return false;
  }
  array.splice(index, 1);
  return true;
}

/**
 * Deletes empty containers along an array locator path, deepest key first, after
 * the entry is removed. `createdFrom` is the index of the first path key that
 * install created; a container the user already had is kept even when it is
 * empty. A container that holds anything is kept.
 */
export function pruneEmptyLocator(settings, locator, createdFrom = 0) {
  if (locator.kind === "key") {
    return;
  }
  const chain = [];
  let node = settings;
  for (const key of locator.path) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      return;
    }
    chain.push({ parent: node, key });
    node = node[key];
  }
  for (let i = chain.length - 1; i >= createdFrom; i--) {
    const { parent, key } = chain[i];
    const value = parent[key];
    const empty = Array.isArray(value)
      ? value.length === 0
      : value !== null && typeof value === "object" && Object.keys(value).length === 0;
    if (!empty) {
      return;
    }
    delete parent[key];
  }
}

/**
 * The index of the first key along an array locator path that is absent, or the
 * path length when every key exists. Install records it so uninstall prunes only
 * the containers install created.
 */
export function missingLocatorIndex(settings, locator) {
  if (locator.kind === "key") {
    return Object.hasOwn(settings, locator.key) ? 1 : 0;
  }
  let node = settings;
  for (let index = 0; index < locator.path.length; index++) {
    const key = locator.path[index];
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      return index;
    }
    node = node[key];
  }
  return locator.path.length;
}

/** The fragment a maintainer can paste by hand when the installer refuses to merge. */
export function manualSnippet(path, locator, entry) {
  const where =
    locator.kind === "key"
      ? `under the top-level key "${locator.key}"`
      : `under ${locator.path.join(".")}`;
  return [`Add to ${path} ${where}:`, JSON.stringify(entry, null, 2)].join("\n");
}
