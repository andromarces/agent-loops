import { canceledError } from "./agents/shared.mjs";
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

export async function decide({ agent, state, prompt, options = {} }) {
  const { cwd, timeout, signal } = options;

  async function executeTurn(turnPrompt) {
    const response = await agent.run(state, turnPrompt, {
      cwd,
      readOnly: true,
      timeout,
      signal,
    });
    // A cancel that lands after the adapter returned, in the post-turn snapshot, must not let the
    // action in `response` run or finish the run (#587).
    if (signal?.aborted) {
      throw canceledError("orchestrator");
    }
    return response;
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
