// `agent-loop install` / `agent-loop uninstall` (#139). User-scope only: each
// harness gets its entry point and its guard, rendered from the shipped
// templates against the installed package. The manifest records one baseline
// per target; a second install is a no-op, an upgrade replaces only the
// recorded entry, and uninstall restores the pre-install bytes when the file is
// unchanged since install. Guards are applied before entry points, and a failed
// write persists the manifest for the writes that completed and keeps the
// previous record for every target it did not complete, so uninstall can recover
// a partial install or an interrupted upgrade (#156). An exclusive lock
// beside `<home>/.agent-loops` serializes install and uninstall, so concurrent
// read-modify-write of the manifest cannot drop a record, whatever the temp
// root of each process (#193, #198).
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, parse, relative, resolve } from "node:path";
import { readableErrorText } from "../lib/error-message.mjs";
import { logWarn } from "../lib/log.mjs";
import { withStateLock } from "../lib/runstate.mjs";
import {
  backupPathFor,
  ensureDir,
  fileMode,
  pruneEmptyDirs,
  readTextOrNull,
  removeFileQuiet,
  sha256,
  writeTextAtomic,
} from "./fsutil.mjs";
import { HARNESS_META, HARNESS_ORDER } from "../lib/harnesses.mjs";
import { buildTargets } from "./harnesses.mjs";
import {
  manifestLockFile,
  manifestPath,
  readManifest,
  removeManifest,
  resolveHome,
  writeManifest,
} from "./manifest.mjs";
import {
  findEntryIndex,
  insertEntry,
  manualSnippet,
  missingLocatorIndex,
  parseSettings,
  pruneEmptyLocator,
  removeEntry,
  replaceEntry,
  serializeSettings,
  validateLocator,
} from "./settings.mjs";

// `npx` installs the package under `<npm-cache>/_npx/<hash>/node_modules` and
// `pnpm dlx` under `<pnpm-home>/dlx/<hash>/<work>/node_modules`. `bunx` installs
// it under `<tmp>/bunx-<uid>-<package>/node_modules`, and `yarn dlx` into a zip
// under `<tmp>/xfs-<id>/dlx-<pid>/.yarn/cache` that yarn deletes when the command
// ends. `<tmp>` is the system temporary directory, not a runner cache. The
// runner or the OS can delete each directory at any time. A global install, a
// project `node_modules`, and a linked clone all keep a stable package root.
// Observed on macOS with bun 1.2.20 and yarn 4.9.2, and on Windows 11 with bun
// 1.3.8 and yarn 4.9.2 (#207). yarn 1.22.22 has no `dlx` command, and its
// `create` command installed a probe package under `<home>/.config/yarn/global`,
// a stable root.
// Not verified: Linux (#707), and a `%TEMP%` that is an 8.3 short path or a
// junction (#709).
const EPHEMERAL_CACHE_DIRS = new Set(["_npx", "dlx"]);
const BUNX_TEMP_DIR = /^bunx-\d+-[^@]+@[^@]+$/;
const BUNX_SCOPE_TEMP_DIR = /^bunx-\d+-@[^@]+$/;
const BUNX_SCOPED_VERSION_DIR = /^[^@]+@[^@]+$/;
const YARN_DLX_XFS_DIR = /^xfs-[0-9a-f]+$/;
const YARN_DLX_TEMP_DIR = /^dlx-\d+$/;
const EPHEMERAL_ROOT_MESSAGE =
  "Refusing to install from an npx, pnpm dlx, yarn dlx, or bunx cache: the runner " +
  "or the system can delete it, and the entry points and guards written here would " +
  "then point at missing files. Install globally first (npm install -g " +
  "@andromarces/agent-loops or pnpm add -g @andromarces/agent-loops), then run " +
  "install again.";

const splitPath = (path) => path.split(/[\\/]+/).filter(Boolean);

/** A root and its realpath. */
function withRealpath(root) {
  try {
    return [root, realpathSync(root)];
  } catch {
    return [root];
  }
}

/** The temporary roots: yarn dlx uses `os.tmpdir()`, bunx also uses `/tmp`. */
function temporaryRoots() {
  const yarn = withRealpath(tmpdir());
  return { yarn, bunx: [...yarn, ...withRealpath("/tmp")] };
}

