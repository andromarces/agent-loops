// Detects an ephemeral package root (npx, pnpm dlx, yarn dlx, bunx) that installed files must
// not name (#205, #207). The pnpm stable root lives in `stable-root.mjs`.
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
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

// The path module and the realpath of a platform. On Windows the native realpath expands an 8.3
// short segment, which the JS realpath keeps (#1068).
const platformApi = (platform) =>
  platform === "win32"
    ? { path: win32, realpath: realpathSync.native }
    : { path: posix, realpath: realpathSync };

// A path for this platform is first resolved against the working directory. A path for another
// platform is only normalized.
function absolutePath(path, platform) {
  const { path: pathApi } = platformApi(platform);
  return platform === process.platform ? pathApi.resolve(path) : pathApi.normalize(path);
}

/**
 * Records `folder` as the first one that a check of the current `packageRootRefusal` call could
 * not read, so the refusal can name it, and returns `null`, the fail-closed result. `failures`
 * is that call's own record.
 */
function failAt(failures, folder) {
  failures.unreadable ??= folder;
  return null;
}

/**
 * The canonical spelling of `path`: the realpath of its deepest existing ancestor joined to the
 * rest, normalized, so a link such as macOS `/var` resolves to `/private/var` and a `..`
 * segment is resolved even when the path does not exist (#962). A path for another platform
 * is only normalized. Returns `null` when a realpath fails for a reason other than a missing
 * path, such as EACCES or ELOOP, so the caller can fail closed.
 */
function canonicalPath(path, platform, failures) {
  const { path: pathApi, realpath } = platformApi(platform);
  const normalized = absolutePath(path, platform);
  if (platform !== process.platform) return normalized;
  for (let dir = normalized, tail = ""; ;) {
    try {
      return pathApi.join(realpath(dir), tail);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return failAt(failures, dir);
    }
    const parent = pathApi.dirname(dir);
    if (parent === dir) return normalized;
    tail = pathApi.join(pathApi.basename(dir), tail);
    dir = parent;
  }
}

// An 8.3 short name is at most 8 characters, a dot, and 3 more, with no space.
const SHORT_NAME_SHAPE = /^[^.\s]{1,8}(\.[^.\s]{1,3})?$/;

/**
 * `path` with each segment replaced by its long name, without resolving a link, so a junction
 * keeps its own spelling (#1068). Every segment is either positively resolved or the whole
 * expansion returns `null` so the caller fails closed. Positively resolved is a name that the
 * parent listing holds, or the listing entry with the same file id, so a hand-set alias with no
 * `~<digit>` resolves too. A failed stat, listing, or sibling stat, and a listing with no matching
 * entry, are unresolved.
 *
 * A missing segment is also unresolved, because a short name can vanish by a rename. The first
 * missing segment is kept only when it cannot stand for a temporary root or a runner layout
 * directory, which is when its name has no 8.3 shape, or when `related` says that its existing
 * parent is neither at, above, nor below a temporary root. Every segment below a kept one is
 * missing too and is kept.
 *
 * `isEphemeralPackageRoot` takes the canonical path of the package root first, before it reads the
 * temporary roots, then accepts the path only when that canonical path is among the spellings of
 * the first check and a second check gives the same spellings. A rename or delete that lands after
 * that first canonicalization has read the affected segment refuses the install (#1074). Tests
 * cover a link to a layout directory that vanishes while the first check runs, and a link spelling
 * of a temporary root that is renamed while the temporary roots are read.
 *
 * `isEphemeralPackageRoot` also looks at each prefix of the package root once, before the first
 * canonicalization, and refuses when a prefix that this look saw is missing at the second check
 * (#1077). Tests cover a link spelling of a bunx and a yarn dlx layout that is renamed as the first
 * canonicalization starts.
 *
 * known-limit: a change that lands before that first look reads the affected segment, or while it
 * reads it, is accepted (#1074, #1077). The process then never sees the segment present, so a
 * vanished link spelling of a temporary root looks the same as a missing stable path, which the
 * missing-segment rule above keeps accepted on purpose. No check inside one process can tell the
 * two apart without refusing every missing stable path and missing default root. A change after
 * the second check, such as a runner that deletes its folder while the installer writes files, is
 * not detected either, and that deletion is the one that the refusal exists for.
 *
 * Access failure and cost were verified on Windows 11 on 2026-10-25 (#709).
 */
function expandShortSegments(path, related, failures) {
  const { root } = win32.parse(path);
  const segments = splitPath(path.slice(root.length));
  let expanded = root;
  for (const [i, segment] of segments.entries()) {
    const name = longName(expanded, segment, failures);
    if (name === null) return null;
    if (name === MISSING) {
      const canStandForRoot = SHORT_NAME_SHAPE.test(segment) && related(expanded);
      return canStandForRoot ? null : win32.join(expanded, ...segments.slice(i));
    }
    expanded = win32.join(expanded, name);
  }
  return expanded;
}

