/**
 * Environment variable that lists the temporary directories that the process tree inherited
 * before a Codex turn replaced `TMPDIR`, `TEMP`, and `TMP` with a private one, as a JSON array of
 * paths, innermost first (issue #955). JSON cannot split a valid path, which a platform list
 * delimiter can. A package-runner layout that an earlier process created under one of them still
 * counts as a temporary layout.
 */
export const INHERITED_TMPDIR_ENV = "AGENT_LOOP_INHERITED_TMPDIR";

/** The listed inherited temporary directories, or an empty list when the value is not a JSON array. */
export function inheritedTmpdirs(env = process.env) {
  try {
    const list = JSON.parse(env[INHERITED_TMPDIR_ENV] ?? "[]");
    return Array.isArray(list) ? list.filter((path) => typeof path === "string" && path) : [];
  } catch {
    return [];
  }
}
