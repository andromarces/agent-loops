import { mkdir, mkdtemp, rename, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  EPHEMERAL_ROOT_MESSAGE,
  installRefusal,
  isEphemeralPackageRoot,
} from "../../src/install/package-root.mjs";
import { removePath } from "../runtime-helpers.mjs";

const realpathMock = vi.hoisted(() => ({
  fail: null,
  readdirFail: null,
  readdirList: null,
  lstatFail: null,
  beforeLstat: null,
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
    // `beforeLstat` runs before each `lstatSync` until it returns true, to change the file
    // system mid-check.
    lstatSync: (path, ...rest) => {
      if (realpathMock.beforeLstat?.(String(path)) === true) realpathMock.beforeLstat = null;
      return failingWith("lstatSync", "lstatFail")(path, ...rest);
    },
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
  realpathMock.beforeLstat = null;
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

// Usefulness: verifies #1081 — an unreadable folder refuses with a message that names the unreadable package path and not a runner cache, so a user with a stable global install is not told to install globally; a proven runner cache keeps its own message.
test("a package root that cannot be read is refused without the runner-cache message", async () => {
  const base = await scratch();
  const stable = join(base, "stable", "pkg");
  await mkdir(stable, { recursive: true });
  realpathMock.fail = (path) => path === stable;
  const refusal = installRefusal(stable);
  expect(refusal).toMatch(/^Refusing to install/);
  expect(refusal).toContain(stable);
  expect(refusal).not.toMatch(/npx|dlx|bunx|cache/);
  expect(refusal).not.toBe(EPHEMERAL_ROOT_MESSAGE);
  realpathMock.fail = null;

  const npxRoot = join(base, "_npx", "0123456789abcdef", "node_modules", "pkg");
  await mkdir(npxRoot, { recursive: true });
  expect(installRefusal(npxRoot)).toBe(EPHEMERAL_ROOT_MESSAGE);
});

// Usefulness: verifies #1088 — the unreadable-path refusal names the folder that failed, not only the package root, so a user can fix the permission on that folder without searching for it; it also covers a parent folder and a temporary root, which the package root alone does not point at.
test("the unreadable-path refusal names the folder that failed", async () => {
  const base = await scratch();
  const denied = join(base, "denied");
  const stable = join(denied, "pkg");
  await mkdir(stable, { recursive: true });
  // The check names a folder by its long spelling, which differs from `denied` under an 8.3
  // temporary root, so the mock and the assertions match on the folder name.
  const namesFolder = (name) => new RegExp(`folder .*[\\\\/]${name} cannot be read`);
  realpathMock.fail = (path) => basename(path) === "denied";
  const refusal = installRefusal(stable);
  expect(refusal).toMatch(/^Refusing to install/);
  expect(refusal).toMatch(namesFolder("denied"));
  expect(refusal).not.toBe(EPHEMERAL_ROOT_MESSAGE);
  expect(isEphemeralPackageRoot(stable, process.platform, { bunx: [], yarn: [] })).toBe(true);

  const unreadableTemp = join(base, "unreadable-temp");
  await mkdir(unreadableTemp);
  realpathMock.fail = (path) => basename(path) === "unreadable-temp";
  const saved = process.env.AGENT_LOOP_INHERITED_TMPDIR;
  process.env.AGENT_LOOP_INHERITED_TMPDIR = JSON.stringify([unreadableTemp]);
  try {
    expect(installRefusal(stable)).toMatch(namesFolder("unreadable-temp"));
  } finally {
    if (saved === undefined) delete process.env.AGENT_LOOP_INHERITED_TMPDIR;
    else process.env.AGENT_LOOP_INHERITED_TMPDIR = saved;
  }
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

// Usefulness: verifies #1081 review — a package junction inside a bunx or yarn dlx layout of an inherited temporary-root junction keeps the runner-cache message when a folder listing fails, in either spelling of the root, and a stable root under the same failure gets the unreadable message.
test.skipIf(process.platform !== "win32")(
  "a proven runner layout under a linked temporary root keeps the runner-cache message",
  async () => {
    const base = await scratch();
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    const saved = process.env.AGENT_LOOP_INHERITED_TMPDIR;
    try {
      for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
        const realRoot = join(base, `realtemproot${layout.length}`);
        const linkRoot = join(base, `linkedtemproot${layout.length}`);
        await mkdir(join(realRoot, ...layout), { recursive: true });
        await symlink(stable, join(realRoot, ...layout, "packagejunctionlink"), LINK_TYPE);
        await symlink(realRoot, linkRoot, LINK_TYPE);
        realpathMock.readdirFail = () => "EPERM";
        const cases = [
          [realRoot, linkRoot],
          [linkRoot, realRoot],
        ];
        for (const [inherited, spelled] of cases) {
          process.env.AGENT_LOOP_INHERITED_TMPDIR = JSON.stringify([inherited]);
          const packageRoot = join(spelled, ...layout, "packagejunctionlink");
          expect(installRefusal(packageRoot), packageRoot).toBe(EPHEMERAL_ROOT_MESSAGE);
        }
        const stableRefusal = installRefusal(stable);
        expect(stableRefusal).toMatch(/^Refusing to install/);
        expect(stableRefusal).not.toBe(EPHEMERAL_ROOT_MESSAGE);
        realpathMock.readdirFail = null;
      }
    } finally {
      if (saved === undefined) delete process.env.AGENT_LOOP_INHERITED_TMPDIR;
      else process.env.AGENT_LOOP_INHERITED_TMPDIR = saved;
    }
  },
);

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

// Usefulness: verifies #1074 — a layout directory that vanishes while the check runs refuses a package root spelled through a link to that layout, since the dangling link leaves no spelling that names a temporary root.
test.skipIf(process.platform !== "win32")(
  "a layout directory that vanishes during the check refuses a link spelling of it",
  async () => {
    const base = await scratch();
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      const tempRoot = join(base, `temproot${layout.length}`);
      const roots = { bunx: [tempRoot], yarn: [tempRoot] };
      const layoutDir = join(tempRoot, layout[0]);
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      await symlink(stable, join(tempRoot, ...layout, "packagejunctionlink"), LINK_TYPE);
      const layoutLink = join(base, `linkedlayout${layout.length}`);
      await symlink(layoutDir, layoutLink, LINK_TYPE);
      const viaLink = join(layoutLink, ...layout.slice(1), "packagejunctionlink");
      expect(isEphemeralPackageRoot(viaLink, "win32", roots), `${viaLink} before`).toBe(true);
      realpathMock.beforeLstat = (path) =>
        path.startsWith(layoutLink) && (rmSync(layoutDir, { recursive: true, force: true }), true);
      expect(isEphemeralPackageRoot(viaLink, "win32", roots), `${viaLink} during`).toBe(true);
      expect(isEphemeralPackageRoot(viaLink, "win32", roots), `${viaLink} after`).toBe(true);
    }
    expect(isEphemeralPackageRoot(stable, "win32", { bunx: [base], yarn: [base] })).toBe(false);
  },
);

// Usefulness: verifies #1077 — a link spelling of a runner layout that is renamed away as the first canonicalization starts still refuses, because an earlier look saw the link, while a missing stable path stays accepted.
test("a link spelling that vanishes before the first canonicalization is refused", async () => {
  const base = await scratch();
  const stable = join(base, "stablenamedparent", "pkg");
  await mkdir(stable, { recursive: true });
  for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
    const tempRoot = join(base, `temproot${layout.length}`);
    const roots = { bunx: [tempRoot], yarn: [tempRoot] };
    await mkdir(join(tempRoot, ...layout), { recursive: true });
    const layoutLink = join(base, `linkedlayout${layout.length}`);
    await symlink(join(tempRoot, layout[0]), layoutLink, LINK_TYPE);
    const viaLink = join(layoutLink, ...layout.slice(1), "pkg");
    await mkdir(viaLink, { recursive: true });
    expect(isEphemeralPackageRoot(viaLink, process.platform, roots), `${viaLink} before`).toBe(
      true,
    );
    let renamed = false;
    realpathMock.fail = () => {
      if (!renamed) renameSync(layoutLink, join(base, `renamedlayout${layout.length}`));
      renamed = true;
      return false;
    };
    expect(isEphemeralPackageRoot(viaLink, process.platform, roots), `${viaLink} during`).toBe(
      true,
    );
    realpathMock.fail = null;
  }
  const missing = join(base, "stablenamedparent", "missing", "pkg");
  const otherRoot = join(base, "temproot");
  const roots = { bunx: [otherRoot], yarn: [otherRoot] };
  expect(isEphemeralPackageRoot(missing, process.platform, roots), "missing stable").toBe(false);
});

// Usefulness: verifies #1074 — a link spelling of the temporary root that is renamed away while the check runs still refuses a runner layout under it, so a rename cannot turn an existing alias into a missing segment that passes.
test.skipIf(process.platform !== "win32")(
  "a link spelling of the temporary root renamed away is refused",
  async () => {
    const base = await scratch();
    const stable = join(base, "stablenamedparent", "pkg");
    await mkdir(stable, { recursive: true });
    for (const layout of [BUNX_LAYOUT, YARN_LAYOUT]) {
      const tempRoot = join(base, `temproot${layout.length}`);
      const roots = { bunx: [tempRoot], yarn: [tempRoot] };
      await mkdir(join(tempRoot, ...layout), { recursive: true });
      await symlink(stable, join(tempRoot, ...layout, "packagejunctionlink"), LINK_TYPE);
      const rootLink = join(base, `linkedtemproot${layout.length}`);
      await symlink(tempRoot, rootLink, LINK_TYPE);
      const viaLink = join(rootLink, ...layout, "packagejunctionlink");
      expect(isEphemeralPackageRoot(viaLink, "win32", roots), `${viaLink} before`).toBe(true);
      // The rename lands while the temporary root is read, before the package root is resolved.
      realpathMock.beforeLstat = (path) =>
        path === tempRoot &&
        (renameSync(rootLink, join(base, `renamedaway${layout.length}`)), true);
      expect(isEphemeralPackageRoot(viaLink, "win32", roots), `${viaLink} during`).toBe(true);
    }
  },
);
