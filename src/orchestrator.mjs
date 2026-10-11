import { validateAction } from "./contracts/orchestrator-action.mjs";
import { logWarn } from "./lib/log.mjs";
import { extractJsonObject } from "./lib/json.mjs";
import { repairPrompt } from "./prompts/orchestrator.mjs";

export class OrchestratorError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrchestratorError";
  }
}

/**
 * Runs one read-only orchestrator turn and returns the validated action. An invalid
 * reply gets one repair turn, and a second invalid reply throws `OrchestratorError`.
 * The orchestrator never edits: every turn passes `readOnly: true` to the agent.
 * @param {{ agent: { run: Function }, state: object, prompt: string, options?: { cwd?: string, timeout?: number | null, signal?: AbortSignal } }} params
 */
export async function decide({ agent, state, prompt, options = {} }) {
  const { cwd, timeout, signal } = options;

  async function executeTurn(turnPrompt) {
    return agent.run(state, turnPrompt, {
      cwd,
      readOnly: true,
      timeout,
      signal,
    });
  }

  function parseAndValidate(rawResponse) {
    const extracted = extractJsonObject(rawResponse);
    if (!extracted.ok) {
      return { ok: false, error: extracted.error };
    }
    return validateAction(extracted.value);
  }

  // Attempt 1
  const firstResponse = await executeTurn(prompt);
  const firstValidation = parseAndValidate(firstResponse);

  if (firstValidation.ok) {
    return firstValidation.value;
  }

  // Repair turn
  logWarn(`orchestrator action invalid; taking repair turn: ${firstValidation.error}`);
  const repair = repairPrompt(firstValidation.error);
  const repairResponse = await executeTurn(repair);
  const repairValidation = parseAndValidate(repairResponse);

  if (repairValidation.ok) {
    return repairValidation.value;
  }

  throw new OrchestratorError(
    `Orchestrator returned a malformed action after one repair turn: ${repairValidation.error}`,
  );
}
