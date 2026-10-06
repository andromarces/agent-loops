import { existsSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { deepEqual, sha256, writeTextAtomic } from "../../src/install/fsutil.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { manifestPath, readManifest } from "../../src/install/manifest.mjs";
import {
  PACKAGE_ROOT,
  makeHome,
  cleanupHomes,
  writeJson,
  readText,
  claudeSeed,
  targetPaths,
} from "./install-helpers.mjs";

afterEach(cleanupHomes);

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

// Usefulness: verifies acceptance #156 point 1 — a guard settings write failure
// leaves no entry point without its guard, and uninstall still restores the
// settings file and removes the backup the failed write made.
test("a guard settings write failure leaves no unguarded entry point", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, { hooks: { PreToolUse: [] } });
  const before = await readText(settingsPath);
  const skillPath = join(home, ".claude", "skills", "agent-loop", "SKILL.md");

  const write = async (path, ...rest) => {
    if (path === settingsPath) {
      throw new Error("simulated guard settings write failure");
    }
    return writeTextAtomic(path, ...rest);
  };

  const error = await install({
    harnesses: ["claude"],
    home,
    packageRoot: PACKAGE_ROOT,
    write,
  }).catch((err) => err);
  expect(error).toBeInstanceOf(Error);

  // No entry point without its guard, and the settings file is untouched.
  expect(existsSync(skillPath)).toBe(false);
  expect(await readText(settingsPath)).toBe(before);
  expect(existsSync(`${settingsPath}.agent-loops-backup`)).toBe(false);

  await uninstall({ home });
  expect(await readText(settingsPath)).toBe(before);
  expect(existsSync(skillPath)).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);
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

// Rewrites the recorded Claude settings locator as a pre-#190 manifest wrote it,
// with the unread `matcher` field, and returns the record.
async function addLegacyMatcher(home) {
  const manifest = await readManifest(home);
  const record = manifest.harnesses.claude.settings[0];
  expect(record.locator).not.toHaveProperty("matcher");
  record.locator.matcher = record.entry.matcher;
  await writeFile(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return record;
}

// Usefulness: verifies #190 — new array locators carry no unread `matcher`.
test("array locators carry no matcher", async () => {
  for (const harness of ["claude", "codex"]) {
    const [target] = (await targetPaths(harness, await makeHome())).settings;
    expect(target.locator).toEqual({ kind: "array", path: ["hooks", "PreToolUse"] });
  }
});

// Usefulness: verifies #190 — an upgrade that changes the managed entry still
// finds and replaces it through a record whose locator carries the legacy
// `matcher`, and the user's own entries stay.
test("an upgrade replaces the entry of a legacy matcher record", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  const original = `${JSON.stringify(claudeSeed(), null, 2)}\n`;
  await writeJson(settingsPath, claudeSeed());
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const newEntry = (await targetPaths("claude", home)).settings[0].entry;

  const record = await addLegacyMatcher(home);
  const manifest = await readManifest(home);
  const legacy = manifest.harnesses.claude.settings[0];
  const oldEntry = {
    matcher: record.entry.matcher,
    hooks: [{ type: "command", command: 'node "/old/location/parent-guard.mjs"', timeout: 10 }],
  };
  const settings = JSON.parse(await readText(settingsPath));
  const index = settings.hooks.PreToolUse.findIndex((entry) => deepEqual(entry, legacy.entry));
  settings.hooks.PreToolUse[index] = oldEntry;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  legacy.entry = oldEntry;
  legacy.shaAfter = sha256(await readText(settingsPath));
  await writeFile(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const upgraded = JSON.parse(await readText(settingsPath));
  expect(upgraded.hooks.PreToolUse.some((entry) => deepEqual(entry, oldEntry))).toBe(false);
  expect(upgraded.hooks.PreToolUse.filter((entry) => deepEqual(entry, newEntry))).toHaveLength(1);
  expect(upgraded.hooks.PreToolUse).toHaveLength(settings.hooks.PreToolUse.length);

  await uninstall({ home });
  expect(await readText(settingsPath)).toBe(original);
});

// Usefulness: verifies #190 — uninstall removes the entry by the locator of a
// legacy `matcher` record. A later user edit rules out the backup restore, so
// only the locator-based removal can succeed.
test("uninstall removes the entry of a legacy matcher record by locator", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, claudeSeed());
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const record = await addLegacyMatcher(home);

  const edited = JSON.parse(await readText(settingsPath));
  edited.theme = "dark";
  await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  const reports = await uninstall({ home });
  expect(reports.find((entry) => entry.path === settingsPath).action).toBe("remove-entry");
  const after = JSON.parse(await readText(settingsPath));
  expect(after.theme).toBe("dark");
  expect(after.hooks.PreToolUse.some((entry) => deepEqual(entry, record.entry))).toBe(false);
  expect(after.hooks.PreToolUse).toEqual(claudeSeed().hooks.PreToolUse);
});
