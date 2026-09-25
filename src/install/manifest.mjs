// The install manifest (#139). One record per touched target, at
// `<home>/.agent-loops/install.json`, so `agent-loop uninstall` can restore the
// pre-install bytes and remove only entries it inserted. The baseline recorded
// by the first install is immutable: later installs carry it forward untouched
// and only uninstall consumes it.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ensureDir,
  readTextOrNull,
  removeDirQuiet,
  removeFileQuiet,
  writeTextAtomic,
} from "./fsutil.mjs";

export const MANIFEST_VERSION = 1;

/**
 * The install home. `AGENT_LOOP_HOME` overrides it so tests never touch the
 * developer's real home directory.
 */
export function resolveHome() {
  const override = process.env.AGENT_LOOP_HOME;
  return override ? resolve(override) : homedir();
}

export function installRoot(home = resolveHome()) {
  return join(home, ".agent-loops");
}

export function manifestPath(home = resolveHome()) {
  return join(installRoot(home), "install.json");
}

export function emptyManifest() {
  return { version: MANIFEST_VERSION, harnesses: {} };
}

/** True for a JSON object, which excludes null and an array. */
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True for a settings locator, so a record's `locator` cannot crash the merge. */
function isLocator(value) {
  if (!isJsonObject(value)) {
    return false;
  }
  if (value.kind === "key") {
    return typeof value.key === "string";
  }
  return (
    value.kind === "array" &&
    Array.isArray(value.path) &&
    value.path.every((key) => typeof key === "string")
  );
}

function unexpectedHarnessRecord(harness, path) {
  return new Error(`Install manifest has an unexpected record for harness "${harness}": ${path}`);
}

/**
 * Rejects a harness record that install or uninstall cannot act on. `files` and
 * `settings` may be absent, but when present every entry must be an object with
 * a string `path`; a settings entry must also carry a valid locator and an
 * entry. `dirs` may be absent, but when present it must be an array of strings.
 */
function assertHarnessRecord(harness, record, path) {
  const fail = () => unexpectedHarnessRecord(harness, path);
  if (!isJsonObject(record)) {
    throw fail();
  }
  if (record.files !== undefined) {
    const valid =
      Array.isArray(record.files) &&
      record.files.every((entry) => isJsonObject(entry) && typeof entry.path === "string");
    if (!valid) {
      throw fail();
    }
  }
  if (record.settings !== undefined) {
    const valid =
      Array.isArray(record.settings) &&
      record.settings.every(
        (entry) =>
          isJsonObject(entry) &&
          typeof entry.path === "string" &&
          isLocator(entry.locator) &&
          Object.hasOwn(entry, "entry"),
      );
    if (!valid) {
      throw fail();
    }
  }
  if (
    record.dirs !== undefined &&
    (!Array.isArray(record.dirs) || record.dirs.some((dir) => typeof dir !== "string"))
  ) {
    throw fail();
  }
}

export async function readManifest(home = resolveHome()) {
  const path = manifestPath(home);
  const text = await readTextOrNull(path);
  if (text === null) {
    return emptyManifest();
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Install manifest is not valid JSON: ${path}`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`Install manifest has an unexpected shape: ${path}`);
  }
  if (value.version !== MANIFEST_VERSION) {
    throw new Error(
      `Install manifest has an unsupported version (${JSON.stringify(value.version)}): ${path}`,
    );
  }
  if (!isJsonObject(value.harnesses)) {
    throw new Error(`Install manifest has an unexpected shape: ${path}`);
  }
  for (const [harness, record] of Object.entries(value.harnesses)) {
    assertHarnessRecord(harness, record, path);
  }
  return { version: MANIFEST_VERSION, harnesses: value.harnesses };
}

export async function writeManifest(home, manifest) {
  const path = manifestPath(home);
  await ensureDir(dirname(path), new Set());
  await writeTextAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Deletes the manifest and its now-empty directory once no harness is recorded. */
export async function removeManifest(home) {
  await removeFileQuiet(manifestPath(home));
  await removeDirQuiet(installRoot(home));
}
