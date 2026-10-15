// Per-kind capabilities of the agent adapters, kept apart from `src/agents/index.mjs` so
// `src/lib` can read them without loading every adapter. A new adapter kind needs one entry here.
// - `reportsResolvedModel`: the adapter output names the model the CLI resolved, so it sets
//   `state.resolvedModel` and `--continue-from` can compare it (ADR 0026). The others report no model.
// - `networkedReadOnly`: a read-only turn keeps shell network access, so a reviewer turn on the CLI
//   can read the required checks with `gh pr checks`. A `codex` turn in a sandboxed mode
//   (`read-only` or `workspace-write`) has the network of its shell commands blocked. An unknown
//   CLI is treated like a sandboxed one, because a wait it cannot perform costs a run.
// - `waitsForChecks`: the CLI can also run `role wait-checks`. A `copilot` turn refuses that
//   command with `Permission denied because no interactive user response was available` while
//   `gh pr checks` runs (#432 probe, #495), so a `copilot` orchestrator cannot wait.
const AGENT_KINDS = {
  claude: { reportsResolvedModel: true, networkedReadOnly: true, waitsForChecks: true },
  codex: { reportsResolvedModel: false, networkedReadOnly: false, waitsForChecks: false },
  agy: { reportsResolvedModel: false, networkedReadOnly: true, waitsForChecks: true },
  opencode: { reportsResolvedModel: true, networkedReadOnly: true, waitsForChecks: true },
  copilot: { reportsResolvedModel: true, networkedReadOnly: true, waitsForChecks: false },
};

/** Maps the `antigravity` alias to its adapter kind `agy`. */
export function normalizeAgent(kind) {
  return kind === "antigravity" ? "agy" : kind;
}

/** Reports whether the exact `kind` (no alias mapping) has `capability`; false for an unknown kind. */
export function agentHas(kind, capability) {
  return Object.hasOwn(AGENT_KINDS, kind) && AGENT_KINDS[kind][capability];
}