/**
 * True when the package root sits in an npx or pnpm dlx cache (#205): the cache
 * directory, a hash directory, then `node_modules`. On Windows the match folds
 * case, because an existing `_NPX` or `DLX` directory keeps its spelling (#625).
 */
function isCacheRoot(packageRoot, platform) {
  const segments = splitPath(platform === "win32" ? packageRoot.toLowerCase() : packageRoot);
  for (let i = 0; i < segments.length - 2; i++) {
    if (!EPHEMERAL_CACHE_DIRS.has(segments[i])) continue;
    if (!/^[0-9a-f]{16,}$/.test(segments[i + 1])) continue;
    if (segments.slice(i + 2).includes("node_modules")) return true;
  }
  return false;
}

/**
 * True when the package root sits in a bunx or yarn dlx layout directly under a
 * temporary root. The layout is `bunx-<uid>-<name>@<version>` (or
 * `bunx-<uid>-@<scope>` then `<name>@<version>`) then `node_modules`, or
 * `xfs-<hex>` then `dlx-<pid>` with `node_modules` below. The same layout under a
 * stable parent does not match (#207).
 */
function isTempRunnerRoot(packageRoot, platform, tempRoots) {
  const fold = platform === "win32" ? (text) => text.toLowerCase() : (text) => text;
  const segments = splitPath(fold(packageRoot));
  const keys = (roots) => roots.map((root) => splitPath(fold(root)).join("/"));
  const bunxRoots = keys(tempRoots.bunx);
  const yarnRoots = keys(tempRoots.yarn);
  const under = (roots, i) => roots.includes(segments.slice(0, i).join("/"));
  return segments.some((segment, i) => {
    const next = segments[i + 1] ?? "";
    if (BUNX_TEMP_DIR.test(segment)) return under(bunxRoots, i) && next === "node_modules";
    if (BUNX_SCOPE_TEMP_DIR.test(segment)) {
      return (
        under(bunxRoots, i) &&
        BUNX_SCOPED_VERSION_DIR.test(next) &&
        segments[i + 2] === "node_modules"
      );
    }
    if (YARN_DLX_XFS_DIR.test(segment)) {
      return (
        under(yarnRoots, i) &&
        YARN_DLX_TEMP_DIR.test(next) &&
        segments.slice(i + 2).includes("node_modules")
      );
    }
    return false;
  });
}

/**
 * True when the package root resolves inside an npx, pnpm dlx, yarn dlx, or bunx
 * temporary layout. On Windows every match compares case-insensitively.
 * @param {string} packageRoot
 * @param {NodeJS.Platform} [platform]
 * @param {{ bunx: string[], yarn: string[] }} [tempRoots] Temporary roots to compare against, for tests.
 */
export function isEphemeralPackageRoot(
  packageRoot,
  platform = process.platform,
  tempRoots = temporaryRoots(),
) {
  return isCacheRoot(packageRoot, platform) || isTempRunnerRoot(packageRoot, platform, tempRoots);
}

// pnpm resolves a global package into a version-named virtual store entry
// (`.pnpm/<name>@<version>/node_modules/<name>`) and links it to a
// version-independent path, which a global upgrade repoints. pnpm 12 keeps the
// store entry in an install directory's `node_modules` and links that directory
// into the global directory as `<hash>`, the path the bin shim calls. pnpm 10
// keeps `.pnpm` beside its global `node_modules` and links the package under that
// `node_modules`, which `pnpm root -g` reports. Node resolves a module to the
// store entry, which the upgrade replaces, so the store entry must not be written
// into installed files (#305). pnpm 12 links a project install into the global
// virtual store at `store/v11/links/<name>/<version>/<hash>/node_modules/<name>`,
// and that path names a version but no project, so only the script path the bin
// shim calls names the project link (#311).
const VIRTUAL_STORE_DIR = ".pnpm";
const VIRTUAL_STORE_LINKS_DIR = "links";
const VIRTUAL_STORE_MODULES_DIR = "node_modules";

