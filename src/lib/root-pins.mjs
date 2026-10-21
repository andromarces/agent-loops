import { stateRoot } from "./runstate.mjs";
import { sessionRecordsRoot } from "./session-record.mjs";
import { slotsRoot } from "./test-slot.mjs";

// Each machine-wide root defaults to a path under `os.tmpdir()`, so the child needs the value that
// the parent resolves. A value that the user set is kept. An empty value counts as unset, because
// `stateRoot`, `slotsRoot`, and `sessionRecordsRoot` fall back to their `os.tmpdir()` default for
// it, so keeping it would let a `TMP` override in the child move the root.
const ROOT_PINS = [
  ["AGENT_LOOP_RUNS_ROOT", stateRoot],
  ["AGENT_LOOP_TEST_SLOTS_ROOT", slotsRoot],
  ["AGENT_LOOP_SESSION_RECORDS_ROOT", sessionRecordsRoot],
];

/**
 * The environment entries that pin the runs root, the test-slot directory, and the session-record
 * directory of a child to the paths that this process resolves, so a `TMP`, `TEMP`, or `TMPDIR`
 * override inside the child cannot move them (issues #955, #970). A root that the user set to a
 * non-empty value is left out.
 */
export function rootPins() {
  const pins = {};
  for (const [name, resolveRoot] of ROOT_PINS) {
    if (!process.env[name]) pins[name] = resolveRoot();
  }
  return pins;
}

// npm reads these settings from an environment name of any case, with `_` or `-` before the key.
const NPM_LOG_NAME = /^npm_config_logs[_-](dir|max)$/i;
const settingOf = (name) => NPM_LOG_NAME.exec(name)?.[1].toLowerCase();

/**
 * Returns `env`, the complete child environment, with the npm log settings resolved to one spelling
 * each, so npm writes no debug log in a child turn that the cleanup rule cannot clear (issue #995).
 * npm writes them to its cache, outside the work tree and the turn temporary directory.
 * `callerEnv` is the `env` option of the spawn. For each of `logs_dir` and `logs_max`, the value
 * is the last non-empty one in the process environment and then in `callerEnv`, in any spelling,
 * so a caller wins. Every spelling is removed and the value is set once, as `npm_config_<key>`. An
 * empty value counts as unset, as for the roots, and no empty alias is left to mask a user value
 * (names that differ in case are one name on Windows). With neither setting held, `logs_max` is
 * `0`, which writes no log for the run. A held `logs_dir` keeps the default out, so the chosen
 * directory still receives its logs. The caller must spawn without `extendEnv`, because a name
 * that is missing from `env` would return from the process environment.
 */
export function withNpmLogSettings(env, callerEnv = {}) {
  const held = {};
  for (const source of [process.env, callerEnv]) {
    for (const [name, value] of Object.entries(source)) {
      const key = settingOf(name);
      if (key && value) held[key] = value;
    }
  }
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !settingOf(name)));
  if (!held.dir && !held.max) held.max = "0";
  for (const [key, value] of Object.entries(held)) out[`npm_config_logs_${key}`] = value;
  return out;
}
