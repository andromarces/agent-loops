import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { HARNESS_ORDER } from "../../src/lib/harnesses.mjs";
import {
  PACKAGE_ROOT,
  makeHome,
  cleanupHomes,
  targetPaths,
  cliInvocation,
  gateCommand,
} from "./install-helpers.mjs";

afterEach(cleanupHomes);

// Usefulness: verifies the shared `~/.agents/skills` acceptance — the Codex
// skill runs the ancestry check and every later command through the resolved
// CLI invocation, so a Copilot session that inherits CODEX_THREAD_ID cannot
// start a run through it and a Git Bash session without the `agent-loop` shim
// can start a guarded run (#151).
test("the Codex skill requires the harness-check ancestry gate", async () => {
  const home = await makeHome();
  const codex = await targetPaths("codex", home);
  const skill = codex.files.find((file) => file.path.endsWith("SKILL.md")).content;
  expect(skill).toContain(gateCommand("codex"));
  expect(skill).not.toContain("agent-loop harness-check");
  expect(skill).toContain(`\`agent-loop\` command in the instructions as \`${cliInvocation()}\``);
  expect(skill).toContain("exits 3");
  expect(skill).toContain("found no harness ancestor");
  expect(skill).toContain("CODEX_THREAD_ID");
});

// Usefulness: verifies the shared `~/.claude/skills` acceptance — the Claude
// skill runs the ancestry check and every later command through the resolved
// CLI invocation, so an OpenCode session that discovers that folder cannot start
// an unguarded run and a Git Bash session without the `agent-loop` shim can
// start a guarded run (#151).
test("the Claude skill requires the harness-check ancestry gate", async () => {
  const home = await makeHome();
  const claude = await targetPaths("claude", home);
  const skill = claude.files.find((file) => file.path.endsWith("SKILL.md")).content;
  expect(skill).toContain(gateCommand("claude"));
  expect(skill).not.toContain("agent-loop harness-check");
  expect(skill).toContain(`\`agent-loop\` command in the instructions as \`${cliInvocation()}\``);
  expect(skill).toContain("exits 3");
  expect(skill).toContain("found no harness ancestor");
  expect(skill).toContain("CLAUDE_SESSION_ID");
});

// Usefulness: verifies the OpenCode acceptance — OpenCode discovers both
// ~/.claude/skills and ~/.agents/skills and lists each shared skill to the
// model, so the model auto-invoked it for an /agent-loop request instead of the
// installed plugin command. Each shared skill sets
// `metadata.opencode/autoinvoke: false`, so OpenCode drops it from the model
// list and the plugin command owns /agent-loop; the shared copies still refuse
// a foreign session through their harness-check gate.
test("the shared skills hide themselves from OpenCode's model list", async () => {
  const home = await makeHome();
  for (const harness of ["claude", "codex"]) {
    const targets = await targetPaths(harness, home);
    const skill = targets.files.find((file) => file.path.endsWith("SKILL.md")).content;
    const frontmatter = skill.split("---", 3)[1] ?? "";
    expect(frontmatter, `${harness} frontmatter`).toContain("opencode/autoinvoke: false");
  }
});

// Usefulness: verifies the same #151 acceptance for the Antigravity skill — the
// gate and the later commands use the resolved CLI invocation, and the skill
// names a check that cannot run without claiming another harness owns the
// session.
test("the Antigravity skill requires the harness-check ancestry gate", async () => {
  const home = await makeHome();
  const antigravity = await targetPaths("antigravity", home);
  const skill = antigravity.files.find((file) => file.path.endsWith("SKILL.md")).content;
  expect(skill).toContain(gateCommand("antigravity"));
  expect(skill).not.toContain("agent-loop harness-check");
  expect(skill).toContain(`\`agent-loop\` command in the instructions as \`${cliInvocation()}\``);
  expect(skill).toContain("exits 3");
  expect(skill).toContain("found no harness ancestor");
  expect(skill).toContain("ANTIGRAVITY_CONVERSATION_ID");
});

// Usefulness: verifies the packaging contract — every rendered target resolves
// inside the installed package and no template placeholder survives, so a
// registry install points at real files.
test("rendered targets carry absolute package paths and no placeholders", async () => {
  const renderHome = join(tmpdir(), "agent-loop-render-home");
  for (const harness of HARNESS_ORDER) {
    const targets = await targetPaths(harness, renderHome);
    const texts = [
      ...targets.files.map((file) => file.content),
      ...targets.settings.map((settings) => JSON.stringify(settings.entry)),
    ];
    for (const text of texts) {
      expect(text, harness).not.toMatch(/__AGENT_LOOP_/);
    }
    for (const file of targets.files) {
      expect(file.path.startsWith(renderHome), file.path).toBe(true);
    }
  }

  const claude = await targetPaths("claude", renderHome);
  expect(claude.files[0].content).toContain(PACKAGE_ROOT.replaceAll("\\", "/"));
  expect(claude.settings[0].entry.hooks[0].command).toContain(
    join(PACKAGE_ROOT, "src", "hook", "parent-guard.mjs"),
  );

  const opencode = await targetPaths("opencode", renderHome);
  expect(opencode.files[0].content).toContain("file:///");
  expect(opencode.files[0].content).toContain("opencode-plugin.mjs");

  const copilotHome = join(tmpdir(), "agent-loop-copilot-home");
  const copilot = await targetPaths("copilot", renderHome, { copilotHome });
  expect(copilot.files[0].path.startsWith(copilotHome)).toBe(true);
  expect(JSON.parse(copilot.files[0].content).hooks.PreToolUse[0].args[0]).toBe(
    join(PACKAGE_ROOT, "src", "hook", "copilot-parent-guard.mjs"),
  );
});
