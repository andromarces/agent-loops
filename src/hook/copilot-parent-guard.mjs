// GitHub Copilot CLI PreToolUse hook for the parent-edit guard. Copilot's
// PascalCase event payload uses `session_id`, and its command-hook decision is
// a flat permissionDecision object rather than Claude's hookSpecificOutput.
// Fail-open by design: malformed input and lookup failures deny nothing.
import { runParentGuard } from "./decision.mjs";

await runParentGuard((reason) => ({
  permissionDecision: "deny",
  permissionDecisionReason: reason,
}));
