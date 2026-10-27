import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Kept apart from `test-slot.mjs` so `root-pins.mjs` can resolve it without an import cycle
// through `exec.mjs`.
/** The slot directory: `AGENT_LOOP_TEST_SLOTS_ROOT`, else `<os tmpdir>/agent-loops/test-slots`. */
export function slotsRoot() {
  const override = process.env.AGENT_LOOP_TEST_SLOTS_ROOT;
  return override ? resolve(override) : join(tmpdir(), "agent-loops", "test-slots");
}
