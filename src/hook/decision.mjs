// Decision logic and the shared command-hook flow for the #57 parent guard.
// `decideParentGuard` denies file-edit tools only when a readable run entry for
// the hook session id resolves to a state with `parentSession` equal to that
// session and a non-terminal lifecycle; every other session, every terminal
// lifecycle, and every absent or corrupt record allows the call. A session can
// own several concurrent runs, so every registered entry is checked and one
// active run denies even when another is terminal. `runParentGuard` drives that
// decision from the stdin payload for the Claude Code, Codex, Copilot, and
// Antigravity command hooks, each of which supplies its own input mapping and
// deny shape. Fail-open by design: the guard is optional defense for the
// prompt-only parent rule, so unknown records never block a tool call.
import { TERMINAL_LIFECYCLES, readStatesForSession } from "../lib/runstate.mjs";

export const GUARD_DENY_REASON =
  "agent-loop orchestrator mode: this parent session has an active run. " +
  "The parent never edits files. Delegate edits to the worker through " +
  "'agent-loop role dispatch'; run 'agent-loop role finish' or 'abort' to " +
  "release the guard.";

/**
 * Decides whether one tool call from one session is denied. Denies when any
 * readable registered state for the session is owned by it and non-terminal.
 * @param {string} sessionId session id from the hook input
 * @param {{ lookup?: typeof readStatesForSession }} deps
 * @returns {Promise<{ decision: "deny", reason: string } | { decision: "allow" }>}
 */
export async function decideParentGuard(sessionId, { lookup = readStatesForSession } = {}) {
  for (const state of await lookup(sessionId)) {
    if (state && state.parentSession === sessionId && !TERMINAL_LIFECYCLES.has(state.lifecycle)) {
      return { decision: "deny", reason: GUARD_DENY_REASON };
    }
  }
  return { decision: "allow" };
}

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

/**
 * Runs the shared command-hook flow: read the hook JSON from stdin, extract the
 * harness's session id, evaluate the guard, and print one deny payload from
 * `formatDeny`. Fails open: a missing session id, unparseable input, a tool the
 * harness does not guard, and a lookup error all exit without output, so the
 * normal permission flow stays intact.
 * @param {(reason: string) => object} formatDeny builds the harness's deny payload
 * @param {{
 *   readSessionId?: (input: unknown) => string | null,
 *   isGuarded?: (input: unknown) => boolean,
 * }} [options] maps the harness input; defaults to the Claude/Codex/Copilot
 *   `session_id` field and every tool
 */
export async function runParentGuard(
  formatDeny,
  {
    readSessionId = (input) => (typeof input?.session_id === "string" ? input.session_id : null),
    isGuarded = () => true,
  } = {},
) {
  const input = await readHookInput();
  if (!input || !isGuarded(input)) {
    return;
  }
  const sessionId = readSessionId(input);
  if (!sessionId) {
    return;
  }
  try {
    const verdict = await decideParentGuard(sessionId);
    if (verdict.decision === "deny") {
      console.log(JSON.stringify(formatDeny(verdict.reason)));
    }
  } catch {
    // A failed lookup denies nothing: the guard never blocks on its own error.
  }
}
