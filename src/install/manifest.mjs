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
    value.path.length > 0 &&
    value.path.every((key) => typeof key === "string")
  );
}

/** True for a value a record holds as a hash or a backup path. */
function isStringOrNull(value) {
  return value === null || typeof value === "string";
}

/** The error for a record whose named field cannot be acted on. */
function unexpectedHarnessRecord(harness, detail, path) {
  return new Error(
    `Install manifest has an unexpected record for harness "${harness}" (${detail}): ${path}`,
  );
}

/**
 * Rejects a `files` entry install or uninstall cannot act on. Uninstall reads
 * `shaAfter`, `existedBefore`, and `backupPath` before any write, so a wrong
 * type there would leave a partial uninstall.
 */
function assertFileRecord(harness, entry, where, path) {
  if (!isJsonObject(entry)) {
    throw unexpectedHarnessRecord(harness, where, path);
  }
  if (typeof entry.path !== "string") {
    throw unexpectedHarnessRecord(harness, `${where}.path`, path);
  }
  if (typeof entry.shaAfter !== "string") {
    throw unexpectedHarnessRecord(harness, `${where}.shaAfter`, path);
  }
  if (!isStringOrNull(entry.shaBefore)) {
    throw unexpectedHarnessRecord(harness, `${where}.shaBefore`, path);
  }
  if (typeof entry.existedBefore !== "boolean") {
    throw unexpectedHarnessRecord(harness, `${where}.existedBefore`, path);
  }
  if (!isStringOrNull(entry.backupPath)) {
    throw unexpectedHarnessRecord(harness, `${where}.backupPath`, path);
  }
}

/** Rejects a `settings` entry, which carries the file fields plus its merge metadata. */
function assertSettingsRecord(harness, entry, where, path) {
  assertFileRecord(harness, entry, where, path);
  if (!isLocator(entry.locator)) {
    throw unexpectedHarnessRecord(harness, `${where}.locator`, path);
  }
  if (!Object.hasOwn(entry, "entry")) {
    throw unexpectedHarnessRecord(harness, `${where}.entry`, path);
  }
  if (typeof entry.userEdited !== "boolean") {
    throw unexpectedHarnessRecord(harness, `${where}.userEdited`, path);
  }
  if (!Number.isInteger(entry.createdFrom)) {
    throw unexpectedHarnessRecord(harness, `${where}.createdFrom`, path);
  }
}

/**
 * Rejects a harness record that install or uninstall cannot act on, naming the
 * first bad field. `files` and `settings` may be absent, but when present every
 * entry must carry the fields uninstall reads; `dirs` may be absent, but when
 * present it must be an array of strings. Every field is checked before any
 * caller writes, so a corrupt field cannot leave a partial install or uninstall.
 */
function assertHarnessRecord(harness, record, path) {
  if (!isJsonObject(record)) {
    throw unexpectedHarnessRecord(harness, "record", path);
  }
  if (record.files !== undefined) {
    if (!Array.isArray(record.files)) {
      throw unexpectedHarnessRecord(harness, "files", path);
    }
    record.files.forEach((entry, index) =>
      assertFileRecord(harness, entry, `files[${index}]`, path),
    );
  }
  if (record.settings !== undefined) {
    if (!Array.isArray(record.settings)) {
      throw unexpectedHarnessRecord(harness, "settings", path);
    }
    record.settings.forEach((entry, index) =>
      assertSettingsRecord(harness, entry, `settings[${index}]`, path),
    );
  }
  if (record.dirs !== undefined) {
    if (!Array.isArray(record.dirs)) {
      throw unexpectedHarnessRecord(harness, "dirs", path);
    }
    record.dirs.forEach((dir, index) => {
      if (typeof dir !== "string") {
        throw unexpectedHarnessRecord(harness, `dirs[${index}]`, path);
      }
    });
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
