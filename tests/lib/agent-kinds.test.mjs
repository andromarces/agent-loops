import { expect, test } from "vite-plus/test";
import { normalizeAgent as fromAgents } from "../../src/agents/index.mjs";
import { agentHas, normalizeAgent } from "../../src/lib/agent-kinds.mjs";

// Requirement: `antigravity` is an alias of the `agy` adapter kind; the agents entry point re-exports the same function.
test("normalizeAgent maps antigravity to agy and keeps other kinds", () => {
  expect(normalizeAgent("antigravity")).toBe("agy");
  expect(normalizeAgent("claude")).toBe("claude");
  expect(fromAgents).toBe(normalizeAgent);
});

// Requirement: each capability answers per kind with the lists from before the move; an unknown kind has none.
test("agentHas reports each capability per agent kind", () => {
  const kinds = ["claude", "codex", "agy", "opencode", "copilot"];
  const pick = (capability) => kinds.filter((kind) => agentHas(kind, capability));
  expect(pick("reportsResolvedModel")).toEqual(["claude", "opencode", "copilot"]);
  expect(pick("networkedReadOnly")).toEqual(["claude", "agy", "opencode", "copilot"]);
  expect(pick("waitsForChecks")).toEqual(["claude", "agy", "opencode"]);
});

test("agentHas is false for an unknown kind or a prototype key", () => {
  expect(agentHas("nonexistent", "waitsForChecks")).toBe(false);
  expect(agentHas("constructor", "waitsForChecks")).toBe(false);
  expect(agentHas(undefined, "waitsForChecks")).toBe(false);
});
