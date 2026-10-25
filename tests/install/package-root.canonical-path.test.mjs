import { mkdir, mkdtemp, rename, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { installRefusal, isEphemeralPackageRoot } from "../../src/install/package-root.mjs";
import { removePath } from "../runtime-helpers.mjs";

const realpathMock = vi.hoisted(() => ({
  fail: null,
  readdirFail: null,
  readdirList: null,
  lstatFail: null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const failing =
    (realpath) =>
    (path, ...rest) => {
      if (realpathMock.fail?.(String(path))) {
        throw Object.assign(new Error(`EACCES: permission denied, realpath '${path}'`), {
          code: "EACCES",
        });
      }
      return realpath(path, ...rest);
    };
  // A predicate that returns an error code makes the call throw it.
  const failingWith =
    (call, predicate) =>
    (path, ...rest) => {
      const code = realpathMock[predicate]?.(String(path));
      if (code) throw Object.assign(new Error(`${code}: ${call} '${path}'`), { code });
      return actual[call](path, ...rest);
    };
  return {
    ...actual,
    // `readdirList` returns the listing to report for a directory, or null for the real one.
    readdirSync: (path, ...rest) =>
      realpathMock.readdirList?.(String(path)) ??
      failingWith("readdirSync", "readdirFail")(path, ...rest),
    lstatSync: failingWith("lstatSync", "lstatFail"),
    realpathSync: Object.assign(failing(actual.realpathSync), {
      native: failing(actual.realpathSync.native),
    }),
  };
});

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const BUNX_LAYOUT = ["bunx-501-pkg@1.0.0", "node_modules"];
const YARN_LAYOUT = ["xfs-8de51b90", "dlx-31536", ".yarn", "cache", "x.zip", "node_modules"];
const paths = [];

afterEach(async () => {
  realpathMock.fail = null;
  realpathMock.readdirFail = null;
  realpathMock.readdirList = null;
  realpathMock.lstatFail = null;
  for (const path of paths.splice(0)) await removePath(path);
});

async function scratch() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-canonical-")));
  paths.push(base);
  return base;
}

// Usefulness: verifies #962 review — a package junction inside a runner layout stays refused when its target is stable, because the installer renders the junction path into the entry points and the runner can delete it.
test("a junction package root inside a temporary runner layout is refused", async () => {
  const base = await scratch();
  const tempRoot = join(base, "temp");
  const stable = join(base, "stable", "pkg");
  await mkdir(stable, { recursive: true });
  const roots = { bunx: [tempRoot], yarn: [tempRoot] };
  for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
    await mkdir(join(tempRoot, ...layout), { recursive: true });
    const junction = join(tempRoot, ...layout, "pkg");
    await symlink(stable, junction, LINK_TYPE);
    expect(isEphemeralPackageRoot(junction, process.platform, roots), junction).toBe(true);
  }
  expect(isEphemeralPackageRoot(stable, process.platform, roots)).toBe(false);
});

// Usefulness: verifies #962 review — a realpath failure other than a missing path refuses the install, so an unreadable alias is never accepted where its canonical spelling is refused.
test("a package root that cannot be canonicalized is refused", async () => {
  const base = await scratch();
  const realTemp = join(base, "real");
  const linkTemp = join(base, "link");
  await mkdir(join(realTemp, ...BUNX_LAYOUT, "pkg"), { recursive: true });
  await symlink(realTemp, linkTemp, LINK_TYPE);
  const roots = { bunx: [realTemp], yarn: [realTemp] };
  const alias = join(linkTemp, ...BUNX_LAYOUT, "pkg");
  expect(isEphemeralPackageRoot(alias, process.platform, roots)).toBe(true);

  realpathMock.fail = (path) => path.startsWith(linkTemp);
  expect(isEphemeralPackageRoot(alias, process.platform, roots), alias).toBe(true);
  const stable = join(base, "stable", "pkg");
  await mkdir(stable, { recursive: true });
  realpathMock.fail = (path) => path === stable;
  expect(isEphemeralPackageRoot(stable, process.platform, roots), stable).toBe(true);
  expect(installRefusal(stable)).toMatch(/^Refusing to install/);
});

