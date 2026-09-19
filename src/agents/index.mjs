import { runClaude } from "./claude.mjs";
import { runCodex } from "./codex.mjs";
import { runAgy } from "./agy.mjs";
import { runOpenCode } from "./opencode.mjs";
import { runCopilot } from "./copilot.mjs";

export function normalizeAgent(kind) {
  return kind === "antigravity" ? "agy" : kind;
}

/**
 * Adapter registry. Each adapter implements `run(state, prompt, options) -> string`:
 * it runs one turn of the CLI and returns the response text, and it mutates
 * `state.sessionId` to hold the persistent session id used for resume.
 */
export const defaultAgents = {
  claude: { run: runClaude },
  codex: { run: runCodex },
  agy: { run: runAgy },
  opencode: { run: runOpenCode },
  copilot: { run: runCopilot },
};

export const supportedAgents = new Set([...Object.keys(defaultAgents), "antigravity"]);

export async function runAgent(state, prompt, options = {}, agents = defaultAgents) {
  const kind = normalizeAgent(state.kind);
  const adapter = agents[kind];

  if (!adapter || typeof adapter.run !== "function") {
    throw new Error(`Unsupported agent: ${state.kind}`);
  }

  return adapter.run(state, prompt, options);
}
