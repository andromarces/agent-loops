// Install targets per harness (#139). `buildTargets` declares the files each harness
// creates and the one settings entry it owns, resolved against the installed
// package. `src/install/templates/` holds the entry point and guard files. The
// Antigravity entry comes from `templates/antigravity/hooks.json`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ANTIGRAVITY_GUARDED_TOOLS } from "../hook/antigravity-guarded-tools.mjs";
import { HARNESS_META } from "../lib/harnesses.mjs";

function forwardSlashes(path) {
  return path.replaceAll("\\", "/");
}

async function template(templateDir, ...segments) {
  return readFile(join(templateDir, ...segments), "utf8");
}

// The session variable that the shared harness-check paragraph tells a skill not to trust, and why.
const SESSION_CHANNEL = {
  claude: {
    variable: "${CLAUDE_SESSION_ID}",
    reason: "a foreign harness leaves the literal in place and a nested harness inherits the value",
  },
  codex: {
    variable: "CODEX_THREAD_ID",
    reason: "a nested harness inherits it",
    // Codex renders the paragraph as two; Antigravity keeps one.
    paragraphBreak: "\n\n",
  },
  antigravity: {
    variable: "ANTIGRAVITY_CONVERSATION_ID",
    reason: "a nested harness inherits it",
    paragraphBreak: "\n",
  },
};

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
 * @returns {Promise<{ files: Array<{path: string, content: string}>, settings: Array<{path: string, locator: object, entry: object}>, notes: Array<{path: string, dryRun: boolean, detail: string}> }>}
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
  const notes = [];

  const renderPaths = (text) =>
    text
      .replaceAll("{{AGENT_LOOP_INSTRUCTIONS}}", forwardSlashes(instructions))
      .replaceAll("__AGENT_LOOP_CLI__", cli);

  // Renders the skill template of the current harness into `<skillsDir>/agent-loop/SKILL.md`.
  // The shared harness-check and session-channel paragraphs fill `{{HARNESS_CHECK}}` and
  // `{{SESSION_CHANNEL}}` before the path placeholders resolve. Only a skill harness reads them.
  const addSkill = async (skillsDir) => {
    const { variable, reason, paragraphBreak } = SESSION_CHANNEL[harness];
    const renderParagraph = (text) =>
      text
        .replaceAll("{{HARNESS_ID}}", harness)
        .replaceAll("{{HARNESS_LABEL}}", HARNESS_META[harness].label)
        .replaceAll("{{SESSION_VAR}}", variable)
        .replaceAll("{{SESSION_VAR_REASON}}", reason)
        .replaceAll("{{SESSION_BREAK}}", paragraphBreak)
        .trimEnd();
    const skill = await template(templateDir, harness, "skills", "agent-loop", "SKILL.md");
    const harnessCheck = renderParagraph(await template(templateDir, "harness-check.md"));
    const sessionChannel = skill.includes("{{SESSION_CHANNEL}}")
      ? renderParagraph(await template(templateDir, "session-channel.md"))
      : "";
    files.push({
      path: join(skillsDir, "agent-loop", "SKILL.md"),
      content: renderPaths(
        skill
          .replaceAll("{{HARNESS_CHECK}}", harnessCheck)
          .replaceAll("{{SESSION_CHANNEL}}", sessionChannel),
      ),
    });
  };

  // Builds the skill note; Claude and Codex differ only in the discovery sentences and harness.
  const skillNote = (discovery, command, label) =>
    `${discovery} The skill sets \`metadata.opencode/autoinvoke: false\`, so OpenCode drops it ` +
    "from the model's skill list and the OpenCode plugin command owns /agent-loop. The skill " +
    `also runs the installed CLI by absolute path with \`harness-check ${command}\`. It starts ` +
    `only when the nearest harness above the shell is ${label}. It stops for any other ` +
    "harness, and when the check cannot run or finds no harness ancestor.";

  if (harness === "claude") {
    const skillsDir = join(home, ".claude", "skills");
    await addSkill(skillsDir);
    const entry = claudeEntry(guardPath);
    settings.push({
      path: join(home, ".claude", "settings.json"),
      locator: {
        kind: "array",
        path: ["hooks", "PreToolUse"],
      },
      entry,
    });
    notes.push({
      path: skillsDir,
      dryRun: false,
      detail: skillNote(
        "OpenCode also discovers ~/.claude/skills, so it lists the Claude skill to the model.",
        "claude",
        "Claude Code",
      ),
    });
  } else if (harness === "codex") {
    const skillsDir = join(home, ".agents", "skills");
    const hooksFile = join(home, ".codex", "hooks.json");
    await addSkill(skillsDir);
    files.push({
      path: join(skillsDir, "agent-loop", "agents", "openai.yaml"),
      content: await template(
        templateDir,
        "codex",
        "skills",
        "agent-loop",
        "agents",
        "openai.yaml",
      ),
    });
    const entry = codexEntry(guardPath);
    settings.push({
      path: hooksFile,
      locator: {
        kind: "array",
        path: ["hooks", "PreToolUse"],
      },
      entry,
    });
    notes.push(
      {
        path: hooksFile,
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
        path: skillsDir,
        dryRun: false,
        detail: skillNote(
          "The Codex skill lives in the shared ~/.agents/skills directory, which GitHub Copilot CLI and OpenCode also discover.",
          "codex",
          "Codex CLI",
        ),
      },
    );
  } else if (harness === "opencode") {
    const plugin = await template(templateDir, "opencode", "plugins", "parent-guard.ts");
    files.push({
      path: join(home, ".config", "opencode", "plugins", "parent-guard.ts"),
      content: renderPaths(plugin)
        .replaceAll(
          "__AGENT_LOOP_PLUGIN_URL__",
          pathToFileURL(join(packageRoot, "src/hook/opencode-plugin.mjs")).href,
        )
        .replaceAll(
          "__AGENT_LOOP_GUARD_URL__",
          pathToFileURL(join(packageRoot, "src/hook/decision.mjs")).href,
        ),
    });
  } else if (harness === "copilot") {
    const hook = JSON.parse(await template(templateDir, "copilot", "hooks", "parent-guard.json"));
    // Copilot consumes a flat permissionDecision object, so it runs its own
    // guard script rather than the Claude/Codex hookSpecificOutput shape (#155).
    hook.hooks.PreToolUse[0].args = [join(packageRoot, "src/hook/copilot-parent-guard.mjs")];
    files.push({
      path: join(copilotHome ?? join(home, ".copilot"), "hooks", "parent-guard.json"),
      content: `${JSON.stringify(hook, null, 2)}\n`,
    });
  } else if (harness === "antigravity") {
    await addSkill(join(home, ".gemini", "antigravity-cli", "skills"));
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
    const [rule] = group["agent-loop-parent-guard"].PreToolUse;
    group["agent-loop-parent-guard"].PreToolUse[0] = {
      matcher: [...ANTIGRAVITY_GUARDED_TOOLS].join("|"),
      ...rule,
    };
    settings.push({
      path: join(home, ".gemini", "config", "hooks.json"),
      locator: { kind: "key", key: "agent-loop-parent-guard" },
      entry: group["agent-loop-parent-guard"],
    });
  } else {
    throw new Error(`Unsupported harness: ${harness}`);
  }

  return { files, settings, notes };
}
