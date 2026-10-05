// Harness registry (#180). The one place that names each harness and the
// command names its process can carry. The installer, process-ancestry
// detection, and `harness-check` all derive from it. Adapter kinds are a
// separate mapping in `src/agents/index.mjs`.

export const HARNESS_ORDER = ["claude", "codex", "opencode", "copilot", "antigravity"];

export const HARNESS_META = {
  claude: { label: "Claude Code", commands: ["claude"] },
  codex: { label: "Codex CLI", commands: ["codex"] },
  opencode: { label: "OpenCode", commands: ["opencode"] },
  copilot: { label: "GitHub Copilot CLI", commands: ["copilot"] },
  antigravity: { label: "Antigravity CLI", commands: ["agy", "antigravity"] },
};

export function isHarness(value) {
  return Object.hasOwn(HARNESS_META, value);
}

const HARNESS_BY_COMMAND = new Map(
  HARNESS_ORDER.flatMap((harness) =>
    HARNESS_META[harness].commands.map((command) => [command, harness]),
  ),
);

/** @returns {string|undefined} the harness id for a command name, or undefined */
export function harnessForCommand(command) {
  return HARNESS_BY_COMMAND.get(command);
}