const MISSING = Symbol("missing");

/**
 * The long name of an existing segment, `MISSING` for a missing one, or `null` when unresolved. An
 * unreadable result records the segment when its stat fails, and otherwise `parent`: a failed
 * listing, a failed stat of a sibling entry that may be a file, or a listing with no match.
 */
function longName(parent, segment, failures) {
  let reading = join(parent, segment);
  try {
    const id = lstatSync(reading, { bigint: true }).ino;
    reading = parent;
    const names = readdirSync(parent);
    const lower = segment.toLowerCase();
    return (
      names.find((name) => name.toLowerCase() === lower) ??
      names.find((name) => lstatSync(join(parent, name), { bigint: true }).ino === id) ??
      failAt(failures, parent)
    );
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR"
      ? MISSING
      : failAt(failures, reading);
  }
}

/** True when `path` exists as an entry that the realpath of a caller could not resolve. */
function isDanglingLink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `path` with a leading part resolved through links: for each proper ancestor, the realpath of
 * that ancestor joined to the rest, so a link spelling of a parent folder, such as a junction to
 * a temporary root, meets the root's own spelling while a link below it keeps its own name
 * (#1068). A missing ancestor is skipped, except a link whose target is gone, since that link may
 * have named a temporary root (#1074). Returns `null` when a realpath fails for another reason,
 * so the caller can fail closed.
 */
function resolvedParentSpellings(path, platform, failures) {
  const { path: pathApi, realpath } = platformApi(platform);
  const { root } = pathApi.parse(path);
  const segments = splitPath(path.slice(root.length));
  const found = [];
  for (let depth = 1; depth < segments.length; depth++) {
    try {
      found.push(
        pathApi.join(
          realpath(pathApi.join(root, ...segments.slice(0, depth))),
          ...segments.slice(depth),
        ),
      );
    } catch (error) {
      const ancestor = pathApi.join(root, ...segments.slice(0, depth));
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return failAt(failures, ancestor);
      if (isDanglingLink(ancestor)) return failAt(failures, ancestor);
    }
  }
  return found;
}

/**
 * The spellings to match: the normalized path, which is what the installer renders into entry
 * points, and its canonical path. A package junction inside a runner layout matches by its own
 * spelling even when its target is stable, and on Windows each segment of that spelling expands
 * to its long name. A link spelling of a parent folder also matches by the resolved parent.
 * `null` when the canonical path, a parent, or an 8.3 expansion cannot be resolved.
 * `related` is passed to `expandShortSegments`.
 */
function spellings(path, platform, failures, related = () => false) {
  const canonical = canonicalPath(path, platform, failures);
  if (canonical === null) return null;
  const normalized = absolutePath(path, platform);
  const own =
    platform === "win32" && platform === process.platform
      ? expandShortSegments(normalized, related, failures)
      : normalized;
  if (own === null) return null;
  const parents =
    platform === process.platform ? resolvedParentSpellings(own, platform, failures) : [];
  return parents === null ? null : [...new Set([normalized, own, canonical, ...parents])];
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
 * The prefixes of `packageRoot` that exist now, from the root down to the first missing one. This
 * is the first look at the path, taken before any canonicalization. Empty for another platform.
 */
function presentPrefixes(packageRoot, platform) {
  if (platform !== process.platform) return [];
  const { path: pathApi } = platformApi(platform);
  const absolute = absolutePath(packageRoot, platform);
  const { root } = pathApi.parse(absolute);
  const segments = splitPath(absolute.slice(root.length));
  const present = [];
  for (let depth = 1; depth <= segments.length; depth++) {
    const prefix = pathApi.join(root, ...segments.slice(0, depth));
    if (!existsSync(prefix)) break;
    present.push(prefix);
  }
  return present;
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
 * temporary layout. On Windows every match compares case-insensitively. A path that cannot be
 * canonicalized (a realpath error other than a missing path) is refused.
 * @param {string} packageRoot
 * @param {NodeJS.Platform} [platform]
 * @param {{ bunx: string[], yarn: string[], invalid?: boolean }} [tempRoots] Temporary roots to compare against, for tests. `invalid` refuses every root.
 */
export function isEphemeralPackageRoot(
  packageRoot,
  platform = process.platform,
  tempRoots = temporaryRoots(),
) {
  return packageRootRefusal(packageRoot, platform, tempRoots) !== null;
}

const EPHEMERAL = { kind: "ephemeral" };

/**
 * `{ kind: "unreadable", folder }` when a check fails closed on a folder it cannot read, `EPHEMERAL`
 * for any other refusal, else `null`. `folder` is the first folder that a check could not read.
 */
function packageRootRefusal(packageRoot, platform, tempRoots) {
  const failures = { unreadable: null };
  if (tempRoots.invalid === true) return EPHEMERAL;
  const seen = presentPrefixes(packageRoot, platform);
  const initial = canonicalPath(packageRoot, platform, failures);
  // A path that cannot be resolved is a runner cache only when a spelling of it shows the layout,
  // under a temporary root as given or as its realpath resolves it.
  const unresolved = () => {
    const absolute = absolutePath(packageRoot, platform);
    const resolve = (roots) => [
      ...roots,
      ...roots.map((root) => canonicalPath(root, platform, failures)),
    ];
    const roots = { bunx: resolve(tempRoots.bunx), yarn: resolve(tempRoots.yarn) };
    roots.bunx = roots.bunx.filter(Boolean);
    roots.yarn = roots.yarn.filter(Boolean);
    const candidates = [
      absolute,
      initial,
      ...(resolvedParentSpellings(absolute, platform, failures) ?? []),
    ];
    return candidates.some(
      (spelling) =>
        spelling !== null &&
        (isCacheRoot(spelling, platform) || isTempRunnerRoot(spelling, platform, roots)),
    )
      ? EPHEMERAL
      : { kind: "unreadable", folder: failures.unreadable };
  };
  const bunx = tempRoots.bunx.map((root) => spellings(root, platform, failures));
  const yarn = tempRoots.yarn.map((root) => spellings(root, platform, failures));
  if (bunx.includes(null) || yarn.includes(null)) return unresolved();
  const rootSegments = [...bunx.flat(), ...yarn.flat()].map((root) =>
    splitPath(root.toLowerCase()),
  );
  const related = (dir) => {
    const segments = splitPath(dir.toLowerCase());
    const startsWith = (list, prefix) => prefix.every((segment, i) => list[i] === segment);
    return rootSegments.some((root) => startsWith(root, segments) || startsWith(segments, root));
  };
  const matches = (list) =>
    list.some(
      (spelling) =>
        isCacheRoot(spelling, platform) ||
        isTempRunnerRoot(spelling, platform, { bunx: bunx.flat(), yarn: yarn.flat() }),
    );
  const packageSpellings = spellings(packageRoot, platform, failures, related);
  // A path that cannot be canonicalized cannot be ruled out, so the check refuses it.
  if (packageSpellings === null) return unresolved();
  if (matches(packageSpellings)) return EPHEMERAL;
  // The path is accepted only when a second check sees the same spellings, and when the canonical
  // path taken before the temporary roots were read is among them, so a path that changes while
  // the check runs is refused (#1074). So is a prefix that the first look saw and that is gone now
  // (#1077).
  const again = spellings(packageRoot, platform, failures, related);
  if (seen.some((prefix) => !existsSync(prefix))) return EPHEMERAL;
  if (initial === null || again === null) return unresolved();
  const changed =
    !packageSpellings.includes(initial) ||
    again.length !== packageSpellings.length ||
    again.some((spelling, i) => spelling !== packageSpellings[i]);
  return changed ? EPHEMERAL : null;
}

export const INHERITED_TMPDIR_INVALID_MESSAGE =
  `Refusing to install: ${INHERITED_TMPDIR_ENV} is set but is not a JSON array of absolute ` +
  "paths, so the installer cannot tell whether this package root is a temporary one. " +
  "Unset it, then run install again.";

/**
 * The reason that `install` refuses `packageRoot`, or null. An invalid
 * `AGENT_LOOP_INHERITED_TMPDIR` refuses every root. A folder that the check cannot read refuses
 * with its own message, since the root is then not known to be a runner cache (#1081).
 */
export function installRefusal(packageRoot) {
  const tempRoots = temporaryRoots();
  if (tempRoots.invalid) return INHERITED_TMPDIR_INVALID_MESSAGE;
  const refusal = packageRootRefusal(packageRoot, process.platform, tempRoots);
  if (refusal?.kind === "unreadable") return unreadableRootMessage(packageRoot, refusal.folder);
  return refusal === EPHEMERAL ? EPHEMERAL_ROOT_MESSAGE : null;
}

const unreadableRootMessage = (packageRoot, folder) =>
  `Refusing to install: the folder ${folder ?? packageRoot} cannot be read or resolved, so the ` +
  `installer cannot tell whether the package path ${packageRoot} is a temporary root. ` +
  "Fix the folder permissions, then run install again.";
