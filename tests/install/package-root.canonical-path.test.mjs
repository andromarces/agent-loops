import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { installRefusal, isEphemeralPackageRoot } from "../../src/install/package-root.mjs";
import { removePath } from "../runtime-helpers.mjs";

const realpathMock = vi.hoisted(() => ({ fail: null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    realpathSync: Object.assign((path, ...rest) => {
      if (realpathMock.fail?.(String(path))) {
        throw Object.assign(new Error(`EACCES: permission denied, realpath '${path}'`), {
          code: "EACCES",
        });
      }
      return actual.realpathSync(path, ...rest);
    }, actual.realpathSync),
  };
});

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const BUNX_LAYOUT = ["bunx-501-pkg@1.0.0", "node_modules"];
const YARN_LAYOUT = ["xfs-8de51b90", "dlx-31536", ".yarn", "cache", "x.zip", "node_modules"];
const paths = [];

afterEach(async () => {
  realpathMock.fail = null;
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
