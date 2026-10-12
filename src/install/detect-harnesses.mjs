// Finds the harnesses whose CLI is on PATH (#365, #376).
import { readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { HARNESS_META, HARNESS_ORDER } from "../lib/harnesses.mjs";
import { pathExists } from "./fsutil.mjs";

function executableCandidates(command) {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

// Lists a directory once per detectHarnesses call, as a set of lowercase names. A directory that does not
// exist lists as empty. A directory that fails to list for another reason (execute without read) lists
// as null, and the caller probes it name by name.
function directoryLister() {
  const listings = new Map();
  return (dir) => {
    if (!listings.has(dir)) {
      listings.set(
        dir,
        readdir(dir).then(
          (names) => new Set(names.map((name) => name.toLowerCase())),
          (error) => (error?.code === "ENOENT" || error?.code === "ENOTDIR" ? new Set() : null),
        ),
      );
    }
    return listings.get(dir);
  };
}

// Walks PATH in order and stops at the first match. The listing only skips names that cannot exist: it
// folds case, so a case-insensitive file system loses no match, and each listed name is still confirmed
// with a lookup, so a dangling link does not count. One listing per PATH entry replaces one probe per
// PATH entry x PATHEXT x command, which took seconds on a loaded Windows host (#376).
async function onPath(command, path, list) {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const names = await list(dir);
    for (const candidate of executableCandidates(command)) {
      if (names && !names.has(candidate.toLowerCase())) {
        continue;
      }
      if (await pathExists(join(dir, candidate))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Harnesses whose CLI is found on PATH, in registry order. Harnesses are
 * scanned concurrently over one shared directory listing per PATH entry, so
 * the scan stays short on a long PATH or a loaded machine (#365, #376). `path`
 * overrides `process.env.PATH`.
 */
export async function detectHarnesses({ path = process.env.PATH ?? "" } = {}) {
  const list = directoryLister();
  const found = await Promise.all(
    HARNESS_ORDER.map(async (harness) => {
      for (const command of HARNESS_META[harness].commands) {
        if (await onPath(command, path, list)) {
          return true;
        }
      }
      return false;
    }),
  );
  return HARNESS_ORDER.filter((_, index) => found[index]);
}
