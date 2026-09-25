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

export async function readManifest(home = resolveHome()) {
  const text = await readTextOrNull(manifestPath(home));
  if (text === null) {
    return emptyManifest();
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Install manifest is not valid JSON: ${manifestPath(home)}`);
  }
  if (value === null || typeof value !== "object" || typeof value.harnesses !== "object") {
    throw new Error(`Install manifest has an unexpected shape: ${manifestPath(home)}`);
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
