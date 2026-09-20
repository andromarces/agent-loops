// Claude Code PreToolUse hook (#57), registered in .claude/settings.json for
// Edit|Write|MultiEdit|NotebookEdit. Reads the hook JSON from stdin and prints
// a deny decision on stdout only while the hook session is the parent of a
// non-terminal run. Every other outcome exits 0 with no output — unparseable
// input, a malformed session id, or an unexpected lookup error all leave the
// normal permission flow intact; the hook never leaks an error to the session.
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
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.reason,
          },
        }),
      );
    }
  } catch {
    // A failed lookup denies nothing: the guard never blocks on its own error.
  }
}
