import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { deepEqual } from "../../src/install/fsutil.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { installRoot, manifestPath } from "../../src/install/manifest.mjs";
import { removePath } from "../runtime-helpers.mjs";
import {
  PACKAGE_ROOT,
  makeHome,
  cleanupHomes,
  writeJson,
  readText,
  claudeSeed,
  trackHome,
} from "./install-helpers.mjs";

afterEach(cleanupHomes);

// Usefulness: verifies acceptance — an unrelated edit made after install is kept
// on uninstall, which removes only the recorded entry and reports that the file
// is not byte-identical.
test("uninstall keeps an unrelated edit made after install", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, claudeSeed());

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const edited = JSON.parse(await readText(settingsPath));
  edited.hooks.PreToolUse.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: "echo added later" }],
  });
  await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  const reports = await uninstall({ home });
  const target = reports.find((entry) => entry.path === settingsPath);
  expect(target.action).toBe("remove-entry");
  expect(target.detail).toMatch(/not byte-identical/);

  const after = JSON.parse(await readText(settingsPath));
  expect(after.hooks.PreToolUse).toHaveLength(2);
  expect(after.hooks.PreToolUse.map((entry) => entry.matcher)).toEqual(["Bash", "Bash"]);
  expect(after.permissions.allow).toEqual(["Bash"]);
});

// Usefulness: verifies acceptance #205 — uninstall still works after the
// package that install ran from is gone, because it acts on the manifest and
// the harness files, not on the package root.
test("uninstall works after the package root is gone", async () => {
  const home = await makeHome();
  const movedRoot = await mkdtemp(join(tmpdir(), "agent-loop-gone-package-"));
  trackHome(movedRoot);
  await cp(
    join(PACKAGE_ROOT, "src", "install", "templates"),
    join(movedRoot, "src", "install", "templates"),
    { recursive: true },
  );
  await mkdir(join(movedRoot, "docs"), { recursive: true });
  await cp(
    join(PACKAGE_ROOT, "docs", "orchestrator-instructions.md"),
    join(movedRoot, "docs", "orchestrator-instructions.md"),
  );

  await install({ harnesses: ["claude"], home, packageRoot: movedRoot });
  const skillPath = join(home, ".claude", "skills", "agent-loop", "SKILL.md");
  expect(existsSync(skillPath)).toBe(true);

  await removePath(movedRoot);

  const reports = await uninstall({ home });
  expect(reports.find((entry) => entry.path === skillPath).action).toBe("delete");
  expect(existsSync(skillPath)).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies acceptance — a partial uninstall removes the empty hook
// containers install created instead of leaving `hooks.PreToolUse: []`.
test("uninstall prunes the empty hook containers it created", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, { other: 1 });
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const edited = JSON.parse(await readText(settingsPath));
  edited.theme = "dark";
  await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  await uninstall({ home });
  const after = JSON.parse(await readText(settingsPath));
  expect(after.hooks).toBeUndefined();
  expect(after.other).toBe(1);
  expect(after.theme).toBe("dark");
});

// Usefulness: verifies the finding that pruning must not remove a container the
// user already had. The seed owns an empty `hooks`; install creates only
// `PreToolUse` inside it, so uninstall removes `PreToolUse` and keeps `hooks`.
test("uninstall keeps an empty container the user already had", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, { hooks: {} });
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const edited = JSON.parse(await readText(settingsPath));
  edited.theme = "dark";
  await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  await uninstall({ home });
  const after = JSON.parse(await readText(settingsPath));
  expect(deepEqual(after.hooks, {})).toBe(true);
  expect(after.theme).toBe("dark");
});

// Usefulness: verifies acceptance #193 — the lock lives outside the install
// home, so a full uninstall still deletes `<home>/.agent-loops`.
test("a full uninstall removes the install home directory", async () => {
  const home = await makeHome();
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(existsSync(installRoot(home))).toBe(true);

  await uninstall({ home });
  expect(existsSync(installRoot(home))).toBe(false);
});
