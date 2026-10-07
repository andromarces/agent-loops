// Harness registry (#180). The one place that names each harness and the
// command names its process can carry. The installer, process-ancestry
// detection, and `harness-check` all derive from it. Adapter kinds are a
// separate mapping in `src/agents/index.mjs`.
//
// `notes` lists the post-install notes of a harness. `path` is the segment list
// under the home directory that the note reports, `detail` is the text, and
// `dryRun` says whether the note also prints on a dry run.

export const HARNESS_ORDER = ["claude", "codex", "opencode", "copilot", "antigravity"];

export const HARNESS_META = {
  claude: {
    label: "Claude Code",
    commands: ["claude"],
    notes: [
      {
        path: [".claude", "skills"],
        dryRun: false,
        detail:
          "OpenCode also discovers ~/.claude/skills, so it lists the Claude skill " +
          "to the model. The skill sets `metadata.opencode/autoinvoke: false`, so " +
          "OpenCode drops it from the model's skill list and the OpenCode plugin " +
          "command owns /agent-loop. The skill also runs the installed CLI by absolute " +
          "path with `harness-check claude`. It starts only when the nearest harness " +
          "above the shell is Claude Code. It stops for any other harness, and when " +
          "the check cannot run or finds no harness ancestor.",
      },
    ],
  },
  codex: {
    label: "Codex CLI",
    commands: ["codex"],
    notes: [
      {
        path: [".codex", "hooks.json"],
        dryRun: true,
        detail:
          "The agent-loop parent guard stays inactive in Codex until the hook is trusted. " +
          "The hook is the PreToolUse entry in ~/.codex/hooks.json with the status message " +
          '"Checking parent orchestration guard". Its command runs parent-guard.mjs. ' +
          "Run /hooks in Codex. " +
          "Trust that entry. " +
          "A changed hook command needs a new trust step.",
      },
      {
        path: [".agents", "skills"],
        dryRun: false,
        detail:
          "The Codex skill lives in the shared ~/.agents/skills directory, which " +
          "GitHub Copilot CLI and OpenCode also discover. The skill sets " +
          "`metadata.opencode/autoinvoke: false`, so OpenCode drops it from the " +
          "model's skill list and the OpenCode plugin command owns /agent-loop. " +
          "The skill also runs the installed CLI by absolute path with " +
          "`harness-check codex`. It starts only when the nearest harness above the " +
          "shell is Codex CLI. It stops for any other harness, and when the check " +
          "cannot run or finds no harness ancestor.",
      },
    ],
  },
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
