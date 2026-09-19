// Claude Code PreToolUse hook (#57), registered in .claude/settings.json for
// Edit|Write|MultiEdit|NotebookEdit. Reads the hook JSON from stdin and prints
// a deny decision on stdout only while the hook session is the parent of a
// non-terminal run. Every other input exits 0 with no output so the normal
// permission flow applies; unparseable input is treated as unguarded.
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
}
