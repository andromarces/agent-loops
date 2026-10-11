// PreToolUse hook (#57). Claude Code registers it in .claude/settings.json for
// Edit|Write|MultiEdit|NotebookEdit, and Codex registers it in hooks.json for
// apply_patch. Reads the hook JSON from stdin and prints
// a deny decision on stdout only while the hook session is the parent of a
// non-terminal run. Every other outcome exits 0 with no output — unparseable
// input, a malformed session id, or an unexpected lookup error all leave the
// normal permission flow intact; the hook never leaks an error to the session.
import { runParentGuard } from "./decision.mjs";

await runParentGuard((reason) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
}));
