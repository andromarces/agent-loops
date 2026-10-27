// Finds the version-independent pnpm package root that installed files must name (#305, #311).
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve } from "node:path";

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
