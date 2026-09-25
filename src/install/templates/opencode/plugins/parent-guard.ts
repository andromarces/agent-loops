// Agent-loop OpenCode parent-guard plugin (#75), installed at user scope by
// `agent-loop install`. The factory and its rationale live in
// `src/hook/opencode-plugin.mjs`; this template only wires that factory to the
// shipped decision logic and the installed orchestrator instructions.
import { createParentGuardPlugin } from "__AGENT_LOOP_PLUGIN_URL__";
import { decideParentGuard } from "__AGENT_LOOP_GUARD_URL__";

export default createParentGuardPlugin({
  decideParentGuard,
  instructionsPath: "{{AGENT_LOOP_INSTRUCTIONS}}",
});
