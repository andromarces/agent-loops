import { runClaude } from "./claude.mjs";
import { runCodex } from "./codex.mjs";
import { runAgy } from "./agy.mjs";
import { runOpenCode } from "./opencode.mjs";
import { runCopilot } from "./copilot.mjs";

export function normalizeAgent(kind) {
  return kind === "antigravity" ? "agy" : kind;
}

export const defaultAgents = {
  claude: { run: runClaude },
  codex: { run: runCodex },
  agy: { run: runAgy },
  opencode: { run: runOpenCode },
  copilot: { run: runCopilot },
};

export async function runAgent(state, prompt, options = {}, agents = defaultAgents) {
  const kind = normalizeAgent(state.kind);
  const adapter = agents[kind];

  if (!adapter || typeof adapter.run !== "function") {
    throw new Error(`Unsupported agent: ${state.kind}`);
  }

  return adapter.run(state, prompt, options);
}
