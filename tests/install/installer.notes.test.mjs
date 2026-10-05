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
