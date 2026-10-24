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

// Usefulness: verifies the #1055 acceptance — a Claude Code session did not attach the file
// that an `@` line in the skill body named, so the skill states one read route: the path in full,
// and no `@` line that can fail to attach. The core is expected to fit in one read (#1061), but the
// byte bound of its test is not a token count, so the skill keeps a conditional continuation: when
// a read is capped, read again with an offset until the end of the core. It also sends the parent to
// the reference files that the core names.
test("the Claude skill reads the instructions core in full, continues a capped read, and has no @ line", async () => {
  const home = await makeHome();
  const claude = await targetPaths("claude", home);
  const skill = claude.files.find((file) => file.path.endsWith("SKILL.md")).content;
  const instructions = join(PACKAGE_ROOT, "docs/orchestrator-instructions.md").replaceAll(
    "\\",
    "/",
  );
  expect(skill).not.toMatch(/^@/m);
  expect(skill.replace(/\s+/g, " ")).toContain(`Read \`${instructions}\` in full before acting`);
  expect(skill.replace(/\s+/g, " ")).toMatch(
    /expected to fit in one read, but when a read is capped, read again with an offset until the end of the file/,
  );
  expect(skill.replace(/\s+/g, " ")).toContain(
    "names reference files to read when their conditions hold",
  );
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
  expect(skill).toContain("/agent-loop");
  const instructions = join(PACKAGE_ROOT, "docs", "orchestrator-instructions.md");
  expect(skill).toContain(`Read \`${instructions.replaceAll("\\", "/")}\``);
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

// Usefulness: verifies the #751 acceptance — the one shared harness-check paragraph renders into
// each skill with that harness's id, label, and session variable, so the three entry points keep
// their exact check text (line wrapping aside) from one source.
test.each([
  [
    "claude",
    "Claude Code",
    "Do not use `${CLAUDE_SESSION_ID}` to make this decision, because a foreign harness leaves the literal in place and a nested harness inherits the value.",
  ],
  [
    "codex",
    "Codex CLI",
    "Do not use `CODEX_THREAD_ID` to make this decision, because a nested harness inherits it.",
  ],
  [
    "antigravity",
    "Antigravity CLI",
    "Do not use `ANTIGRAVITY_CONVERSATION_ID` to make this decision, because a nested harness inherits it.",
  ],
])("the %s skill renders the shared harness-check paragraph", async (harness, label, closing) => {
  const home = await makeHome();
  const targets = await targetPaths(harness, home);
  const skill = targets.files.find((file) => file.path.endsWith("SKILL.md")).content;
  const expected =
    `Before the init dispatch call, run \`${gateCommand(harness)}\`. It exits 0 only when the ` +
    `nearest harness process above this shell is ${label}. If it exits 3, stop and report that ` +
    "another harness owns the session; do not start a run. If it exits with any other non-zero " +
    "code, stop and report that the check could not run or found no harness ancestor, which is " +
    `distinct from a harness refusal. ${closing}`;
  expect(skill.replace(/\s+/g, " ")).toContain(expected);
  expect(skill).not.toContain("{{HARNESS_CHECK");
});

// Usefulness: verifies the #808 acceptance — the Codex and Antigravity skills render the session-channel
// paragraph from one source, so only the variable name differs and the "absent" sentence has one wording.
test.each([
  ["codex", "CODEX_THREAD_ID"],
  ["antigravity", "ANTIGRAVITY_CONVERSATION_ID"],
])("the %s skill renders the shared session-channel paragraph", async (harness, variable) => {
  const home = await makeHome();
  const targets = await targetPaths(harness, home);
  const skill = targets.files.find((file) => file.path.endsWith("SKILL.md")).content;
  const expected =
    `Use the invocation text as the task and role settings. Before the init dispatch call, verify ` +
    `that the active shell has \`${variable}\`. Do not print its value. In PowerShell, pass ` +
    `\`$env:${variable}\` as \`--parent-session\`. Set \`$worktree = (Get-Location).Path\` and pass ` +
    "`--cwd $worktree`. Do not embed `$PWD` in POSIX-style quotes. In POSIX shells, pass " +
    `\`--cwd "$PWD"\` and \`$${variable}\`. If the variable is absent, report the missing session ` +
    "channel and do not start the run.";
  expect(skill.replace(/\s+/g, " ")).toContain(expected);
  expect(skill).not.toContain("{{SESSION_CHANNEL");
});

// Usefulness: verifies the #840 acceptance — the rendered paragraph boundaries around the session-channel
// text match origin/main for each harness (Codex splits it in two; Antigravity keeps one), so a wrapping
// change cannot merge or split paragraphs.
test.each([
  ["codex", "CODEX_THREAD_ID", 2],
  ["antigravity", "ANTIGRAVITY_CONVERSATION_ID", 1],
])(
  "the %s skill keeps its session-channel paragraph boundaries",
  async (harness, variable, count) => {
    const home = await makeHome();
    const targets = await targetPaths(harness, home);
    const skill = targets.files.find((file) => file.path.endsWith("SKILL.md")).content;
    const paragraphs = skill
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim());
    const start = paragraphs.findIndex((paragraph) =>
      paragraph.startsWith("Use the invocation text"),
    );
    const end = paragraphs.findIndex((paragraph) => paragraph.endsWith("do not start the run."));
    expect(start).toBeGreaterThan(0);
    expect(end - start + 1).toBe(count);
    if (count === 2) {
      expect(paragraphs[start].endsWith("Do not print its value.")).toBe(true);
      expect(paragraphs[end].startsWith("In PowerShell, pass")).toBe(true);
    }
    expect(paragraphs[start]).toContain(`\`${variable}\``);
  },
);
