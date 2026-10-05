import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main as cliMain } from "../../src/cli.mjs";
import { sha256 } from "../../src/install/fsutil.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { manifestPath } from "../../src/install/manifest.mjs";
import { restoreAgentLoopHome } from "../runtime-helpers.mjs";
import { PACKAGE_ROOT, makeHome, cleanupHomes, writeJson, readText } from "./install-helpers.mjs";

afterEach(cleanupHomes);

// Usefulness: verifies #157 — readManifest rejects an unsupported version, a
// null or array `harnesses`, and a malformed harness record with a clear error,
// and neither install nor uninstall changes a file when the manifest is invalid.
test("a malformed manifest stops install and uninstall with no file change", async () => {
  const malformed = [
    {
      label: "unsupported version",
      value: { version: 2, harnesses: {} },
      message: /unsupported version/,
    },
    {
      label: "null harnesses",
      value: { version: 1, harnesses: null },
      message: /unexpected shape/,
    },
    {
      label: "array harnesses",
      value: { version: 1, harnesses: [] },
      message: /unexpected shape/,
    },
    {
      label: "non-object harness record",
      value: { version: 1, harnesses: { claude: "x" } },
      message: /unexpected record for harness "claude"/,
    },
    {
      label: "non-array files record",
      value: { version: 1, harnesses: { claude: { files: "x" } } },
      message: /unexpected record for harness "claude"/,
    },
    {
      label: "file entry without a path",
      value: { version: 1, harnesses: { claude: { files: [{}] } } },
      message: /unexpected record for harness "claude"/,
    },
    {
      label: "settings entry without a locator",
      value: {
        version: 1,
        harnesses: {
          claude: {
            settings: [
              {
                path: "x",
                shaAfter: "h",
                shaBefore: null,
                existedBefore: false,
                backupPath: null,
                entry: {},
                userEdited: false,
                createdFrom: 0,
              },
            ],
          },
        },
      },
      message: /settings\[0\]\.locator/,
    },
    {
      label: "non-array dirs record",
      value: { version: 1, harnesses: { claude: { dirs: 5 } } },
      message: /unexpected record for harness "claude"/,
    },
    {
      label: "file record with a non-string shaAfter",
      value: {
        version: 1,
        harnesses: {
          claude: {
            files: [
              { path: "x", shaAfter: 5, shaBefore: null, existedBefore: false, backupPath: null },
            ],
          },
        },
      },
      message: /files\[0\]\.shaAfter/,
    },
    {
      label: "file record with a non-boolean existedBefore",
      value: {
        version: 1,
        harnesses: {
          claude: {
            files: [
              { path: "x", shaAfter: "h", shaBefore: null, existedBefore: "no", backupPath: null },
            ],
          },
        },
      },
      message: /files\[0\]\.existedBefore/,
    },
    {
      label: "file record with a non-string backupPath",
      value: {
        version: 1,
        harnesses: {
          claude: {
            files: [
              { path: "x", shaAfter: "h", shaBefore: null, existedBefore: false, backupPath: {} },
            ],
          },
        },
      },
      message: /files\[0\]\.backupPath/,
    },
    {
      label: "settings record with a non-integer createdFrom",
      value: {
        version: 1,
        harnesses: {
          claude: {
            settings: [
              {
                path: "x",
                shaAfter: "h",
                shaBefore: null,
                existedBefore: false,
                backupPath: null,
                locator: { kind: "key", key: "k" },
                entry: {},
                userEdited: false,
                createdFrom: 1.5,
              },
            ],
          },
        },
      },
      message: /settings\[0\]\.createdFrom/,
    },
    {
      label: "settings record with an empty array locator path",
      value: {
        version: 1,
        harnesses: {
          claude: {
            settings: [
              {
                path: "x",
                shaAfter: "h",
                shaBefore: null,
                existedBefore: false,
                backupPath: null,
                locator: { kind: "array", path: [] },
                entry: {},
                userEdited: false,
                createdFrom: 0,
              },
            ],
          },
        },
      },
      message: /settings\[0\]\.locator/,
    },
  ];

  for (const { label, value, message } of malformed) {
    const home = await makeHome();
    await writeJson(manifestPath(home), value);
    const manifestBefore = await readText(manifestPath(home));
    const settingsPath = join(home, ".claude", "settings.json");
    const skillPath = join(home, ".claude", "skills", "agent-loop", "SKILL.md");
    const sentinel = join(home, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");

    const installError = await install({
      harnesses: ["claude"],
      home,
      packageRoot: PACKAGE_ROOT,
    }).then(
      () => null,
      (err) => err,
    );
    expect(installError, label).toBeInstanceOf(Error);
    expect(installError.message, label).toMatch(message);

    const uninstallError = await uninstall({ home }).then(
      () => null,
      (err) => err,
    );
    expect(uninstallError, label).toBeInstanceOf(Error);
    expect(uninstallError.message, label).toMatch(message);

    expect(existsSync(settingsPath), label).toBe(false);
    expect(existsSync(skillPath), label).toBe(false);
    expect(await readText(manifestPath(home)), label).toBe(manifestBefore);
    expect(await readText(sentinel), label).toBe("keep\n");
  }
});

// Usefulness: verifies #157 — the uninstall CLI reports a clear manifest error
// and exits 1 instead of surfacing an unhandled rejection, so a corrupted
// manifest is actionable.
test("CLI uninstall reports a malformed manifest and exits 1", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  await writeJson(manifestPath(home), { version: 9, harnesses: {} });

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (message) => logs.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain(["uninstall", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("unsupported version");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies #157 Finding 1 — a record that passes a shallow check
// must not let uninstall change an earlier file and then fail on a malformed
// field. A valid delete record for `a.txt` precedes a record for `b.txt` whose
// backupPath is not a string; readManifest must reject the whole manifest before
// uninstall removes `a.txt`, so a malformed manifest leaves every file as it was.
test("a malformed record field stops uninstall before it changes any file", async () => {
  const home = await makeHome();
  const a = join(home, "a.txt");
  const b = join(home, "b.txt");
  await writeFile(a, "a\n", "utf8");
  await writeFile(b, "b\n", "utf8");
  const record = (path, content, overrides = {}) => ({
    kind: "file",
    path,
    existedBefore: false,
    shaBefore: null,
    shaAfter: sha256(content),
    backupPath: null,
    ...overrides,
  });
  await writeJson(manifestPath(home), {
    version: 1,
    harnesses: {
      claude: {
        files: [
          record(a, "a\n"),
          record(b, "b\n", {
            existedBefore: true,
            shaBefore: sha256("b\n"),
            backupPath: {},
          }),
        ],
      },
    },
  });
  const manifestBefore = await readText(manifestPath(home));

  const error = await uninstall({ home }).then(
    () => null,
    (err) => err,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/backupPath/);
  expect(await readText(a)).toBe("a\n");
  expect(await readText(b)).toBe("b\n");
  expect(await readText(manifestPath(home))).toBe(manifestBefore);
});

// Usefulness: verifies #477 stays scoped to uninstall — an unreadable manifest
// location (a regular file where `.agent-loops` should be a directory) must stop
// install before any harness write, so no write is left without a manifest.
// Windows reports ENOENT for this layout, so the read cannot tell it from a fresh home.
test.skipIf(process.platform === "win32")(
  "install fails before any harness write when the manifest parent is a regular file",
  async () => {
    const home = await makeHome();
    await writeFile(join(home, ".agent-loops"), "user data\n", "utf8");

    await expect(
      install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT }),
    ).rejects.toThrow();

    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(await readText(join(home, ".agent-loops"))).toBe("user data\n");
  },
);
