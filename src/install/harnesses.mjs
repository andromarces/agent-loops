// Harness registry for the installer (#139). Each harness declares the files it
// creates and the one settings entry it owns, resolved against the installed
// package, so `src/install/templates/` stays the only source of every entry
// point and guard.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

function forwardSlashes(path) {
  return path.replaceAll("\\", "/");
}

async function template(templateDir, ...segments) {
  return readFile(join(templateDir, ...segments), "utf8");
}

function claudeEntry(guardPath) {
  return {
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command: `node "${guardPath}"`, timeout: 10 }],
  };
}

function codexEntry(guardPath) {
  return {
    matcher: "^apply_patch$",
    hooks: [
      {
        type: "command",
        command: `node "${guardPath}"`,
        timeout: 10,
        statusMessage: "Checking parent orchestration guard",
      },
    ],
  };
}

/**
 * Builds the full target list for one harness.
 * @param {string} harness
 * @param {{ home: string, packageRoot: string, copilotHome?: string }} options
 * @returns {Promise<{ files: Array<{path: string, content: string}>, settings: Array<{path: string, locator: object, entry: object}> }>}
 */
export async function buildTargets(harness, { home, packageRoot, copilotHome }) {
  const templateDir = join(packageRoot, "src/install/templates");
  const instructions = join(packageRoot, "docs/orchestrator-instructions.md");
  const guardPath = join(packageRoot, "src/hook/parent-guard.mjs");
  // The absolute invocation works from Git Bash and PowerShell alike, where the
  // bare `agent-loop` command is absent or resolves only to a Windows `.cmd`
  // shim. Bash does not resolve that shim, so a PATH lookup would report a
  // missing command and the skill would misread it as a harness refusal (#151).
  const cli = `node "${forwardSlashes(join(packageRoot, "src/cli.mjs"))}"`;
  const files = [];
  const settings = [];

  const renderSkill = (text) =>
    text
      .replaceAll("{{AGENT_LOOP_INSTRUCTIONS}}", forwardSlashes(instructions))
      .replaceAll("__AGENT_LOOP_INSTRUCTIONS__", forwardSlashes(instructions))
      .replaceAll("__AGENT_LOOP_CLI__", cli);

  if (harness === "claude") {
    const skill = await template(templateDir, "claude", "skills", "agent-loop", "SKILL.md");
    files.push({
      path: join(home, ".claude", "skills", "agent-loop", "SKILL.md"),
      content: renderSkill(skill),
    });
    settings.push({
      path: join(home, ".claude", "settings.json"),
      locator: {
        kind: "array",
        path: ["hooks", "PreToolUse"],
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
      },
      entry: claudeEntry(guardPath),
    });
  } else if (harness === "codex") {
    const skill = await template(templateDir, "codex", "skills", "agent-loop", "SKILL.md");
    files.push({
      path: join(home, ".agents", "skills", "agent-loop", "SKILL.md"),
      content: renderSkill(skill),
    });
    files.push({
      path: join(home, ".agents", "skills", "agent-loop", "agents", "openai.yaml"),
      content: await template(
        templateDir,
        "codex",
        "skills",
        "agent-loop",
        "agents",
        "openai.yaml",
      ),
    });
    settings.push({
      path: join(home, ".codex", "hooks.json"),
      locator: { kind: "array", path: ["hooks", "PreToolUse"], matcher: "^apply_patch$" },
      entry: codexEntry(guardPath),
    });
  } else if (harness === "opencode") {
    const plugin = await template(templateDir, "opencode", "plugins", "parent-guard.ts");
    files.push({
      path: join(home, ".config", "opencode", "plugins", "parent-guard.ts"),
      content: plugin
        .replaceAll(
          "__AGENT_LOOP_PLUGIN_URL__",
          pathToFileURL(join(packageRoot, "src/hook/opencode-plugin.mjs")).href,
        )
        .replaceAll(
          "__AGENT_LOOP_GUARD_URL__",
          pathToFileURL(join(packageRoot, "src/hook/decision.mjs")).href,
        )
        .replaceAll("__AGENT_LOOP_INSTRUCTIONS__", forwardSlashes(instructions)),
    });
  } else if (harness === "copilot") {
    const hook = JSON.parse(await template(templateDir, "copilot", "hooks", "parent-guard.json"));
    hook.hooks.PreToolUse[0].args = [guardPath];
    files.push({
      path: join(copilotHome ?? join(home, ".copilot"), "hooks", "parent-guard.json"),
      content: `${JSON.stringify(hook, null, 2)}\n`,
    });
  } else if (harness === "antigravity") {
    const skill = await template(templateDir, "antigravity", "skills", "agent-loop", "SKILL.md");
    files.push({
      path: join(home, ".gemini", "antigravity-cli", "skills", "agent-loop", "SKILL.md"),
      content: renderSkill(skill),
    });
    const shim = await template(
      templateDir,
      "antigravity",
      "agent-loop-antigravity-parent-guard.mjs",
    );
    files.push({
      path: join(home, ".gemini", "config", "agent-loop-antigravity-parent-guard.mjs"),
      content: shim.replaceAll(
        "__AGENT_LOOP_GUARD_URL__",
        pathToFileURL(join(packageRoot, "src/hook/antigravity-parent-guard.mjs")).href,
      ),
    });
    const group = JSON.parse(await template(templateDir, "antigravity", "hooks.json"));
    settings.push({
      path: join(home, ".gemini", "config", "hooks.json"),
      locator: { kind: "key", key: "agent-loop-parent-guard" },
      entry: group["agent-loop-parent-guard"],
    });
  } else {
    throw new Error(`Unsupported harness: ${harness}`);
  }

  return { files, settings };
}
