import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { removePath } from "./fs-helpers.mjs";

/** Key that carries the template path from the global setup to `inject` in each test file. */
export const TEMPLATE_KEY = "gitTemplate";

/** Key that carries a seeded main and linked work tree pair, for a case that needs no seed. */
export const LINKED_TEMPLATE_KEY = "gitLinkedTemplate";

/**
 * Seeds the one immutable git template of the run and provides its path to every test file.
 * Also seeds one main and linked work tree pair that an unseeded `createLinkedWorkTree` copy
 * relocates by text, so no `git worktree add` runs per case.
 * The teardown removes both on every run outcome, a failed seed included.
 */
export default async function setup(project) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-test-template-"));
  let pair;
  try {
    await execa("git", ["init"], { cwd: dir });
    // A commit must not start automatic maintenance, because its lock file can vanish
    // during the recursive copy of the template (issue #1458).
    await execa("git", ["config", "maintenance.auto", "false"], { cwd: dir });
    await execa("git", ["config", "gc.auto", "0"], { cwd: dir });
    await execa("git", ["config", "user.name", "Tester"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await writeFile(join(dir, "init.txt"), "hello\n");
    await execa("git", ["add", "init.txt"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });
    project.provide(TEMPLATE_KEY, dir);

    pair = await mkdtemp(join(tmpdir(), "runtime-test-linked-template-"));
    const main = join(pair, "main");
    const linked = join(pair, "linked");
    await cp(dir, main, { recursive: true });
    await execa("git", ["worktree", "add", linked, "-b", "run"], { cwd: main });
    project.provide(LINKED_TEMPLATE_KEY, { main, linked });
  } catch (error) {
    await removePath(dir);
    if (pair) await removePath(pair);
    throw error;
  }
  return async () => {
    await removePath(dir);
    await removePath(pair);
  };
}
