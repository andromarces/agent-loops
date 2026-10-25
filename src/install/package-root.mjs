// Detects an ephemeral package root (npx, pnpm dlx, yarn dlx, bunx) and finds the stable root
// that installed files must name (#205, #207, #305, #311).
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, posix, relative, resolve, win32 } from "node:path";
import { INHERITED_TMPDIR_ENV, readInheritedTmpdirs } from "../lib/inherited-tmpdir.mjs";

// `npx` installs the package under `<npm-cache>/_npx/<hash>/node_modules` and
// `pnpm dlx` under `<pnpm-home>/dlx/<hash>/<work>/node_modules`. `bunx` installs
// it under `<tmp>/bunx-<uid>-<package>/node_modules`, and `yarn dlx` into a zip
// under `<tmp>/xfs-<id>/dlx-<pid>/.yarn/cache` that yarn deletes when the command
// ends. `<tmp>` is the system temporary directory, not a runner cache. The
// runner or the OS can delete each directory at any time. A global install, a
// project `node_modules`, and a linked clone all keep a stable package root.
// Observed on macOS with bun 1.2.20 and yarn 4.9.2, and on Windows 11 with bun
// 1.3.8 (#207). On Windows 11 with yarn 4.9.2, only `%TEMP%\xfs-<hex>\dlx-<pid>`
// was observed, not the `<package>.zip\node_modules\<package>` suffix. On macOS,
// yarn 1.22.22 has no `dlx` command, and its `create` command installed a probe
// package under `<home>/.config/yarn/global`, a stable root.
// Not verified: Linux (#707), and a `%TEMP%` that is a junction (#709). The match compares
// canonical paths, so a link, a `..` segment, or on Windows an 8.3 short segment in the
// package root or a temporary root does not change the result (#962, #1068).
// known-limit: a UNC spelling of a local drive, such as \\127.0.0.1\C$\..., stays distinct
// from C:\... because no realpath maps an administrative share to its drive. Such a package
// root is rare. Add a share-to-drive mapping if one is ever observed (#1068).
const EPHEMERAL_CACHE_DIRS = new Set(["_npx", "dlx"]);
const BUNX_TEMP_DIR = /^bunx-\d+-[^@]+@[^@]+$/;
const BUNX_SCOPE_TEMP_DIR = /^bunx-\d+-@[^@]+$/;
const BUNX_SCOPED_VERSION_DIR = /^[^@]+@[^@]+$/;
const YARN_DLX_XFS_DIR = /^xfs-[0-9a-f]+$/;
const YARN_DLX_TEMP_DIR = /^dlx-\d+$/;
export const EPHEMERAL_ROOT_MESSAGE =
  "Refusing to install from an npx, pnpm dlx, yarn dlx, or bunx cache: the runner " +
  "or the system can delete it, and the entry points and guards written here would " +
  "then point at missing files. Install globally first (npm install -g " +
  "@andromarces/agent-loops or pnpm add -g @andromarces/agent-loops), then run " +
  "install again.";

const splitPath = (path) => path.split(/[\\/]+/).filter(Boolean);

/**
 * The canonical spelling of `path`: the realpath of its deepest existing ancestor joined to the
 * rest, normalized, so a link such as macOS `/var` resolves to `/private/var` and a `..`
 * segment is resolved even when the path does not exist (#962). A path for another platform
 * is only normalized. Returns `null` when a realpath fails for a reason other than a missing
 * path, such as EACCES or ELOOP, so the caller can fail closed. On Windows the native realpath
 * expands an 8.3 short segment, which the JS realpath keeps (#1068).
 */
function canonicalPath(path, platform = process.platform) {
  const pathApi = platform === "win32" ? win32 : posix;
  const realpath = platform === "win32" ? realpathSync.native : realpathSync;
  const normalized = pathApi.normalize(path);
  if (platform !== process.platform) return normalized;
  for (let dir = normalized, tail = ""; ;) {
    try {
      return pathApi.join(realpath(dir), tail);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
    }
    const parent = pathApi.dirname(dir);
    if (parent === dir) return normalized;
    tail = pathApi.join(pathApi.basename(dir), tail);
    dir = parent;
  }
}