/**
 * The symlink in `dir` that resolves to `target`, or `null`. pnpm 12 keeps one
 * hash-named symlink per install directory beside it, and a global upgrade
 * repoints that symlink at the new install directory. Returns `null` rather than
 * throwing when the target or the directory cannot be read, so a caller can fall
 * back to the next candidate.
 */
function symlinkResolvingTo(dir, target) {
  try {
    const resolved = realpathSync(target);
    for (const name of readdirSync(dir)) {
      const candidate = join(dir, name);
      try {
        if (lstatSync(candidate).isSymbolicLink() && realpathSync(candidate) === resolved) {
          return candidate;
        }
      } catch {
        // A broken or unreadable entry is not the link being looked for.
      }
    }
  } catch {
    // A missing target or an unreadable directory yields no candidate.
  }
  return null;
}

/**
 * `path` with its drive letter upper cased, which is the only case difference
 * Windows ignores in a path. `realpathSync` returns the drive letter spelled as the
 * caller spelled it, so a link reached through a lower-case drive letter would
 * otherwise never compare equal to the same path. Every other character keeps its
 * case on both platforms, and POSIX returns `path` unchanged.
 */
function normalizeDrive(path) {
  return process.platform === "win32"
    ? path.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
    : path;
}

/** True when the two paths name the same location, ignoring only drive letter case. */
function samePath(left, right) {
  return normalizeDrive(left) === normalizeDrive(right);
}

/**
 * The candidate when it resolves to `target`, or `null`. A candidate that does
 * not exist is a normal outcome, since which link a pnpm layout writes differs by
 * version, so each one is checked on its own.
 */
