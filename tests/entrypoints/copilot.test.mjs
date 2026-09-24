import { isAbsolute } from "node:path";
import { expect, test } from "vitest";
import { buildCopilotInvocation } from "../../src/entrypoints/copilot.mjs";

// Usefulness: verifies the Copilot launcher carries one session id into both
// the CLI session and the first prompt's --parent-session instruction, and
// names the shipped instructions by absolute path so the prompt resolves from
// any working directory, not only from a clone of this repository.
test("Copilot launcher seeds the interactive parent prompt with its session id", () => {
  const sessionId = "parent-session-1";
  const invocation = buildCopilotInvocation("Implement the change.", sessionId);

  expect(invocation.command).toBe("copilot");
  expect(invocation.args.slice(0, 2)).toEqual(["--session-id", sessionId]);
  expect(invocation.args[2]).toBe("--interactive");
  expect(invocation.args[3]).toContain("orchestrator-instructions.md");
  expect(invocation.args[3]).toContain(sessionId);
  expect(invocation.args[3]).toContain("Implement the change.");

  const instructionPath = invocation.args[3].match(/`([^`]*orchestrator-instructions\.md)`/)?.[1];
  expect(instructionPath).toBeDefined();
  expect(isAbsolute(instructionPath)).toBe(true);
});
