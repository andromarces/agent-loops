// The Antigravity guarded tools: every registered file-edit tool, plus the subagent
// start and message tools. `manage_subagents` stays allowed, so the parent can still
// list and terminate a child. The `hooks.json` matcher names the same set. A test
// checks the match. This module has no side effect, because the hook file runs on import.
export const ANTIGRAVITY_GUARDED_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
  "invoke_subagent",
  "send_message",
]);
