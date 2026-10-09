import { runClaude } from "./claude.mjs";
import { runCodex } from "./codex.mjs";
import { runAgy } from "./agy.mjs";
import { runOpenCode } from "./opencode.mjs";
import { runCopilot } from "./copilot.mjs";
import { throwIfCanceled } from "./shared.mjs";

export function normalizeAgent(kind) {
  return kind === "antigravity" ? "agy" : kind;
}

/**
 * Adapter registry. Each adapter implements `run(state, prompt, options) -> string`:
 * it runs one turn of the CLI and returns the response text, and it mutates
 * `state.sessionId` to hold the persistent session id used for resume.
 * An adapter may set `state.usage` for the turn it just completed; the runtime
 * consumes and removes it after every call. Adapters that expose no usage leave it unset.
 */
export const defaultAgents = {
  claude: { run: runClaude },
  codex: { run: runCodex },
  agy: { run: runAgy },
  opencode: { run: runOpenCode },
  copilot: { run: runCopilot },
};

export const supportedAgents = new Set([...Object.keys(defaultAgents), "antigravity"]);

/** Runs one turn on the adapter of `state.kind`. Throws an error with `isCanceled` when `options.signal` is aborted by the time the adapter returns. */
export async function runAgent(state, prompt, options = {}, agents = defaultAgents) {
  const kind = normalizeAgent(state.kind);
  const adapter = agents[kind];

  if (!adapter || typeof adapter.run !== "function") {
    throw new Error(`Unsupported agent: ${state.kind}`);
  }

  const requestedSessionId = state.sessionId;
  const response = await adapter.run(state, prompt, options);
  // A cancel can land after the child exits and before the adapter returns. The adapter then returns
  // a result, so one check here ends that turn as canceled for every adapter. The adapter has already
  // kept the usage on `state`.
  throwIfCanceled(
    options.signal,
    kind,
    state,
    state.conversationReplaced ? requestedSessionId : undefined,
  );
  return response;
}

/**
 * Adapters whose output names the model the CLI resolved, so they set `state.resolvedModel` and
 * `--continue-from` can compare it (ADR 0026). The others report no model.
 */
export const REPORTS_RESOLVED_MODEL = new Set(["claude", "copilot", "opencode"]);
