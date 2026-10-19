import { delimiter } from "node:path";

/**
 * Environment variable that lists the temporary directories that the process tree inherited
 * before a Codex turn replaced `TMPDIR`, `TEMP`, and `TMP` with a private one, joined with the
 * platform path delimiter, innermost first (issue #955). A package-runner layout that an earlier
 * process created under one of them still counts as a temporary layout.
 */
export const INHERITED_TMPDIR_ENV = "AGENT_LOOP_INHERITED_TMPDIR";

/** The listed inherited temporary directories, or an empty list. */
export function inheritedTmpdirs(env = process.env) {
  return (env[INHERITED_TMPDIR_ENV] ?? "").split(delimiter).filter(Boolean);
}
