import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { main as cliMain } from "../../src/cli.mjs";
import { deepEqual, sha256 } from "../../src/install/fsutil.mjs";
import { buildTargets, HARNESS_ORDER } from "../../src/install/harnesses.mjs";
import { detectHarnesses, install, uninstall } from "../../src/install/installer.mjs";
import { manifestPath, readManifest } from "../../src/install/manifest.mjs";
import { harnessForProcessName, nearestHarness } from "../../src/lib/process-ancestry.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const homes = [];

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-install-home-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
  homes.length = 0;
});

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function claudeSeed() {
  return {
    permissions: { allow: ["Bash"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }],
      PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo post" }] }],
    },
  };
}

function codexSeed() {
  return {
    description: "my hooks",
    hooks: {
      PreToolUse: [{ matcher: "^shell$", hooks: [{ type: "command", command: "echo unrelated" }] }],
    },
  };
}

function antigravitySeed() {
  return {
    "other-group": {
      PreToolUse: [{ matcher: "x", hooks: [{ type: "command", command: "echo x" }] }],
    },
  };
}

async function targetPaths(harness, home, extra = {}) {
  const targets = await buildTargets(harness, { home, packageRoot: PACKAGE_ROOT, ...extra });
  return targets;
}

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

// Usefulness: verifies acceptance — an unparseable settings file stops the
// command with no write at all, and the error carries the manual snippet the
// CLI prints, so a maintainer can add the entry by hand.
test("an unparseable settings file stops install with no write and reports the snippet", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, "{ not json\n", "utf8");
  const before = await readText(settingsPath);

  const error = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT }).catch(
    (err) => err,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error.snippet).toContain("hooks.PreToolUse");
  expect(await readText(settingsPath)).toBe(before);
  expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies that a wrong-typed settings container is refused like an
// unparseable file, so no entry point installs without its guard and no write
// happens. Covers `"hooks": []`, `"PreToolUse": {}`, and `"PreToolUse": "x"`.
test("a wrong-typed settings container stops install with no write", async () => {
  const seeds = [{ hooks: [] }, { hooks: { PreToolUse: {} } }, { hooks: { PreToolUse: "x" } }];
  for (const seed of seeds) {
    const home = await makeHome();
    const settingsPath = join(home, ".claude", "settings.json");
    await writeJson(settingsPath, seed);
    const before = await readText(settingsPath);

    const error = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT }).catch(
      (err) => err,
    );
    expect(error, JSON.stringify(seed)).toBeInstanceOf(Error);
    expect(error.snippet, JSON.stringify(seed)).toContain("hooks.PreToolUse");
    expect(await readText(settingsPath), JSON.stringify(seed)).toBe(before);
    expect(
      existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md")),
      JSON.stringify(seed),
    ).toBe(false);
  }
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

// Usefulness: verifies the shared `~/.agents/skills` acceptance — the Codex
// skill carries the ancestry check, so a Copilot session that inherits
// CODEX_THREAD_ID cannot start a run through it.
test("the Codex skill requires the harness-check ancestry gate", async () => {
  const home = await makeHome();
  const codex = await targetPaths("codex", home);
  const skill = codex.files.find((file) => file.path.endsWith("SKILL.md")).content;
  expect(skill).toContain("agent-loop harness-check codex");
  expect(skill).toContain("CODEX_THREAD_ID");
});

// Usefulness: verifies the process-ancestry mechanism — the nearest harness
// above the shell decides the running harness, an unknown or missing ancestor
// returns null, and a nested Copilot session under a Codex shell resolves to
// Copilot.
test("nearestHarness resolves the running harness and fails closed when absent", async () => {
  const table = [
    { pid: 10, ppid: 1, name: "codex.exe" },
    { pid: 20, ppid: 10, name: "cmd.exe" },
    { pid: 30, ppid: 20, name: "node.exe" },
    { pid: 40, ppid: 30, name: "bash" },
    { pid: 50, ppid: 40, name: "copilot.exe" },
  ];
  const readProcesses = async () => table;
  expect(await nearestHarness({ startPid: 40, readProcesses })).toBe("codex");
  expect(await nearestHarness({ startPid: 50, readProcesses })).toBe("copilot");
  expect(await nearestHarness({ startPid: 999, readProcesses })).toBe(null);
  expect(await nearestHarness({ startPid: 0, readProcesses })).toBe(null);
});

test("harnessForProcessName maps harness binaries and rejects others", () => {
  expect(harnessForProcessName("codex.exe")).toBe("codex");
  expect(harnessForProcessName("C:\\tools\\opencode.cmd")).toBe("opencode");
  expect(harnessForProcessName("agy")).toBe("antigravity");
  expect(harnessForProcessName("antigravity.exe")).toBe("antigravity");
  expect(harnessForProcessName("bash")).toBe(null);
  expect(harnessForProcessName("")).toBe(null);
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
  expect(JSON.parse(copilot.files[0].content).hooks.PreToolUse[0].args[0]).toContain(
    "parent-guard.mjs",
  );
});