function linkResolvingTo(candidate, target) {
  try {
    return samePath(realpathSync(candidate), realpathSync(target)) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * True when `hashDir` is the `<hash>` level of a pnpm 12 global virtual store
 * entry, which sits below `links/<name>/<version>`. No store entry a project keeps
 * under its own `.pnpm` carries a bare hex hash name, so the two shapes never
 * collide.
 */
function isVirtualStoreLinkEntry(hashDir) {
  if (!/^[0-9a-f]{16,}$/.test(basename(hashDir))) {
    return false;
  }
  for (let dir = dirname(hashDir); dir !== dirname(dir); dir = dirname(dir)) {
    if (basename(dir) === VIRTUAL_STORE_LINKS_DIR) {
      return true;
    }
  }
  return false;
}

/**
 * The package name as the segments `basename` produces, so a scoped name such as
 * `@scope/name` counts as two. The name is a relative fragment, so it is peeled one
 * `basename` at a time until nothing is left rather than walked with `dirname`,
 * which would report `.` forever.
 */
function nameSegments(name) {
  const parts = [];
  for (let rest = name; rest && rest !== "."; rest = dirname(rest)) {
    parts.unshift(basename(rest));
    if (basename(rest) === rest) {
      break;
    }
  }
  return parts;
}

/**
 * True when `dir` ends in `node_modules/<parts>`, walking up one `basename` per
 * part so a scoped name and the `node_modules` level are both matched by segment.
 */
function isNodeModulesLink(dir, parts) {
  let cursor = dir;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (basename(cursor) !== parts[i]) {
      return false;
    }
    cursor = dirname(cursor);
  }
  return basename(cursor) === VIRTUAL_STORE_MODULES_DIR;
}

/**
 * The `<project>/node_modules/<name>` link the invocation path names, or `null`.
 *
 * The walk uses the platform `path` functions, so it stops at the root `parse`
 * reports and a Windows UNC root, a Windows drive letter, and a backslash inside a
 * POSIX directory name are all handled by the platform rather than by string
 * handling here. The deepest directory that ends in `node_modules/<name>` and
 * resolves to this same package wins, since a nested dependency is reached through
 * the innermost link. A path naming no such link, or naming only links that resolve
 * elsewhere, yields nothing so the caller falls back to the resolved package root.
 */
function projectLinkFor(scriptPath, packageRoot, name) {
  if (typeof scriptPath !== "string" || scriptPath === "") {
    return null;
  }
  const parts = nameSegments(name);
  const { root } = parse(resolve(scriptPath));
  for (let dir = dirname(resolve(scriptPath)); ; dir = dirname(dir)) {
    if (isNodeModulesLink(dir, parts) && !samePath(dir, packageRoot)) {
      const linked = linkResolvingTo(dir, packageRoot);
      if (linked) {
        // Normalized so the rendered path does not depend on the drive letter case
        // the caller happened to use to reach the project.
        return normalizeDrive(linked);
      }
    }
    if (dir === root) {
      return null;
    }
  }
}

/**
 * The version-independent package root to render into installed files. A pnpm 12
 * project layout yields the project link, which only `scriptPath` names. A pnpm 12
 * global layout yields the hash-named symlink the bin shim calls. A pnpm 10 layout
 * yields the link under the `node_modules` beside its virtual store directory.
 * Every one of them is repointed by an upgrade. Every other layout (an npm global
 * install, a clone, a linked package) has no version in its root and returns
 * `packageRoot` unchanged, as does a layout with no link that resolves to this same
 * package.
 */
export function stablePackageRoot(packageRoot, scriptPath) {
  // Two levels up is the store entry's `node_modules`, and two more is the `.pnpm`
  // directory holding that entry. The `node_modules` a pnpm layout links the
  // package under is either that directory (pnpm 12, a project install) or a
  // sibling of it (a pnpm 10 global install), so both are candidates.
  const store = dirname(dirname(packageRoot));
  const pnpmDir = dirname(dirname(store));
  if (basename(store) !== "node_modules") {
    return packageRoot;
  }
  const tail = relative(store, packageRoot);
  // A pnpm 12 project install resolves into the global virtual store, where the
  // entry carries the version and no `.pnpm` directory names it. No candidate below
  // applies there, so the project link comes from the script path.
  if (isVirtualStoreLinkEntry(dirname(store))) {
    return projectLinkFor(scriptPath, packageRoot, tail) ?? packageRoot;
  }
  if (basename(pnpmDir) !== VIRTUAL_STORE_DIR) {
    return packageRoot;
  }
  const pnpmParent = dirname(pnpmDir);
  // pnpm 12 keeps `.pnpm` inside the install directory's `node_modules` and links
  // that directory into the global directory under a hash name, which the bin
  // shim calls. pnpm 10 keeps `.pnpm` beside its `node_modules` and has no such
  // link, so the scan runs only in the pnpm 12 shape.
  const installDir = basename(pnpmParent) === "node_modules" ? dirname(pnpmParent) : null;
  const hashLink = installDir && symlinkResolvingTo(dirname(installDir), installDir);
  for (const candidate of [
    hashLink && join(hashLink, basename(store), tail),
    // The `node_modules` holding `.pnpm`. A pnpm 10 project install reaches it
    // directly, and a pnpm 12 global install reaches it only when no hash link
    // resolves, since the first candidate above wins whenever one does.
    join(pnpmParent, tail),
    // pnpm 10: the `node_modules` beside the `.pnpm` directory.
    join(pnpmParent, basename(store), tail),
  ]) {
    const resolved = candidate && linkResolvingTo(candidate, packageRoot);
    if (resolved) {
      return resolved;
    }
  }
  return packageRoot;
}

function planBackup(target, previous, current) {
  const existedBefore = previous ? previous.existedBefore : current !== null;
  const backupPath = previous?.backupPath ?? null;
  const backup =
    existedBefore && !backupPath && current !== null
      ? { path: backupPathFor(target.path), content: current }
      : null;
  return { existedBefore, backupPath, backup };
}

async function planFileWrite(target, previous) {
  const current = await readTextOrNull(target.path);
  const currentSha = current === null ? null : sha256(current);
  const desiredSha = sha256(target.content);

  if (previous && currentSha !== null && currentSha !== previous.shaAfter) {
    if (currentSha === desiredSha) {
      return { kind: "file", action: "noop", path: target.path, record: previous };
    }
    return {
      kind: "file",
      action: "skip",
      path: target.path,
      detail: "owned file changed since install; left unchanged",
      record: previous,
    };
  }

  if (currentSha === desiredSha) {
    const record = previous ?? {
      kind: "file",
      path: target.path,
      existedBefore: current !== null,
      shaBefore: currentSha,
      shaAfter: desiredSha,
      backupPath: null,
    };
    return { kind: "file", action: "noop", path: target.path, record };
  }

  const { existedBefore, backupPath, backup } = planBackup(target, previous, current);
  return {
    kind: "file",
    action: existedBefore ? "update" : "create",
    path: target.path,
    content: target.content,
    backup,
    record: {
      kind: "file",
      path: target.path,
      existedBefore,
      shaBefore: previous ? previous.shaBefore : currentSha,
      shaAfter: desiredSha,
      backupPath: backup ? backup.path : backupPath,
    },
  };
}

async function planSettingsWrite(target, previous) {
  const current = await readTextOrNull(target.path);
  const currentSha = current === null ? null : sha256(current);
  const snippet = manualSnippet(target.path, target.locator, target.entry);

  let settings;
  try {
    settings = current === null ? {} : parseSettings(current, target.path);
  } catch (err) {
    return {
      kind: "settings",
      action: "refuse",
      path: target.path,
      detail: readableErrorText(err),
      snippet,
    };
  }

  const shape = validateLocator(settings, target.locator);
  if (!shape.ok) {
    return {
      kind: "settings",
      action: "refuse",
      path: target.path,
      detail: `settings file has an unexpected shape: ${shape.reason}`,
      snippet,
    };
  }

  let createdFrom = previous?.createdFrom;
  if (previous) {
    if (findEntryIndex(settings, previous.locator, previous.entry) === -1) {
      return {
        kind: "settings",
        action: "skip",
        path: target.path,
        detail: "recorded entry not found; the user changed or removed it",
        snippet,
        record: previous,
      };
    }
    replaceEntry(settings, target.locator, previous.entry, target.entry);
  } else {
    createdFrom = missingLocatorIndex(settings, target.locator);
    const result = insertEntry(settings, target.locator, target.entry);
    if (result.status === "conflict") {
      return {
        kind: "settings",
        action: "skip",
        path: target.path,
        detail: "the named hook group already exists with different content",
        snippet,
      };
    }
    if (result.status === "duplicate") {
      // The exact guard entry is already present but unowned. The guard is
      // installed, so do not block the entry point; leave the entry unrecorded
      // and uninstall never removes it.
      return {
        kind: "settings",
        action: "noop",
        path: target.path,
        detail: "an identical guard entry is already present; left unowned",
      };
    }
  }

  const text = serializeSettings(settings, current);
  const desiredSha = sha256(text);

  if (currentSha === desiredSha) {
    // No write: the current bytes already carry the desired entry. Keep the
    // previous record, because its post-install hash may not match a file the
    // user edited since install; advancing the hash would make uninstall treat
    // those edits as installer-owned and restore the backup over them.
    return {
      kind: "settings",
      action: "noop",
      path: target.path,
      record: previous ?? undefined,
    };
  }

  const { existedBefore, backupPath, backup } = planBackup(target, previous, current);
  // A write that starts from bytes other than the recorded post-install hash
  // includes user edits. Mark the record so uninstall removes only the entry
  // instead of restoring the backup over them.
  const userEdited =
    Boolean(previous && previous.shaAfter !== currentSha) || Boolean(previous?.userEdited);
  const record = {
    kind: "settings",
    path: target.path,
    locator: target.locator,
    entry: target.entry,
    existedBefore,
    shaBefore: previous ? previous.shaBefore : currentSha,
    shaAfter: desiredSha,
    backupPath: backup ? backup.path : backupPath,
    userEdited,
    createdFrom: createdFrom ?? 0,
  };

  return {
    kind: "settings",
    action: existedBefore ? "update" : "create",
    path: target.path,
    content: text,
    backup,
    record,
  };
}

async function applyWrite(plan, { dryRun, dirs, write }) {
  if (dryRun || !plan.content) {
    return;
  }
  await ensureDir(dirname(plan.path), dirs);
  const mode = (await fileMode(plan.path)) ?? undefined;
  if (plan.backup) {
    await write(plan.backup.path, plan.backup.content, { mode });
  }
  try {
    await write(plan.path, plan.content, { mode });
  } catch (err) {
    // The target kept its original bytes, so the backup just written is
    // unneeded. Remove it before the error propagates.
    if (plan.backup) {
      await removeFileQuiet(plan.backup.path);
    }
    throw err;
  }
}

function report(harness, plan) {
  return {
    harness,
    kind: plan.kind,
    action: plan.action,
    path: plan.path,
    ...(plan.detail ? { detail: plan.detail } : {}),
    ...(plan.snippet ? { snippet: plan.snippet } : {}),
  };
}

/**
 * Adds the previous record for every target without a record yet. A failed
 * install leaves the bytes those targets held before, so uninstall must keep
 * owning them (#156).
 */
function keepPriorRecords(records, targets, priorRecords) {
  for (const target of targets) {
    if (records.some((record) => record.path === target.path)) {
      continue;
    }
    const prior = priorRecords?.find((record) => record.path === target.path);
    if (prior) {
      records.push(prior);
    }
  }
}

/**
 * Installs one or more harnesses at user scope under the manifest lock. A dry
 * run takes no lock and writes nothing.
 * @returns {Promise<Array<{harness: string, kind: string, action: string, path: string, detail?: string, snippet?: string}>>}
 */
export async function install(options = {}) {
  const home = options.home ?? resolveHome();
  if (typeof options.packageRoot === "string" && isEphemeralPackageRoot(options.packageRoot)) {
    throw new Error(EPHEMERAL_ROOT_MESSAGE);
  }
  if (options.dryRun) {
    return runInstall(options);
  }
  return withStateLock(manifestLockFile(home), () => runInstall(options), {
    label: "The install manifest",
    noun: "install manifest",
  });
}

/** Runs the install once the caller owns the manifest lock, or for a dry run. */
async function runInstall({
  harnesses,
  home = resolveHome(),
  packageRoot,
  copilotHome = process.env.COPILOT_HOME,
  dryRun = false,
  write = writeTextAtomic,
} = {}) {
  const manifest = await readManifest(home);
  const plans = [];
  let refusal = null;

  // Plan every write before any write. An unparseable settings file stops the
  // command with no write at all.
  for (const harness of harnesses) {
    const targets = await buildTargets(harness, { home, packageRoot, copilotHome });
    const previous = manifest.harnesses[harness] ?? null;
    const entry = {
      harness,
      previous,
      dirs: new Set(previous?.dirs ?? []),
      files: [],
      settings: [],
    };
    for (const file of targets.files) {
      const prior = previous?.files?.find((record) => record.path === file.path) ?? null;
      entry.files.push({ path: file.path, plan: await planFileWrite(file, prior) });
    }
    for (const target of targets.settings) {
      const prior = previous?.settings?.find((record) => record.path === target.path) ?? null;
      const plan = await planSettingsWrite(target, prior);
      if (plan.action === "refuse" && !refusal) {
        refusal = plan;
      }
      entry.settings.push({ path: target.path, plan });
    }

    // No harness installs an entry point without its guard. When a settings
    // target cannot be merged (a conflicting key, or a recorded entry the user
    // removed), leave every entry-point file for that harness unchanged.
    const guardBlocked = entry.settings.some(
      ({ plan }) => plan.action === "skip" || plan.action === "refuse",
    );
    if (guardBlocked) {
      entry.files = entry.files.map(({ path }) => {
        const prior = previous?.files?.find((record) => record.path === path) ?? null;
        return {
          path,
          plan: {
            kind: "file",
            action: "skip",
            path,
            detail: "guard settings were not installed; entry point left unchanged",
            record: prior ?? undefined,
          },
        };
      });
    }
    plans.push(entry);
  }

  if (refusal && !dryRun) {
    const error = new Error(refusal.detail);
    error.path = refusal.path;
    error.snippet = refusal.snippet;
    throw error;
  }

  const reports = [];
  let active = null;
  try {
    for (const entry of plans) {
      active = entry;
      const record = { files: [], settings: [], dirs: entry.previous?.dirs ?? [] };
      // Record the harness before its first write. A failure mid-harness then
      // still leaves a manifest record that uninstall can act on.
      if (!dryRun) {
        manifest.harnesses[entry.harness] = record;
      }
      // Guard settings first: an entry point never lands without its guard,
      // even when a later write fails.
      for (const { plan } of entry.settings) {
        await applyWrite(plan, { dryRun, dirs: entry.dirs, write });
        if (plan.record) {
          record.settings.push(plan.record);
        }
        reports.push(report(entry.harness, plan));
      }
      for (const { plan } of entry.files) {
        await applyWrite(plan, { dryRun, dirs: entry.dirs, write });
        if (plan.record) {
          record.files.push(plan.record);
        }
        reports.push(report(entry.harness, plan));
      }
      record.dirs = [...entry.dirs];
      active = null;
    }
  } catch (err) {
    if (!dryRun) {
      // Persist the completed writes before the error propagates, so uninstall
      // restores every file this partial install touched, including the
      // completed writes of earlier harnesses.
      if (active) {
        const record = manifest.harnesses[active.harness];
        if (record) {
          record.dirs = [...active.dirs];
          // A target this install did not complete, including one an upgrade
          // never reached, keeps its previous record so uninstall still owns
          // the bytes the failed install left in place.
          keepPriorRecords(record.settings, active.settings, active.previous?.settings);
          keepPriorRecords(record.files, active.files, active.previous?.files);
        }
      }
      await writeManifest(home, manifest).catch((saveError) => {
        logWarn(
          `install failed and the manifest could not be saved (${saveError.message}); ` +
            "uninstall cannot undo the completed writes",
        );
      });
    }
    throw err;
  }

  // Codex notes precede Claude notes whatever order the harnesses were selected in.
  for (const harness of [...HARNESS_ORDER].reverse()) {
    if (!harnesses.includes(harness)) {
      continue;
    }
    for (const note of HARNESS_META[harness].notes ?? []) {
      if (dryRun && !note.dryRun) {
        continue;
      }
      reports.push({
        harness,
        kind: "settings",
        action: "note",
        path: join(home, ...note.path),
        detail: note.detail,
      });
    }
  }

  if (!dryRun) {
    await writeManifest(home, manifest);
  }
  return reports;
}

function uninstallReport(record, kind, action, detail) {
  const report = { harness: record.harness, kind, action, path: record.path };
  if (detail !== undefined) {
    report.detail = detail;
  }
  return report;
}

async function restoreOrDelete(record, kind, dryRun) {
  if (record.existedBefore) {
    const backupFile = record.backupPath ?? backupPathFor(record.path);
    const backup = await readTextOrNull(backupFile, { notDirIsMissing: true });
    if (backup === null) {
      return uninstallReport(record, kind, "skip", "backup missing; left unchanged");
    }
    if (!dryRun) {
      await writeTextAtomic(record.path, backup, {
        mode: (await fileMode(backupFile)) ?? undefined,
      });
      await removeFileQuiet(backupFile);
    }
    return uninstallReport(record, kind, "restore");
  }
  if (!dryRun) {
    await removeFileQuiet(record.path);
  }
  return uninstallReport(record, kind, "delete");
}

async function planSettingsRestore(record, dryRun) {
  const current = await readTextOrNull(record.path, { notDirIsMissing: true });
  if (current === null) {
    return uninstallReport(record, "settings", "missing");
  }
  const currentSha = sha256(current);

  if (currentSha === record.shaAfter && !record.userEdited) {
    return restoreOrDelete(record, "settings", dryRun);
  }

  let settings;
  try {
    settings = parseSettings(current, record.path);
  } catch {
    return uninstallReport(record, "settings", "skip", "settings do not parse; left unchanged");
  }
  if (!removeEntry(settings, record.locator, record.entry)) {
    return uninstallReport(record, "settings", "skip", "recorded entry not found; left unchanged");
  }
  pruneEmptyLocator(settings, record.locator, record.createdFrom ?? 0);
  if (!record.existedBefore && Object.keys(settings).length === 0) {
    // Install created this file and the user edited nothing else, so removing
    // the entry empties it. Delete it instead of leaving `{}`.
    if (!dryRun) {
      await removeFileQuiet(record.path);
    }
    return uninstallReport(record, "settings", "delete");
  }
  if (!dryRun) {
    await writeTextAtomic(record.path, serializeSettings(settings, current));
  }
  return uninstallReport(
    record,
    "settings",
    "remove-entry",
    "the file changed after install; removed only the recorded entry, so the result is not byte-identical",
  );
}

async function planFileRestore(record, dryRun) {
  const current = await readTextOrNull(record.path, { notDirIsMissing: true });
  if (current === null) {
    return uninstallReport(record, "file", "missing");
  }
  if (sha256(current) !== record.shaAfter) {
    return uninstallReport(
      record,
      "file",
      "skip",
      "owned file changed since install; left unchanged",
    );
  }
  return restoreOrDelete(record, "file", dryRun);
}

/**
 * Removes every target the manifest records for the selected harnesses under
 * the manifest lock. A dry run takes no lock and writes nothing. If lstat of the
 * home reports ENOENT, for any reason, the call takes no lock, reads and writes
 * nothing, reports nothing to remove, and never creates the home. That includes
 * a Windows path that cannot name a directory: no install can exist there, so no
 * data is lost, and it no longer raises the origin/main error (maintainer
 * decision, issue #570). An install that creates the home after that check runs
 * after this uninstall returned, as if the uninstall had come first. Any other
 * lstat error takes the locked path, so no branch mutates without the lock.
 */
export async function uninstall(options = {}) {
  const home = options.home ?? resolveHome();
  if (homeIsMissing(home)) {
    return [];
  }
  if (options.dryRun) {
    return runUninstall(options);
  }
  return withStateLock(manifestLockFile(home), () => runUninstall(options), {
    label: "The install manifest",
    noun: "install manifest",
  });
}

function homeIsMissing(home) {
  try {
    lstatSync(home);
    return false;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}

/** Runs the uninstall once the caller owns the manifest lock, or for a dry run. */
async function runUninstall({ harnesses, home = resolveHome(), dryRun = false } = {}) {
  const manifest = await readManifest(home);
  const selected = (harnesses ?? HARNESS_ORDER).filter((harness) => manifest.harnesses[harness]);
  const reports = [];

  for (const harness of selected) {
    const record = manifest.harnesses[harness];
    for (const settings of record.settings ?? []) {
      reports.push(await planSettingsRestore({ ...settings, harness }, dryRun));
    }
    for (const file of record.files ?? []) {
      reports.push(await planFileRestore({ ...file, harness }, dryRun));
    }
    if (!dryRun) {
      let pruned;
      try {
        pruned = await pruneEmptyDirs(record.dirs ?? []);
      } catch (err) {
        // The file and settings targets above were already restored or
        // deleted, so keep only the directory list. Their stale records would
        // make the next install read a missing recorded entry and skip the
        // whole harness, while the directory still needs a later retry.
        manifest.harnesses[harness] = { dirs: record.dirs ?? [] };
        reports.push({
          harness,
          kind: "dir",
          action: "failed",
          path: err.path,
          detail:
            `the directory could not be removed (${err.code}); ` +
            "kept for a later uninstall to retry",
        });
        continue;
      }
      for (const dir of pruned.notDirs) {
        reports.push({
          harness,
          kind: "dir",
          action: "skip",
          path: dir,
          detail: "not a directory; left in place",
        });
      }
      // A record kept only for its directories has no file or settings report,
      // so name each directory this retry removed, or the cleared record when
      // none remained, instead of printing nothing.
      if ((record.files ?? []).length === 0 && (record.settings ?? []).length === 0) {
        for (const dir of pruned.removed) {
          reports.push({ harness, kind: "dir", action: "delete", path: dir });
        }
        if (pruned.removed.length === 0 && pruned.notDirs.length === 0) {
          reports.push({
            harness,
            kind: "record",
            action: "clear",
            path: manifestPath(home),
            detail: "record kept only for directories; none left to remove",
          });
        }
      }
    }
    delete manifest.harnesses[harness];
  }

  if (!dryRun) {
    if (Object.keys(manifest.harnesses).length === 0) {
      await removeManifest(home);
    } else {
      await writeManifest(home, manifest);
    }
  }
  return reports;
}

function executableCandidates(command) {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
      if (await exists(join(dir, candidate))) {
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
