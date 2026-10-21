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

/**
 * The environment entries that stop npm from writing debug logs in a child turn (issue #995). npm
 * writes them to its cache, outside the work tree and the turn temporary directory, and the cleanup
 * rule of a turn cannot remove them. `npm_config_logs_max=0` writes none for the run. `callerEnv`
 * is the `env` option of the spawn. A non-empty `logs_dir` or `logs_max` in the process or the
 * caller environment, in any spelling, is a user value: it is kept and nothing is added. An empty
 * one counts as unset, as for the roots. Every empty `logs_max` spelling gets the default and every
 * empty `logs_dir` spelling is cleared with `undefined`, so no spelling reaches npm to conflict
 * with the default. A `logs_max` spelling is never cleared, because Windows treats names of any
 * case as one and the clear would remove the default as well. Apply the result after `callerEnv`.
 */
export function npmLogPins(callerEnv = {}) {
  const held = [process.env, callerEnv].flatMap((env) =>
    Object.entries(env).filter(([name]) => NPM_LOG_NAME.test(name)),
  );
  if (held.some(([, value]) => value)) return {};
  return {
    ...Object.fromEntries(held.map(([name]) => [name, /max$/i.test(name) ? "0" : undefined])),
    npm_config_logs_max: "0",
  };
}
