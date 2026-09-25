// Agent-loop OpenCode parent-guard plugin (#75), installed at user scope by
// `agent-loop install`. OpenCode ships no session placeholder for Markdown
// command templates, so the plugin channel supplies the session id: a plugin
// command reads `CommandInvocation.sessionID` and passes it to the parent, and a
// permission hook reads `PermissionEvaluation.sessionID` and denies file edits
// from the registered parent while its run is non-terminal. Both paths reuse the
// shared decision logic in the installed package, so the OpenCode guard matches
// `decideParentGuard` exactly. Fail-open by design: every other session, every
// terminal lifecycle, and every absent or corrupt record allows the call.
//
// The shared Claude and Codex skills set `metadata.opencode/autoinvoke: false`
// and `slash: false`, so OpenCode hides them from its model list and its
// interactive command catalog, and this command is the only `/agent-loop` entry
// point that carries the OpenCode session id (#150).
//
// The guard resolves the runs root from this server process's environment, so
// an out-of-process `AGENT_LOOP_RUNS_ROOT` override (test-only) would desync
// it from the `agent-loop` CLI that wrote the index.
import { createParentGuardPlugin } from "__AGENT_LOOP_PLUGIN_URL__";
import { decideParentGuard } from "__AGENT_LOOP_GUARD_URL__";

export default createParentGuardPlugin({
  decideParentGuard,
  instructionsPath: "__AGENT_LOOP_INSTRUCTIONS__",
});
