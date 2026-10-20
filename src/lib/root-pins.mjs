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