// Usefulness: verifies detection runs without throwing and returns harness ids
// in registry order; the detected set depends on the machine, so only the shape
// is asserted.
test("detectHarnesses returns a subset of the registry", async () => {
  const detected = await detectHarnesses();
  expect(Array.isArray(detected)).toBe(true);
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
  homes.push(movedRoot);
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

// Usefulness: verifies the upgrade acceptance over user edits — a package move
// rewrites the settings file, and uninstall must keep the user's unrelated edit
// rather than restore the pre-install backup.
test("an upgrade over a user-edited settings file keeps the edit", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, { hooks: { PreToolUse: [] } });
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const manifest = await readManifest(home);
  const record = manifest.harnesses.claude.settings[0];
  const oldEntry = {
    matcher: record.entry.matcher,
    hooks: [{ type: "command", command: "node /old/location/parent-guard.mjs", timeout: 10 }],
  };
  const settings = JSON.parse(await readText(settingsPath));
  const index = settings.hooks.PreToolUse.findIndex((entry) => deepEqual(entry, record.entry));
  settings.hooks.PreToolUse[index] = oldEntry;
  settings.theme = "dark";
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  // The manifest still records the old entry and its old hash, as a package
  // move leaves it. Do not touch `shaAfter`: that is the user-edit evidence.
  record.entry = oldEntry;
  await writeFile(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  await uninstall({ home });
  const after = JSON.parse(await readText(settingsPath));
  expect(after.theme).toBe("dark");
  // The seed had an empty `hooks.PreToolUse`; install did not create it, so
  // uninstall removes only the guard entry and keeps the user's container.
  expect(after.hooks?.PreToolUse ?? []).toHaveLength(0);
});

// Usefulness: verifies "no harness installs an entry point without its guard" —
// a user entry with the same matcher is kept and the guard is appended, so
// Claude Code (which allows several entries per matcher) gets its guard.
test("install appends the guard beside a same-matcher user entry", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  const userEntry = {
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command: "echo user" }],
  };
  await writeJson(settingsPath, { hooks: { PreToolUse: [userEntry] } });

  const reports = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(reports.find((entry) => entry.kind === "settings").action).toBe("update");
  const after = JSON.parse(await readText(settingsPath));
  expect(after.hooks.PreToolUse).toHaveLength(2);
  expect(deepEqual(after.hooks.PreToolUse[0], userEntry)).toBe(true);
  expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(true);
});

// Usefulness: verifies "no harness installs an entry point without its guard" —
// a conflicting named hook group (Antigravity owns one key, so it cannot append)
// blocks the skill and shim instead of leaving them unguarded.
test("a conflicting guard key blocks the entry point", async () => {
  const home = await makeHome();
  const hooksPath = join(home, ".gemini", "config", "hooks.json");
  await writeJson(hooksPath, {
    "agent-loop-parent-guard": { PreToolUse: [{ matcher: "user", hooks: [] }] },
  });

  const reports = await install({ harnesses: ["antigravity"], home, packageRoot: PACKAGE_ROOT });
  expect(reports.find((entry) => entry.kind === "settings").action).toBe("skip");
  expect(reports.find((entry) => entry.kind === "file").action).toBe("skip");
  expect(
    existsSync(join(home, ".gemini", "antigravity-cli", "skills", "agent-loop", "SKILL.md")),
  ).toBe(false);
  const after = JSON.parse(await readText(hooksPath));
  expect(after["agent-loop-parent-guard"].PreToolUse[0].matcher).toBe("user");
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

// Usefulness: verifies the regression fix — an identical guard entry that the
// user added by hand has no manifest record. The guard is present, so install
// writes the entry point and leaves the entry unowned; uninstall removes the
// entry point and leaves the hand-added guard.
test("a hand-added identical guard entry does not block the entry point", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  const guardEntry = (await targetPaths("claude", home)).settings[0].entry;
  await writeJson(settingsPath, { hooks: { PreToolUse: [guardEntry] } });

  const reports = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const settingsReport = reports.find((entry) => entry.kind === "settings");
  expect(settingsReport.action).toBe("noop");
  expect(settingsReport.detail).toMatch(/unowned/);
  const skillPath = join(home, ".claude", "skills", "agent-loop", "SKILL.md");
  expect(existsSync(skillPath)).toBe(true);

  await uninstall({ home });
  expect(existsSync(skillPath)).toBe(false);
  const after = JSON.parse(await readText(settingsPath));
  expect(after.hooks.PreToolUse).toHaveLength(1);
  expect(deepEqual(after.hooks.PreToolUse[0], guardEntry)).toBe(true);
});

// Usefulness: verifies that a private settings file stays private through
// install, backup, and uninstall. POSIX only: Windows does not carry these bits.
test.skipIf(process.platform === "win32")(
  "install preserves settings file permissions",
  async () => {
    const home = await makeHome();
    const settingsPath = join(home, ".claude", "settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2)}\n`,
      "utf8",
    );
    await chmod(settingsPath, 0o600);

    await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${settingsPath}.agent-loops-backup`)).mode & 0o777).toBe(0o600);

    await uninstall({ home });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  },
);

// Usefulness: verifies the CLI wiring — `install --dry-run` returns success
// without writing, and `harness-check` fails before any harness table is read
// for an unknown or missing harness name.
test("CLI dispatches install, uninstall, and harness-check", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness", "claude", "--yes", "--dry-run"]);
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);

    process.exitCode = 0;
    await cliMain(["uninstall", "--yes"]);
    expect(process.exitCode).toBe(0);

    process.exitCode = 0;
    await cliMain(["harness-check", "not-a-harness"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await cliMain(["harness-check"]);
    expect(process.exitCode).toBe(1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    delete process.env.AGENT_LOOP_HOME;
    process.exitCode = 0;
  }
});

// Usefulness: verifies the acceptance text "Print the manual snippet instead" —
// the CLI prints the snippet on stdout when a settings file does not parse, so
// the maintainer can add the guard by hand.
test("CLI prints the manual snippet when a settings file does not parse", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, "{ bad\n", "utf8");

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message) => logs.push(String(message));
  console.error = () => {};
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness", "claude", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("hooks.PreToolUse");
    expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    delete process.env.AGENT_LOOP_HOME;
    process.exitCode = 0;
  }
});
