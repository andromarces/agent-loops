// Decision logic for the #57 parent guard. The Claude Code PreToolUse hook
// denies file-edit tools only when the hook session id matches `parentSession`
// in the state file registered for that session; every other session, every
// terminal lifecycle, and every absent or corrupt record allows the call.
// Fail-open by design: the guard is optional defense for the prompt-only
// parent rule, so unknown records never block a tool call.
import { TERMINAL_LIFECYCLES, readStateForSession } from "../lib/runstate.mjs";

export const GUARD_DENY_REASON =
  "agent-loop orchestrator mode: this parent session has an active run. " +
  "The parent never edits files. Delegate edits to the worker through " +
  "'agent-loop role dispatch'; run 'agent-loop role finish' or 'abort' to " +
  "release the guard.";

/**
 * Decides whether one tool call from one session is denied.
 * @param {string} sessionId session id from the hook input
 * @param {{ lookup?: typeof readStateForSession }} deps
 * @returns {Promise<{ decision: "deny", reason: string } | { decision: "allow" }>}
 */
export async function decideParentGuard(sessionId, { lookup = readStateForSession } = {}) {
  const state = await lookup(sessionId);
  if (!state || state.parentSession !== sessionId || TERMINAL_LIFECYCLES.has(state.lifecycle)) {
    return { decision: "allow" };
  }
  return { decision: "deny", reason: GUARD_DENY_REASON };
}
