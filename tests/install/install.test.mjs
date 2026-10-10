import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import { deepEqual, sha256, writeTextAtomic } from "../../src/install/fsutil.mjs";
import { buildTargets } from "../../src/install/harnesses.mjs";
import { HARNESS_ORDER } from "../../src/lib/harnesses.mjs";
import { detectHarnesses, install, uninstall } from "../../src/install/installer.mjs";
import { manifestLockFile, manifestPath, readManifest } from "../../src/install/manifest.mjs";
import {
  PACKAGE_ROOT,
  makeHome,
  cleanupHomes,
  writeJson,
  readText,
  claudeSeed,
  codexSeed,
  antigravitySeed,
  targetPaths,
  guardIsInstalled,
  trackHome,
} from "./install-helpers.mjs";

afterEach(cleanupHomes);

// Usefulness: verifies the round-trip acceptance — a five-harness install then
// uninstall restores every pre-existing settings file byte-identical, deletes
// every created file, prunes the directories it created, and leaves an
// unrelated file in the shared `~/.agents/skills` directory alone.
test("install then uninstall restores pre-existing bytes and deletes created files", async () => {
  const home = await makeHome();
  const claudeSettings = join(home, ".claude", "settings.json");
  const codexSettings = join(home, ".codex", "hooks.json");
  const antigravitySettings = join(home, ".gemini", "config", "hooks.json");
  const sentinel = join(home, ".agents", "skills", "other.txt");
  await writeJson(claudeSettings, claudeSeed());
  await writeJson(codexSettings, codexSeed());
  await writeJson(antigravitySettings, antigravitySeed());
  await writeJson(sentinel, "keep");

  const before = {
    [claudeSettings]: await readText(claudeSettings),
    [codexSettings]: await readText(codexSettings),
    [antigravitySettings]: await readText(antigravitySettings),
  };

  const claude = await targetPaths("claude", home);
  const codex = await targetPaths("codex", home);
  const opencode = await targetPaths("opencode", home);
  const copilot = await targetPaths("copilot", home);
  const antigravity = await targetPaths("antigravity", home);
  const created = [
    ...claude.files.map((file) => file.path),
    ...codex.files.map((file) => file.path),
    ...opencode.files.map((file) => file.path),
    ...copilot.files.map((file) => file.path),
    ...antigravity.files.map((file) => file.path),
  ];

  await install({ harnesses: HARNESS_ORDER, home, packageRoot: PACKAGE_ROOT });
  for (const path of created) {
    expect(existsSync(path), path).toBe(true);
  }
  const claudeInstalled = JSON.parse(await readText(claudeSettings));
  expect(claudeInstalled.permissions.allow).toEqual(["Bash"]);
  expect(claudeInstalled.hooks.PostToolUse).toHaveLength(1);

  await uninstall({ home });
  for (const [path, content] of Object.entries(before)) {
    expect(await readText(path), path).toBe(content);
  }
  for (const path of created) {
    expect(existsSync(path), path).toBe(false);
  }
  expect(existsSync(sentinel)).toBe(true);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies acceptance — a second install with the same package
// makes no change: every plan is a no-op and every byte is unchanged.
test("a second install is a no-op", async () => {
  const home = await makeHome();
  await install({ harnesses: HARNESS_ORDER, home, packageRoot: PACKAGE_ROOT });
  const paths = [
    join(home, ".claude", "skills", "agent-loop", "SKILL.md"),
    join(home, ".claude", "settings.json"),
    join(home, ".agents", "skills", "agent-loop", "SKILL.md"),
    join(home, ".codex", "hooks.json"),
    join(home, ".config", "opencode", "plugins", "parent-guard.ts"),
    join(home, ".copilot", "hooks", "parent-guard.json"),
    join(home, ".gemini", "config", "hooks.json"),
  ];
  const before = Object.fromEntries(
    await Promise.all(paths.map(async (p) => [p, await readText(p)])),
  );

  const reports = await install({ harnesses: HARNESS_ORDER, home, packageRoot: PACKAGE_ROOT });
  const writes = reports.filter((entry) => !["noop", "note"].includes(entry.action));
  expect(writes).toEqual([]);
  for (const path of paths) {
    expect(await readText(path), path).toBe(before[path]);
  }
});

// Usefulness: verifies acceptance — install after an upgrade replaces the
// recorded entry by deep equality and adds no duplicate, and uninstall after
// that upgrade restores the original pre-install file rather than the earlier
// installed version.
test("upgrade replaces the recorded entry and uninstall restores the original", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  const original = `${JSON.stringify(claudeSeed(), null, 2)}\n`;
  await writeJson(settingsPath, claudeSeed());

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const newEntry = (await targetPaths("claude", home)).settings[0].entry;

  const manifest = await readManifest(home);
  const record = manifest.harnesses.claude.settings[0];
  const oldEntry = {
    matcher: record.entry.matcher,
    hooks: [{ type: "command", command: 'node "/old/location/parent-guard.mjs"', timeout: 10 }],
  };
  const settings = JSON.parse(await readText(settingsPath));
  const index = settings.hooks.PreToolUse.findIndex((entry) => deepEqual(entry, record.entry));
  settings.hooks.PreToolUse[index] = oldEntry;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  record.entry = oldEntry;
  record.shaAfter = sha256(await readText(settingsPath));
  await writeFile(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const upgraded = JSON.parse(await readText(settingsPath));
  const matching = upgraded.hooks.PreToolUse.filter((entry) => entry.matcher === newEntry.matcher);
  expect(matching).toHaveLength(1);
  expect(deepEqual(matching[0], newEntry)).toBe(true);

  await uninstall({ home });
  expect(await readText(settingsPath)).toBe(original);
});

// Usefulness: verifies acceptance — a user-edited owned file survives install
// and uninstall, and the command reports it instead of overwriting or deleting.
test("a user-edited owned file survives install and uninstall", async () => {
  const home = await makeHome();
  const skillPath = join(home, ".claude", "skills", "agent-loop", "SKILL.md");
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  await writeFile(skillPath, "user edit\n", "utf8");

  const installReports = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(installReports.find((entry) => entry.path === skillPath).action).toBe("skip");

  const uninstallReports = await uninstall({ home });
  expect(uninstallReports.find((entry) => entry.path === skillPath).action).toBe("skip");
  expect(await readText(skillPath)).toBe("user edit\n");
});

// Usefulness: verifies acceptance — --dry-run reports planned writes and
// changes nothing on disk.
test("dry-run reports planned writes and changes nothing", async () => {
  const home = await makeHome();
  const reports = await install({
    harnesses: ["claude", "codex"],
    home,
    packageRoot: PACKAGE_ROOT,
    dryRun: true,
  });
  expect(reports.some((entry) => entry.action === "create")).toBe(true);
  expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(false);
  expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies detection from a controlled PATH, so the result does not depend on machine load.
test("detectHarnesses returns a subset of the registry", async () => {
  const bin = await makeHome();
  await writeFile(join(bin, "codex"), "");
  await writeFile(join(bin, "claude"), "");
  const detected = await detectHarnesses({ path: bin });
  expect(detected).toEqual(["claude", "codex"]);
  for (const harness of detected) {
    expect(HARNESS_ORDER).toContain(harness);
  }
});

// Usefulness: verifies the development-install acceptance — after a clone
// moves, re-running install points every rendered entry at the new package
// location, because the entries follow `packageRoot`, not the process cwd.
test("a moved package renders entry points at the new location", async () => {
  const home = await makeHome();
  const movedRoot = await mkdtemp(join(tmpdir(), "agent-loop-moved-package-"));
  trackHome(movedRoot);
  await cp(
    join(PACKAGE_ROOT, "src", "install", "templates"),
    join(movedRoot, "src", "install", "templates"),
    {
      recursive: true,
    },
  );
  await mkdir(join(movedRoot, "docs"), { recursive: true });
  await cp(
    join(PACKAGE_ROOT, "docs", "orchestrator-instructions.md"),
    join(movedRoot, "docs", "orchestrator-instructions.md"),
  );

  const claude = await buildTargets("claude", { home, packageRoot: movedRoot });
  expect(claude.settings[0].entry.hooks[0].command).toContain(
    join(movedRoot, "src", "hook", "parent-guard.mjs"),
  );
  expect(claude.files[0].content).toContain(movedRoot.replaceAll("\\", "/"));

  const opencode = await buildTargets("opencode", { home, packageRoot: movedRoot });
  expect(opencode.files[0].content).toContain(
    pathToFileURL(join(movedRoot, "src", "hook", "decision.mjs")).href,
  );
});

// Usefulness: verifies acceptance #205 — install refuses a package root inside
// an `npx` or `pnpm dlx` cache with an actionable message and writes nothing,
// because npm or pnpm can delete that cache directory and every path install
// wrote would point at a missing file.
test("install refuses an npx or dlx cache package root", async () => {
  const home = await makeHome();
  const roots = [
    join(
      home,
      "npm-cache",
      "_npx",
      "09f5e92d3f3f415f",
      "node_modules",
      "@andromarces",
      "agent-loops",
    ),
    join(
      home,
      "pnpm",
      "dlx",
      "0dd49d4f3230c83239c085437bfea068",
      "mtwi8m5o-8i0",
      "node_modules",
      "@andromarces",
      "agent-loops",
    ),
  ];
  for (const packageRoot of roots) {
    const error = await install({ harnesses: ["claude"], home, packageRoot }).then(
      () => null,
      (err) => err,
    );
    expect(error, packageRoot).toBeInstanceOf(Error);
    expect(error.message, packageRoot).toMatch(/npx|dlx/);
    expect(error.message, packageRoot).toMatch(/install globally/i);
    expect(existsSync(join(home, ".claude", "settings.json")), packageRoot).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md")), packageRoot).toBe(
      false,
    );
    expect(existsSync(manifestPath(home)), packageRoot).toBe(false);
  }
});

// Usefulness: verifies acceptance #207 — install refuses the temporary roots
// that `bunx` (`<tmp>/bunx-<uid>-<package>/node_modules`) and `yarn dlx`
// (`<tmp>/xfs-<id>/dlx-<pid>/.yarn/cache/<package>.zip/node_modules`) place the
// package in, because the runner or the OS can delete them.
test("install refuses a bunx or yarn dlx temporary package root", async () => {
  const home = await makeHome();
  const roots = [
    join(
      home,
      "tmp",
      "bunx-501-@andromarces",
      "agent-loops@0.5.0",
      "node_modules",
      "@andromarces",
      "agent-loops",
    ),
    join(
      home,
      "tmp",
      "xfs-8de51b90",
      "dlx-31536",
      ".yarn",
      "cache",
      "@andromarces-agent-loops-npm-0.5.0-67c80bf43c-f9ecf7737e.zip",
      "node_modules",
      "@andromarces",
      "agent-loops",
    ),
  ];
  for (const packageRoot of roots) {
    const error = await install({ harnesses: ["claude"], home, packageRoot }).then(
      () => null,
      (err) => err,
    );
    expect(error, packageRoot).toBeInstanceOf(Error);
    expect(error.message, packageRoot).toMatch(/^Refusing to install.*(bunx|yarn dlx)/);
    expect(error.message, packageRoot).toMatch(/install globally/i);
    expect(existsSync(manifestPath(home)), packageRoot).toBe(false);
  }
});

// Usefulness: verifies the negative of acceptance #205 — a path that merely
// contains a `dlx` segment is a normal install root, so the refusal keys on the
// npx or dlx cache layout and not on the bare directory name.
test("a path that is not an npx or dlx cache layout is installed normally", async () => {
  const home = await makeHome();
  const lookalike = join(home, "dlx", "project");
  trackHome(lookalike);
  await cp(
    join(PACKAGE_ROOT, "src", "install", "templates"),
    join(lookalike, "src", "install", "templates"),
    { recursive: true },
  );
  await mkdir(join(lookalike, "docs"), { recursive: true });
  await cp(
    join(PACKAGE_ROOT, "docs", "orchestrator-instructions.md"),
    join(lookalike, "docs", "orchestrator-instructions.md"),
  );

  const reports = await install({ harnesses: ["claude"], home, packageRoot: lookalike });
  expect(reports.some((entry) => entry.action === "create")).toBe(true);
  expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(true);
});

// Usefulness: verifies the data-loss acceptance — a reinstall that reports
// noop must not advance the recorded post-install hash, so uninstall still sees
// the user's edit and removes only the entry instead of restoring the backup.
test("reinstall after a user edit keeps the edit on uninstall", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, { hooks: { PreToolUse: [] } });
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const edited = JSON.parse(await readText(settingsPath));
  edited.theme = "dark";
  await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  const reports = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(reports.find((entry) => entry.kind === "settings").action).toBe("noop");

  await uninstall({ home });
  const after = JSON.parse(await readText(settingsPath));
  expect(after.theme).toBe("dark");
});

// Usefulness: verifies acceptance #156 point 2 — an entry-point write that fails
// after the guard write completed leaves the guard and the entry point already
// written, and uninstall restores the guard and removes that entry point.
test("an entry-point write failure after the guard is recoverable", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".codex", "hooks.json");
  await writeJson(settingsPath, codexSeed());
  const before = await readText(settingsPath);
  const codex = await targetPaths("codex", home);
  const skill = codex.files.find((file) => file.path.endsWith("SKILL.md")).path;
  const yaml = codex.files.find((file) => file.path.endsWith("openai.yaml")).path;

  const write = async (path, ...rest) => {
    if (path === yaml) {
      throw new Error("simulated entry-point write failure");
    }
    return writeTextAtomic(path, ...rest);
  };

  const error = await install({
    harnesses: ["codex"],
    home,
    packageRoot: PACKAGE_ROOT,
    write,
  }).catch((err) => err);
  expect(error).toBeInstanceOf(Error);

  // The guard and the earlier entry point exist; the failed one does not.
  expect(await guardIsInstalled(home, "codex")).toBe(true);
  expect(existsSync(skill)).toBe(true);
  expect(existsSync(yaml)).toBe(false);

  await uninstall({ home });
  expect(await readText(settingsPath)).toBe(before);
  expect(existsSync(skill)).toBe(false);
  expect(existsSync(yaml)).toBe(false);
  expect(existsSync(`${settingsPath}.agent-loops-backup`)).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies acceptance #156 point 3 — a write failure in a later
// harness does not strand the completed writes of an earlier harness; uninstall
// restores the earlier harness and leaves the later one untouched.
test("a later harness write failure still lets uninstall restore the earlier harness", async () => {
  const home = await makeHome();
  const claudeSettings = join(home, ".claude", "settings.json");
  await writeJson(claudeSettings, claudeSeed());
  const claudeBefore = await readText(claudeSettings);
  const claudeSkill = join(home, ".claude", "skills", "agent-loop", "SKILL.md");
  const codexSettings = join(home, ".codex", "hooks.json");
  await writeJson(codexSettings, codexSeed());
  const codexBefore = await readText(codexSettings);
  const codexSkill = join(home, ".agents", "skills", "agent-loop", "SKILL.md");

  const write = async (path, ...rest) => {
    if (path === codexSettings) {
      throw new Error("simulated later-harness write failure");
    }
    return writeTextAtomic(path, ...rest);
  };

  const error = await install({
    harnesses: ["claude", "codex"],
    home,
    packageRoot: PACKAGE_ROOT,
    write,
  }).catch((err) => err);
  expect(error).toBeInstanceOf(Error);

  // The earlier harness completed, so its entry point has its guard. The later
  // harness wrote nothing unguarded.
  expect(await guardIsInstalled(home, "claude")).toBe(true);
  expect(existsSync(claudeSkill)).toBe(true);
  expect(await readText(codexSettings)).toBe(codexBefore);
  expect(existsSync(codexSkill)).toBe(false);

  await uninstall({ home });
  expect(await readText(claudeSettings)).toBe(claudeBefore);
  expect(existsSync(claudeSkill)).toBe(false);
  expect(await readText(codexSettings)).toBe(codexBefore);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies the upgrade path of #156 — when a write fails during an
// upgrade, the previous record stays for the target that did not complete, so
// uninstall restores the old installed bytes instead of stranding an entry
// point with no guard.
test("a failed upgrade keeps the previous record for the target it did not complete", async () => {
  for (const failAt of ["settings", "entry-point"]) {
    const home = await makeHome();
    const settingsPath = join(home, ".claude", "settings.json");
    await writeJson(settingsPath, { hooks: { PreToolUse: [] } });
    const seed = await readText(settingsPath);
    await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

    // A moved package makes the next install an upgrade: both the guard and the
    // skill render new bytes.
    const movedRoot = await mkdtemp(join(tmpdir(), "agent-loop-upgrade-package-"));
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

    const skillPath = join(home, ".claude", "skills", "agent-loop", "SKILL.md");
    const failing = failAt === "settings" ? settingsPath : skillPath;
    const write = async (path, ...rest) => {
      if (path === failing) {
        throw new Error(`simulated upgrade ${failAt} write failure`);
      }
      return writeTextAtomic(path, ...rest);
    };

    const error = await install({
      harnesses: ["claude"],
      home,
      packageRoot: movedRoot,
      write,
    }).catch((err) => err);
    expect(error, failAt).toBeInstanceOf(Error);

    // The previous record survives for the failed target and for the target the
    // loop never reached, whether or not the guard write completed.
    const manifest = await readManifest(home);
    expect(manifest.harnesses.claude.files, failAt).toHaveLength(1);
    expect(manifest.harnesses.claude.settings, failAt).toHaveLength(1);

    await uninstall({ home });
    expect(existsSync(skillPath), failAt).toBe(false);
    expect(await readText(settingsPath), failAt).toBe(seed);
    expect(existsSync(manifestPath(home)), failAt).toBe(false);
  }
});

// Usefulness: verifies acceptance #193 — a dry run creates no lock file and no
// file under the install home, not even a harness directory such as `.claude`,
// so inspection never blocks a real command and never leaves residue.
test("a dry run creates no lock file and no install-home file", async () => {
  const home = await makeHome();
  const lockFile = manifestLockFile(home);
  await install({ harnesses: ["claude", "codex"], home, packageRoot: PACKAGE_ROOT, dryRun: true });
  await uninstall({ home, dryRun: true });
  expect(existsSync(lockFile)).toBe(false);
  expect(await readdir(home)).toEqual([]);
});
