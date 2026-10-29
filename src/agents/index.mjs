import { runClaude } from "./claude.mjs";
import { runCodex } from "./codex.mjs";
import { runAgy } from "./agy.mjs";
import { runOpenCode } from "./opencode.mjs";
import { runCopilot } from "./copilot.mjs";
import { throwIfCanceled } from "./shared.mjs";
import { AGENT_ALIASES, normalizeAgent } from "../lib/agent-kinds.mjs";

export { normalizeAgent };

/**
 * Adapter registry. Each adapter implements `run(state, prompt, options) -> string`:
 * it runs one turn of the CLI and returns the response text, and it mutates
 * `state.sessionId` to hold the persistent session id used for resume.
 * An adapter may set `state.usage` for the turn it just completed; the runtime
 * consumes and removes it after every call. Adapters that expose no usage leave it unset.
 *
 * Other fields an adapter sets on `state`, which the runtime reads:
 * - `conversationReplaced`: a resume ran the turn in a new conversation.
 * - `sessionUnconfirmed`: the session id is not yet confirmed by CLI output.
 * - `shellDenied`: the turn reported a refused shell call.
 * - `resolvedModel`: the model the CLI reported (see `reportsResolvedModel` in `src/lib/agent-kinds.mjs`).
 *
 * An adapter throws an error with `transient` set to a class name, such as `capacity`, when the
 * provider is expected to clear the failure, so the envelope names the class (issue #1012).
 * An adapter throws an error with `sessionMissing` set when a resumed session no longer
 * exists, so the runtime reruns the turn as a first turn. Only the Claude adapter awaits
 * `options.onSessionAssigned(id)` before its CLI starts. Other adapters ignore that option. Only the
 * Codex adapter awaits `options.onTurnTmpdir(record)` once its private temporary directory exists,
 * and calls `options.onTurnChild(pid)` once its CLI has started.
 */
export const defaultAgents = {
  claude: { run: runClaude },
  codex: { run: runCodex },
  agy: { run: runAgy },
  opencode: { run: runOpenCode },
  copilot: { run: runCopilot },
};

export const supportedAgents = new Set([...Object.keys(defaultAgents), ...AGENT_ALIASES.keys()]);

/** Runs one turn on the adapter of `state.kind`. Throws an error with `isCanceled` when `options.signal` is aborted by the time the adapter returns. */
export async function runAgent(state, prompt, options = {}, agents = defaultAgents) {
  const kind = normalizeAgent(state.kind);
  const adapter = agents[kind];

  if (!adapter || typeof adapter.run !== "function") {
    throw new Error(`Unsupported agent: ${state.kind}`);
  }

  const response = await adapter.run(state, prompt, options);
  // A cancel can land after the child exits and before the adapter returns. The adapter then returns
  // a result, so one check here ends that turn as canceled for every adapter. The adapter has already
  // kept the id, the usage, and the replaced mark on `state`.
  throwIfCanceled(options.signal, kind);
  return response;
}
