import { tmpRoot } from "./tmp-root.mjs";

// Every machine-wide root, keyed by purpose. Each entry names the environment variable that
// overrides the root and its leaf under `<os tmpdir>/agent-loops`. The table is the only place a
// root name is defined, so a root that a reader resolves is also a root that every child turn
// inherits through `rootPins`.
const ROOTS = {
  runs: { env: "AGENT_LOOP_RUNS_ROOT", leaf: "runs" },
  testSlots: { env: "AGENT_LOOP_TEST_SLOTS_ROOT", leaf: "test-slots" },
  sessionRecords: { env: "AGENT_LOOP_SESSION_RECORDS_ROOT", leaf: "session-records" },
};

/** The path of the machine-wide root `name`, resolved as `tmpRoot` resolves it. */
export function rootPath(name) {
  const { env, leaf } = ROOTS[name];
  return tmpRoot(env, leaf);
}

/**
 * The environment entries that pin the runs root, the test-slot directory, and the session-record
 * directory of a child to the paths that this process resolves, so a `TMP`, `TEMP`, or `TMPDIR`
 * override inside the child cannot move them (issues #955, #970). A root that the user set to a
 * non-empty value is left out, because an empty value counts as unset and a kept empty value would
 * let the child's `TMP` move the root.
 */
export function rootPins() {
  const pins = {};
  for (const { env, leaf } of Object.values(ROOTS)) {
    if (!process.env[env]) pins[env] = tmpRoot(env, leaf);
  }
  return pins;
}

/** The slot directory: `AGENT_LOOP_TEST_SLOTS_ROOT`, else `<os tmpdir>/agent-loops/test-slots`. */
export const slotsRoot = () => rootPath("testSlots");
