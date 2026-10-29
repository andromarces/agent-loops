import { tmpRoot } from "./tmp-root.mjs";

// Each machine-wide root defaults to a path under `os.tmpdir()`, so the child needs the value that
// the parent resolves. A value that the user set is kept. An empty value counts as unset, because
// `tmpRoot` falls back to its `os.tmpdir()` default for it, so keeping it would let a `TMP` override
// in the child move the root. Each entry is an `[env, leaf]` pair, as `stateRoot`, `slotsRoot`, and
// `sessionRecordsRoot` pass to `tmpRoot`.
const ROOT_PINS = [
  ["AGENT_LOOP_RUNS_ROOT", "runs"],
  ["AGENT_LOOP_TEST_SLOTS_ROOT", "test-slots"],
  ["AGENT_LOOP_SESSION_RECORDS_ROOT", "session-records"],
];

/**
 * The environment entries that pin the runs root, the test-slot directory, and the session-record
 * directory of a child to the paths that this process resolves, so a `TMP`, `TEMP`, or `TMPDIR`
 * override inside the child cannot move them (issues #955, #970). A root that the user set to a
 * non-empty value is left out.
 */
export function rootPins() {
  const pins = {};
  for (const [name, leaf] of ROOT_PINS) {
    if (!process.env[name]) pins[name] = tmpRoot(name, leaf);
  }
  return pins;
}
