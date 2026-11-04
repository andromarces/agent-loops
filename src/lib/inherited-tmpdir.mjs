import { isAbsolute, resolve } from "node:path";
import { tryParseJson } from "./json.mjs";

/**
 * Environment variable that lists the temporary directories of the process tree, as a JSON array of
 * absolute paths, innermost first (issue #955). The list holds the directories inherited before a
 * Codex turn replaced `TMPDIR`, `TEMP`, and `TMP` with a private one. JSON cannot split a valid
 * path, which a platform list delimiter can. A package-runner layout that an earlier process
 * created under one of them still counts as a temporary layout.
 */
export const INHERITED_TMPDIR_ENV = "AGENT_LOOP_INHERITED_TMPDIR";

/** Forwarded in place of a value that the parent cannot resolve. No reader accepts it. */
const UNUSABLE_INHERITED_TMPDIRS = "unusable";

function parseList(raw) {
  const list = tryParseJson(raw);
  return Array.isArray(list) && list.every((entry) => typeof entry === "string") ? list : null;
}

/**
 * Reads the list for the installer check. An absent variable is a valid empty list. A value that
 * is present but is not a JSON array of absolute paths is not valid, so the caller fails closed.
 * That covers an empty string, malformed JSON, a non-array, a non-string entry, and a relative or
 * empty entry.
 * @returns {{ valid: boolean, paths: string[] }}
 */
export function readInheritedTmpdirs(env = process.env) {
  const raw = env[INHERITED_TMPDIR_ENV];
  if (raw === undefined) return { valid: true, paths: [] };
  const list = parseList(raw);
  if (list === null || !list.every((entry) => isAbsolute(entry))) {
    return { valid: false, paths: [] };
  }
  return { valid: true, paths: list };
}

/**
 * The value for the child of a turn: `own`, the temporary directory that the turn inherits, then
 * the entries that the parent already holds. Every entry becomes absolute against the working
 * directory of the parent, so a child with another working directory reads the same paths. A held
 * value that cannot be resolved (malformed, not an array, a non-string or empty entry) becomes
 * `UNUSABLE_INHERITED_TMPDIRS`, which keeps the installer refusal on in every descendant.
 */
export function inheritedTmpdirsForChild(own, env = process.env) {
  const raw = env[INHERITED_TMPDIR_ENV];
  let held = [];
  if (raw !== undefined) {
    const list = parseList(raw);
    if (list === null || list.some((entry) => entry === "")) return UNUSABLE_INHERITED_TMPDIRS;
    held = list.map((entry) => resolve(entry));
  }
  return JSON.stringify([resolve(own), ...held]);
}
