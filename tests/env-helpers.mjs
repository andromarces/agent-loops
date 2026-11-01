/**
 * Puts AGENT_LOOP_RUNS_ROOT back to the isolated state, which is unset, so the
 * default runs root follows the per-file temp directory. The inherited pin is
 * never reinstated (issue #1022); a test that needs a root sets it explicitly.
 */
export function restoreRunsRoot() {
  delete process.env.AGENT_LOOP_RUNS_ROOT;
}

// Captured at import, before any test overrides the install home.
const originalAgentLoopHome = process.env.AGENT_LOOP_HOME;

/**
 * Puts AGENT_LOOP_HOME back to the value it had before the tests overrode it:
 * set when it existed, deleted only when it did not.
 */
export function restoreAgentLoopHome() {
  if (originalAgentLoopHome === undefined) {
    delete process.env.AGENT_LOOP_HOME;
  } else {
    process.env.AGENT_LOOP_HOME = originalAgentLoopHome;
  }
}
