import { randomUUID } from "node:crypto";
import { exec } from "../lib/exec.mjs";

export async function runCopilot(state, prompt, options = {}) {
  const { cwd, readOnly, timeout, signal, role } = options;

  if (!state.sessionId) {
    state.sessionId = randomUUID();
  }

  const args = ["--session-id", state.sessionId, "-s", "--no-ask-user"];

  if (readOnly) {
    args.push("--deny-tool", "write");
  }

  if (state.model) {
    args.push("--model", state.model);
  }

  if (state.effort) {
    args.push("--reasoning-effort", state.effort);
  }

  const { stdout } = await exec("copilot", args, { cwd, input: prompt, timeout, signal, role });

  if (!stdout.trim()) {
    throw new Error("Copilot did not return response text.");
  }

  return stdout.trim();
}
