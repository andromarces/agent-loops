import { exists } from "./fs-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { readSparseCheckout } from "../src/lib/sparse-checkout.mjs";
import { executeRoleCommand } from "../src/role/index.mjs";
import { createLinkedWorkTree, createTempRepo } from "./git-helpers.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  repos,
  setup,
  withRepo,
} from "./role-helpers.mjs";

// Every case drives real Git in a real repository, because the report must match what Git reads.

const git = (cwd, args) => execa("git", args, { cwd });

/** Adds and commits one tracked file, so a sparse pattern can exclude it. */
async function addTrackedFile(repo, rel, text = `${rel}\n`) {
  await mkdir(dirname(join(repo, rel)), { recursive: true });
  await writeFile(join(repo, rel), text);
  await git(repo, ["add", rel]);
  await git(repo, ["commit", "-qm", rel]);
}

/** Runs the init dispatch in `repo` and returns the envelope. */
const initIn = (repo) =>
  executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());

/** Reads the sparse settings and index tags that init must leave unchanged. */
async function trackedState(repo) {
  const config = await execa("git", ["config", "--bool", "--get", "core.sparseCheckout"], {
    cwd: repo,
    reject: false,
  });
  const files = await execa("git", ["ls-files", "-t", "-z"], {
    cwd: repo,
    stripFinalNewline: false,
  });
  return { sparseCheckout: config.stdout, files: files.stdout };
}

/** A linked work tree whose main work tree excludes `excluded/two.txt` through sparse checkout. */
async function linkedWithInheritedSparse({ worktreeConfig = true } = {}) {
  const tree = await createLinkedWorkTree({
    seed: async (main) => {
      await addTrackedFile(main, "excluded/two.txt");
      if (worktreeConfig) {
        await git(main, ["config", "extensions.worktreeConfig", "true"]);
      }
      await git(main, ["sparse-checkout", "set", "--no-cone", "/init.txt"]);
    },
  });
  repos.push(tree.base);
  return tree;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

// Usefulness: verifies acceptance 1 — init reports an inherited sparse checkout and each excluded path.
// Not redundant: it sets the pattern in the main work tree and reads the linked init envelope.
test("init reports an inherited sparse checkout with extensions.worktreeConfig on", async () => {
  const { linked } = await linkedWithInheritedSparse();

  const result = await initIn(linked);

  expect(result.exitCode).toBe(0);
  expect(result.payload.sparseCheckout).toEqual({
    enabled: true,
    skipWorktree: ["excluded/two.txt"],
  });
});

// Usefulness: verifies acceptance 1 — a shared setting is reported with worktreeConfig off.
// Not redundant: the setting lives in the shared config, so the linked work tree reads it directly.
test("init reports a sparse checkout with extensions.worktreeConfig off", async () => {
  const { linked } = await linkedWithInheritedSparse({ worktreeConfig: false });

  const result = await initIn(linked);

  expect(result.exitCode).toBe(0);
  expect(result.payload.sparseCheckout).toEqual({
    enabled: true,
    skipWorktree: ["excluded/two.txt"],
  });
});

// Usefulness: verifies acceptance 1 — a skip-worktree entry is reported even with sparse checkout off.
// Not redundant: the exclusion is a manual index bit, so the setting alone cannot report it.
test("init reports a skip-worktree entry with no sparse checkout", async () => {
  const { base, linked } = await createLinkedWorkTree();
  repos.push(base);
  await git(linked, ["update-index", "--skip-worktree", "init.txt"]);

  const result = await initIn(linked);

  expect(result.exitCode).toBe(0);
  expect(result.payload.sparseCheckout).toEqual({ enabled: false, skipWorktree: ["init.txt"] });
});

// Usefulness: verifies acceptance 1 — sparse checkout with no excluded tracked file is still reported.
// Not redundant: it covers the setting with an empty path list, which the list alone cannot prove.
test("init reports an enabled sparse checkout with no excluded tracked file", async () => {
  const { base, linked } = await createLinkedWorkTree({
    seed: async (main) => {
      await addTrackedFile(main, "excluded/two.txt");
      await git(main, ["config", "extensions.worktreeConfig", "true"]);
      await git(main, ["sparse-checkout", "set", "--no-cone", "/*"]);
    },
  });
  repos.push(base);

  const result = await initIn(linked);

  expect(result.exitCode).toBe(0);
  expect(result.payload.sparseCheckout).toEqual({ enabled: true, skipWorktree: [] });
});

// Usefulness: verifies acceptance 1 — a main-work-tree `--cwd` reports no inherited field.
// Not redundant: the same sparse pattern is set on the main work tree, which reports nothing.
test("init in the main work tree reports no sparse checkout field", async () => {
  await setup();
  const main = await createTempRepo();
  repos.push(main);
  await addTrackedFile(main, "excluded/two.txt");
  await git(main, ["config", "extensions.worktreeConfig", "true"]);
  await git(main, ["sparse-checkout", "set", "--no-cone", "/init.txt"]);

  const result = await initIn(main);

  expect(result.exitCode).toBe(0);
  expect(result.payload).not.toHaveProperty("sparseCheckout");
});

// Usefulness: verifies a failed or overdue read reports no result and warns, never a clean state.
// Not redundant: it breaks the real repository format and uses a zero bound, with no test double.
test("a failed or overdue sparse-checkout read reports no result", async () => {
  const { linked } = await linkedWithInheritedSparse();
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});

  expect(await readSparseCheckout(linked, { deadlineMs: 0 })).toBeNull();

  await git(linked, ["config", "core.repositoryformatversion", "99"]);
  expect(await readSparseCheckout(linked)).toBeNull();
  expect(warn.mock.calls.flat().join("\n")).toContain("sparse-checkout read failed");
});