// Usefulness: verifies #962 review — a temporary root that cannot be canonicalized refuses every package root, since the match cannot rule the root out.
test("a temporary root that cannot be canonicalized refuses every package root", async () => {
  const base = await scratch();
  const stable = join(base, "stable", "pkg");
  await mkdir(stable, { recursive: true });
  const unreadableRoot = join(base, "unreadable");
  await mkdir(unreadableRoot);
  realpathMock.fail = (path) => path === unreadableRoot;
  const roots = { bunx: [unreadableRoot], yarn: [unreadableRoot] };
  expect(isEphemeralPackageRoot(stable, process.platform, roots)).toBe(true);
});

/** The 8.3 spelling of an existing directory, or null when the volume has no short names. */
function shortSpelling(dir) {
  const out = execFileSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${dir}") do @echo %~sI`], {
    windowsVerbatimArguments: true,
  })
    .toString()
    .trim();
  return out.toLowerCase() === dir.toLowerCase() ? null : out;
}

// Usefulness: verifies #1068 — an 8.3 spelling of the package root or the temporary root refuses like the canonical spelling, and the same layout under a stable parent stays accepted.
test.skipIf(process.platform !== "win32")(
  "an 8.3 spelling of the package root or the temporary root is refused",
  async () => {
    const base = await scratch();
    const longRoot = join(base, "shortnamedtemproot");
    await mkdir(join(longRoot, ...BUNX_LAYOUT, "pkg"), { recursive: true });
    const shortRoot = shortSpelling(longRoot);
    if (shortRoot === null) return;
    const canonicalPackage = join(longRoot, ...BUNX_LAYOUT, "pkg");
    const shortPackage = join(shortRoot, ...BUNX_LAYOUT, "pkg");
    const canonicalRoots = { bunx: [longRoot], yarn: [longRoot] };
    const shortRoots = { bunx: [shortRoot], yarn: [shortRoot] };
    expect(isEphemeralPackageRoot(canonicalPackage, "win32", canonicalRoots)).toBe(true);
    expect(isEphemeralPackageRoot(shortPackage, "win32", canonicalRoots), "short package").toBe(
      true,
    );
    expect(isEphemeralPackageRoot(canonicalPackage, "win32", shortRoots), "short temp").toBe(true);
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    const shortStable = join(shortSpelling(join(base, "stablenamedparent")), "pkg");
    expect(isEphemeralPackageRoot(shortStable, "win32", canonicalRoots)).toBe(false);
  },
);

// Usefulness: verifies #1068 review — a package junction inside a runner layout refuses when it or its temporary root is spelled 8.3, as it does when spelled canonically, even when its target is stable.
test.skipIf(process.platform !== "win32")(
  "an 8.3 spelling of a junction package root inside a temporary runner layout is refused",
  async () => {
    const base = await scratch();
    const tempRoot = join(base, "shortnamedtemproot");
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    const roots = { bunx: [tempRoot], yarn: [tempRoot] };
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      const junction = join(tempRoot, ...layout, "packagejunctionlink");
      await symlink(stable, junction, LINK_TYPE);
      const shortJunction = shortSpelling(junction);
      if (shortJunction === null) return;
      expect(isEphemeralPackageRoot(junction, "win32", roots), junction).toBe(true);
      expect(isEphemeralPackageRoot(shortJunction, "win32", roots), shortJunction).toBe(true);
      const shortRoots = { bunx: [shortSpelling(tempRoot)], yarn: [shortSpelling(tempRoot)] };
      expect(isEphemeralPackageRoot(junction, "win32", shortRoots), "short temp").toBe(true);
    }
    expect(isEphemeralPackageRoot(stable, "win32", roots)).toBe(false);
  },
);

