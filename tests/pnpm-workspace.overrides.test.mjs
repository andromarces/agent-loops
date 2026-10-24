import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const KEYS = ["vite", "vitest"];

/** Reads the flat `overrides:` map of `pnpm-workspace.yaml` without a YAML parser. */
function readOverrides(yaml) {
  const block = yaml.match(/^overrides:\r?\n((?:[ \t]+.*\r?\n?)+)/m)?.[1] ?? "";
  const overrides = {};
  for (const line of block.split(/\r?\n/)) {
    const entry = line.match(/^\s+([\w@/.-]+):\s*(\S+)\s*$/);
    if (entry) overrides[entry[1]] = entry[2];
  }
  return overrides;
}

// Requirement: a vite-plus bump with stale overrides must fail CI (issue #1027).
// Not redundant: no other check compares the pinned overrides to the installed vite-plus.
test("pnpm-workspace overrides match the vite and vitest that vite-plus depends on", async () => {
  const overrides = readOverrides(await readFile(root("pnpm-workspace.yaml"), "utf8"));
  const { version, dependencies } = JSON.parse(
    await readFile(root("node_modules/vite-plus/package.json"), "utf8"),
  );
  const drift = KEYS.filter((key) => overrides[key] !== dependencies[key]).map(
    (key) =>
      `  ${key}: pnpm-workspace.yaml has "${overrides[key]}", vite-plus@${version} depends on "${dependencies[key]}"`,
  );
  expect(
    drift,
    `Stale overrides in pnpm-workspace.yaml:\n${drift.join("\n")}\n` +
      "Fix: set each override to the vite-plus value above, run `pnpm install`, and commit the lockfile.",
  ).toEqual([]);
});

// Requirement: the override reader returns the pinned values from the workspace file.
// Not redundant: guards the parser, so a format change cannot turn the drift check into a no-op.
test("readOverrides reads both pins from the workspace file format", () => {
  const yaml = "virtualStoreType: global\n\noverrides:\n  vite: npm:x@1.0.0\n  vitest: 5.0.5\n";
  expect(readOverrides(yaml)).toEqual({ vite: "npm:x@1.0.0", vitest: "5.0.5" });
});