// Usefulness: verifies acceptance 1 — the report holds at most 20 paths, sorted.
// Not redundant: it excludes 25 tracked files, so the cap and the order are observable.
test("init caps the reported skip-worktree paths at 20", async () => {
  const { base, linked } = await createLinkedWorkTree({
    seed: async (main) => {
      for (let index = 1; index <= 25; index += 1) {
        await addTrackedFile(main, `excluded/f${String(index).padStart(2, "0")}.txt`);
      }
      await git(main, ["config", "extensions.worktreeConfig", "true"]);
      await git(main, ["sparse-checkout", "set", "--no-cone", "/init.txt"]);
    },
  });
  repos.push(base);

  const result = await initIn(linked);

  expect(result.payload.sparseCheckout.enabled).toBe(true);
  expect(result.payload.sparseCheckout.skipWorktree).toHaveLength(20);
  expect(result.payload.sparseCheckout.skipWorktree.at(0)).toBe("excluded/f01.txt");
  expect(result.payload.sparseCheckout.skipWorktree.at(-1)).toBe("excluded/f20.txt");
});

// Usefulness: verifies acceptance 1 — a path that needs redaction reaches the envelope redacted.
// Not redundant: the name holds a secret-named environment value, so the helper's effect shows.
test("init redacts a skip-worktree path that holds a secret value", async () => {
  const secret = "sparse-secret-value-123";
  process.env.SPARSE_CHECKOUT_TOKEN = secret;
  try {
    const { base, linked } = await createLinkedWorkTree({
      seed: async (main) => {
        await addTrackedFile(main, `excluded/token-${secret}.txt`);
        await git(main, ["config", "extensions.worktreeConfig", "true"]);
        await git(main, ["sparse-checkout", "set", "--no-cone", "/init.txt"]);
      },
    });
    repos.push(base);

    const result = await initIn(linked);

    expect(result.payload.sparseCheckout.skipWorktree).toHaveLength(1);
    expect(result.payload.sparseCheckout.skipWorktree[0]).toContain(
      "[redacted:SPARSE_CHECKOUT_TOKEN]",
    );
    expect(JSON.stringify(result.payload)).not.toContain(secret);
  } finally {
    delete process.env.SPARSE_CHECKOUT_TOKEN;
  }
});

// Usefulness: verifies acceptance 1 — init is read only, so the sparse settings stay unchanged.
// Not redundant: it compares the real repository before and after the init call.
test("init leaves the sparse checkout and the skip-worktree bits unchanged", async () => {
  const { linked } = await linkedWithInheritedSparse();
  const before = await trackedState(linked);

  const result = await initIn(linked);

  expect(result.exitCode).toBe(0);
  expect(await trackedState(linked)).toEqual(before);
  expect(await exists(join(linked, "excluded/two.txt"))).toBe(false);
});