// Usefulness: verifies #1068 review — an 8.3 expansion that fails on the directory listing or on a sibling stat refuses the install, as a realpath failure does, so a short-spelled junction in a runner layout is never accepted for lack of an expansion.
test.skipIf(process.platform !== "win32")(
  "a failed 8.3 expansion of a junction package root inside a runner layout is refused",
  async () => {
    const base = await scratch();
    const tempRoot = join(base, "shortnamedtemproot");
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    const roots = { bunx: [tempRoot], yarn: [tempRoot] };
    const failures = {
      readdirFail: () => "EACCES",
      lstatFail: (path) => (basename(path).includes("~") ? null : "ENOENT"),
    };
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      const junction = join(tempRoot, ...layout, "packagejunctionlink");
      await symlink(stable, junction, LINK_TYPE);
      const shortJunction = shortSpelling(junction);
      if (shortJunction === null) return;
      expect(isEphemeralPackageRoot(shortJunction, "win32", roots), "no failure").toBe(true);
      for (const [name, predicate] of Object.entries(failures)) {
        realpathMock[name] = predicate;
        expect(isEphemeralPackageRoot(shortJunction, "win32", roots), name).toBe(true);
        realpathMock[name] = null;
      }
    }
  },
);

// Usefulness: verifies #1068 review — a short segment that vanishes between canonical resolution and expansion refuses the install instead of keeping its name, while a stable path with a missing suffix stays accepted.
test.skipIf(process.platform !== "win32")(
  "a short segment that vanishes during expansion is refused and a missing stable suffix is accepted",
  async () => {
    const base = await scratch();
    const tempRoot = join(base, "shortnamedtemproot");
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    const roots = { bunx: [tempRoot], yarn: [tempRoot] };
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      const junction = join(tempRoot, ...layout, "packagejunctionlink");
      await symlink(stable, junction, LINK_TYPE);
      const shortJunction = shortSpelling(junction);
      if (shortJunction === null) return;
      realpathMock.lstatFail = (path) => (basename(path).includes("~") ? "ENOENT" : null);
      expect(isEphemeralPackageRoot(shortJunction, "win32", roots), shortJunction).toBe(true);
      realpathMock.lstatFail = null;
    }
    const missing = join(base, "stablenamedparent", "missing", "pkg");
    expect(isEphemeralPackageRoot(missing, "win32", roots)).toBe(false);
  },
);

// Usefulness: verifies #1068 review — a short segment whose stat succeeds but whose directory listing holds no entry with its file id refuses the install, while a literal name that the listing holds stays accepted.
test.skipIf(process.platform !== "win32")(
  "a short segment with no matching listing entry is refused and a listed literal name is accepted",
  async () => {
    const base = await scratch();
    const tempRoot = join(base, "shortnamedtemproot");
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    const roots = { bunx: [tempRoot], yarn: [tempRoot] };
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      const junction = join(tempRoot, ...layout, "packagejunctionlink");
      await symlink(stable, junction, LINK_TYPE);
      const shortJunction = shortSpelling(junction);
      if (shortJunction === null) return;
      realpathMock.readdirList = () => [];
      expect(isEphemeralPackageRoot(shortJunction, "win32", roots), shortJunction).toBe(true);
      realpathMock.readdirList = null;
    }
    const literal = join(base, "stablenamedparent", "literal~1dir", "pkg");
    await mkdir(literal, { recursive: true });
    expect(isEphemeralPackageRoot(literal, "win32", roots)).toBe(false);
  },
);

