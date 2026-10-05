import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { install } from "../../src/install/installer.mjs";
import { removePath } from "../runtime-helpers.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const homes = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await removePath(home);
  }
});

async function skillNote(harness, skillsDir) {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-notes-home-"));
  homes.push(home);
  const reports = await install({ harnesses: [harness], home, packageRoot: PACKAGE_ROOT });
  const note = reports.find((r) => r.action === "note" && r.path === join(home, ...skillsDir));
  expect(note).toBeDefined();
  return note.detail;
}

// Usefulness: verifies #202 — each post-install note states the same gate rule
// as its skill template, so the user learns when the skill refuses to start.
test.each([
  { harness: "codex", skillsDir: [".agents", "skills"], name: "Codex CLI" },
  { harness: "claude", skillsDir: [".claude", "skills"], name: "Claude Code" },
])("the $harness note describes the harness gate in full", async ({ harness, skillsDir, name }) => {
  const detail = await skillNote(harness, skillsDir);
  expect(detail).toContain(`by absolute path with \`harness-check ${harness}\``);
  expect(detail).toContain(`nearest harness above the shell is ${name}`);
  expect(detail).toContain("any other harness");
  expect(detail).toContain("cannot run or finds no harness ancestor");
  expect(detail).not.toContain("foreign session");
});

// Usefulness: verifies #201 — the Codex trust note names the hook file and entry
// and states the cost of skipping trust, in a dry run and a real install alike.
test.each([{ dryRun: true }, { dryRun: false }])(
  "the Codex trust note names the hook and says the guard stays inactive until trusted (dryRun: $dryRun)",
  async ({ dryRun }) => {
    const home = await mkdtemp(join(tmpdir(), "agent-loop-notes-home-"));
    homes.push(home);
    const reports = await install({
      harnesses: ["codex"],
      home,
      packageRoot: PACKAGE_ROOT,
      dryRun,
    });
    const note = reports.find(
      (r) => r.action === "note" && r.path === join(home, ".codex", "hooks.json"),
    );
    expect(note).toBeDefined();
    expect(note.detail).toContain("~/.codex/hooks.json");
    expect(note.detail).toContain("parent-guard.mjs");
    expect(note.detail).toContain("Checking parent orchestration guard");
    expect(note.detail).toContain("/hooks");
    expect(note.detail).toContain("PreToolUse entry");
    expect(note.detail).toMatch(/guard stays inactive in Codex until the hook is trusted/);
    expect(note.detail).toContain("A changed hook command needs a new trust step.");
  },
);
