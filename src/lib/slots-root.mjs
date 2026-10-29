import { tmpRoot } from "./tmp-root.mjs";

/** The slot directory: `AGENT_LOOP_TEST_SLOTS_ROOT`, else `<os tmpdir>/agent-loops/test-slots`. */
export const slotsRoot = () => tmpRoot("AGENT_LOOP_TEST_SLOTS_ROOT", "test-slots");