/**
 * `path` with each 8.3 short segment replaced by its long name, without resolving a link, so a
 * junction keeps its own spelling (#1068). The long name is the entry of the parent directory
 * with the same file id. A segment that does not exist or cannot be listed stays as it is.
 */
function expandShortSegments(path) {
  const { root } = win32.parse(path);
  let expanded = root;
  for (const segment of splitPath(path.slice(root.length))) {
    expanded = win32.join(expanded, longName(expanded, segment));
  }
  return expanded;
}

function longName(parent, segment) {
  if (!/~\d/.test(segment)) return segment;
  try {
    const id = lstatSync(join(parent, segment), { bigint: true }).ino;
    return (
      readdirSync(parent).find(
        (name) => name !== segment && lstatSync(join(parent, name), { bigint: true }).ino === id,
      ) ?? segment
    );
  } catch {
    return segment;
  }
}

/**
 * The spellings to match: the normalized path, which is what the installer renders into entry
 * points, and its canonical path. A package junction inside a runner layout matches by its own
 * spelling even when its target is stable, and on Windows an 8.3 segment of that spelling expands
 * to its long name. `null` when the canonical path cannot be resolved.
 */
function spellings(path, platform) {
  const canonical = canonicalPath(path, platform);
  if (canonical === null) return null;
  const normalized = (platform === "win32" ? win32 : posix).normalize(path);
  const own =
    platform === "win32" && platform === process.platform
      ? expandShortSegments(normalized)
      : normalized;
  return [...new Set([normalized, own, canonical])];
}

/**
 * The temporary roots: yarn dlx uses `os.tmpdir()`, bunx also uses `/tmp`. A Codex turn replaces
 * `os.tmpdir()` with a private directory, so the temporary directories that the turn inherited
 * count too (issue #955).
 */
function temporaryRoots() {
  const { valid, paths } = readInheritedTmpdirs();
  const yarn = [tmpdir(), ...paths];
  // An invalid list hides the ancestors, so `invalid` makes the check refuse every root.
  return { yarn, bunx: [...yarn, "/tmp"], invalid: !valid };
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
 * A path that cannot be canonicalized (a realpath error other than a missing path) is refused.
 * @param {NodeJS.Platform} [platform]
 * @param {{ bunx: string[], yarn: string[], invalid?: boolean }} [tempRoots] Temporary roots to compare against, for tests. `invalid` refuses every root.
 */
export function isEphemeralPackageRoot(
  packageRoot,
  platform = process.platform,
  tempRoots = temporaryRoots(),
) {
  if (tempRoots.invalid === true) return true;
  const packageSpellings = spellings(packageRoot, platform);
  const bunx = tempRoots.bunx.map((root) => spellings(root, platform));
  const yarn = tempRoots.yarn.map((root) => spellings(root, platform));
  // A path that cannot be canonicalized cannot be ruled out, so the check refuses it.
  if (packageSpellings === null || bunx.includes(null) || yarn.includes(null)) return true;
  return packageSpellings.some(
    (spelling) =>
      isCacheRoot(spelling, platform) ||
      isTempRunnerRoot(spelling, platform, { bunx: bunx.flat(), yarn: yarn.flat() }),
  );
}

export const INHERITED_TMPDIR_INVALID_MESSAGE =
  `Refusing to install: ${INHERITED_TMPDIR_ENV} is set but is not a JSON array of absolute ` +
  "paths, so the installer cannot tell whether this package root is a temporary one. " +
  "Unset it, then run install again.";

/**
 * The reason that `install` refuses `packageRoot`, or null. An invalid
 * `AGENT_LOOP_INHERITED_TMPDIR` refuses every root.
 */
export function installRefusal(packageRoot) {
  const tempRoots = temporaryRoots();
  if (tempRoots.invalid) return INHERITED_TMPDIR_INVALID_MESSAGE;
  return isEphemeralPackageRoot(packageRoot, process.platform, tempRoots)
    ? EPHEMERAL_ROOT_MESSAGE
    : null;
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
