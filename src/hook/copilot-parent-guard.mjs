// GitHub Copilot CLI PreToolUse hook for the parent-edit guard. Copilot's
// PascalCase event payload uses `session_id`, and its command-hook decision is
// a flat permissionDecision object rather than Claude's hookSpecificOutput.
// Fail-open by design: malformed input and lookup failures deny nothing.
import { decideParentGuard } from "./decision.mjs";

async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const input = await readHookInput();
const sessionId = typeof input?.session_id === "string" ? input.session_id : null;
if (sessionId) {
  try {
    const verdict = await decideParentGuard(sessionId);
    if (verdict.decision === "deny") {
      console.log(
        JSON.stringify({
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        }),
      );
    }
  } catch {
    // A failed lookup denies nothing: the guard never blocks on its own error.
  }
}
