// Decision logic and the shared command-hook flow for the #57 parent guard.
// `decideParentGuard` denies a tool call from a session only when a readable run
// entry for the hook session id resolves to a state with `parentSession` equal to
// that session and a non-terminal lifecycle. The harness matchers and `isGuarded`
// choose which tools reach it. Every other session, every terminal lifecycle,
// and every absent or corrupt record allows the call. A session can own several
// concurrent runs, so every registered entry is checked and one active run
// denies even when another is terminal. `runParentGuard` drives that
// decision from the stdin payload for the Claude Code, Codex, Copilot, and
// Antigravity command hooks, each of which supplies its own input mapping and
// deny shape. Fail-open by design: the guard is optional defense for the
// prompt-only parent rule, so unknown records never block a tool call.
import { buffer } from "node:stream/consumers";
import { tryParseJson } from "../lib/json.mjs";
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
  return tryParseJson((await buffer(process.stdin)).toString("utf8"));
}

/**
 * The one deny payload for a hook input, or null when the call is allowed. Fails open on a missing
 * session id, a tool that the harness does not guard, and a lookup error.
 * @param {unknown} input the parsed hook payload
 * @param {(reason: string) => object} formatDeny builds the harness's deny payload
 * @param {{
 *   readSessionId?: (input: unknown) => string | null,
 *   isGuarded?: (input: unknown) => boolean,
 * }} [options] maps the harness input; defaults to the Claude/Codex/Copilot
 *   `session_id` field and every tool
 * @returns {Promise<object | null>}
 */
export async function hookDecision(
  input,
  formatDeny,
  {
    readSessionId = (value) => (typeof value?.session_id === "string" ? value.session_id : null),
    isGuarded = () => true,
  } = {},
) {
  if (!input || !isGuarded(input)) {
    return null;
  }
  const sessionId = readSessionId(input);
  if (!sessionId) {
    return null;
  }
  try {
    const verdict = await decideParentGuard(sessionId);
    return verdict.decision === "deny" ? formatDeny(verdict.reason) : null;
  } catch {
    // A failed lookup denies nothing: the guard never blocks on its own error.
    return null;
  }
}

/**
 * Runs the shared command-hook flow. It reads the hook JSON from stdin, maps the harness's session
 * id, evaluates the guard, and prints one deny payload from `formatDeny`. Fails open: a missing
 * session id, unparseable input, a tool the harness does not guard, and a lookup error print
 * nothing. The normal permission flow stays intact.
 * @param {(reason: string) => object} formatDeny builds the harness's deny payload
 * @param {object} [options] maps the harness input, as `hookDecision` accepts
 */
export async function runParentGuard(formatDeny, options = {}) {
  const input = await readHookInput();
  const payload = await hookDecision(input, formatDeny, options);
  if (payload) {
    console.log(JSON.stringify(payload));
  }
}