/** True when a hand-set 8.3 name was applied, which needs the privilege that `fsutil` requires. */
function setShortName(path, name) {
  try {
    execFileSync("fsutil", ["file", "setshortname", path, name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Usefulness: verifies #1068 review — a hand-set 8.3 name without a tilde and digit refuses like the canonical spelling does, for the temporary root and for a junction package root in a bunx and a yarn dlx layout.
test.skipIf(process.platform !== "win32")(
  "a hand-set 8.3 name without a tilde refuses a junction package root inside a runner layout",
  async () => {
    const base = await scratch();
    const tempRoot = join(base, "handsettemproot");
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    await mkdir(tempRoot);
    if (!setShortName(tempRoot, "TEMPROOT")) return;
    const aliasRoot = join(base, "TEMPROOT");
    const roots = { bunx: [tempRoot], yarn: [tempRoot] };
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      const junction = join(tempRoot, ...layout, "packagejunctionlink");
      await symlink(stable, junction, LINK_TYPE);
      expect(setShortName(junction, "PKGLINK"), "junction short name").toBe(true);
      expect(isEphemeralPackageRoot(junction, "win32", roots), junction).toBe(true);
      const aliasJunction = join(tempRoot, ...layout, "PKGLINK");
      expect(isEphemeralPackageRoot(aliasJunction, "win32", roots), aliasJunction).toBe(true);
      const viaRoot = join(aliasRoot, ...layout, "packagejunctionlink");
      expect(isEphemeralPackageRoot(viaRoot, "win32", roots), viaRoot).toBe(true);
      const aliasRoots = { bunx: [aliasRoot], yarn: [aliasRoot] };
      expect(isEphemeralPackageRoot(junction, "win32", aliasRoots), "alias temp root").toBe(true);
    }
    expect(isEphemeralPackageRoot(stable, "win32", roots)).toBe(false);
  },
);

// Usefulness: verifies #1068 review — an existing stable package root given as a relative path stays accepted, since the check must resolve it against the working directory like any other path.
test("a relative stable package root is accepted", async () => {
  const base = await scratch();
  const tempRoot = join(base, "shortnamedtemproot");
  const stable = join(base, "stablenamedparent", "pkg");
  await mkdir(stable, { recursive: true });
  const roots = { bunx: [tempRoot], yarn: [tempRoot] };
  const relativeStable = relative(process.cwd(), stable);
  expect(isEphemeralPackageRoot(relativeStable, process.platform, roots), relativeStable).toBe(
    false,
  );
});

// Usefulness: verifies #1068 review — a short name of the temporary root that is already gone when the path is canonicalized still refuses a runner layout under it, so a rename before the check cannot turn a refusal into an accept.
test.skipIf(process.platform !== "win32")(
  "a short temporary root name renamed away before canonicalization is refused",
  async () => {
    const base = await scratch();
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      const tempRoot = join(base, `shortnamedtemproot${layout.length}`);
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      const junction = join(tempRoot, ...layout, "packagejunctionlink");
      await symlink(stable, junction, LINK_TYPE);
      const shortRoot = shortSpelling(tempRoot);
      if (shortRoot === null) return;
      await rename(tempRoot, join(base, `renamedtemprootaway${layout.length}`));
      const viaAlias = join(shortRoot, ...layout, "packagejunctionlink");
      const roots = { bunx: [tempRoot], yarn: [tempRoot] };
      expect(isEphemeralPackageRoot(viaAlias, "win32", roots), viaAlias).toBe(true);
    }
  },
);

// Usefulness: verifies #1068 review — a package junction reached through a junction spelling of the temporary parent folder refuses inside a runner layout, as it does through the canonical spelling, even when the package target is stable.
test("a junction spelling of the temporary parent refuses a junction package root", async () => {
  const base = await scratch();
  const tempRoot = join(base, "realtemproot");
  const linkedTemp = join(base, "linkedtemproot");
  const stable = join(base, "stablenamedparent", "pkg");
  await mkdir(stable, { recursive: true });
  await mkdir(tempRoot);
  await symlink(tempRoot, linkedTemp, LINK_TYPE);
  const roots = { bunx: [tempRoot], yarn: [tempRoot] };
  for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
    await mkdir(join(tempRoot, ...layout), { recursive: true });
    await symlink(stable, join(tempRoot, ...layout, "pkg"), LINK_TYPE);
    const viaLink = join(linkedTemp, ...layout, "pkg");
    expect(isEphemeralPackageRoot(join(tempRoot, ...layout, "pkg"), process.platform, roots)).toBe(
      true,
    );
    expect(isEphemeralPackageRoot(viaLink, process.platform, roots), viaLink).toBe(true);
  }
  expect(
    isEphemeralPackageRoot(
      join(linkedTemp, "..", "stablenamedparent", "pkg"),
      process.platform,
      roots,
    ),
  ).toBe(false);
});
