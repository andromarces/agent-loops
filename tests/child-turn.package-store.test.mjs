import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import {
  changedInPackageStore,
  failedPackageStoreEntries,
  snapshotPackageStore,
} from "../src/lib/package-store-entries.mjs";
import { failedInheritedTmpdirEntries } from "../src/lib/inherited-tmpdir-entries.mjs";
import { ExecError } from "../src/lib/exec.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

let repo;
let store;
const modulesFile = () => join(repo, "node_modules", ".modules.yaml");
const record = async (text) => {
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(modulesFile(), text);
};
const recordStore = (dir) => record(JSON.stringify({ storeDir: dir }, null, 2));
beforeEach(async () => {
  repo = await createTempRepo();
  store = await mkdtemp(join(tmpdir(), "package-store-"));
  for (const dir of ["links", "projects", "files"]) {
    await mkdir(join(store, "v11", dir), { recursive: true });
  }
  await writeFile(join(store, "v11", "index.db"), "index");
  await recordStore(join(store, "v11"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removePath(repo);
  await removePath(store);
});

const turn = (roleName, act) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName,
    prompt: "go",
    cwd: repo,
  });

const install = async () => {
  await mkdir(join(store, "v11", "projects", "hash1"));
  await mkdir(join(store, "v11", "links", "@scope"));
  await writeFile(join(store, "v11", "index.db"), "index grew");
};
const INSTALL_NAMES = ["v11/index.db", "v11/links/@scope", "v11/projects/hash1"];

// Usefulness: verifies acceptance #1045 — a reviewer turn that writes to the package store reports
// the names that changed, because the mutation check cannot see a write outside the repository.
test("an ok reviewer turn reports a package store change by name", async () => {
  const result = await turn("reviewer", async () => {
    await install();
    return "done";
  });
  expect(result.status).toBe("ok");
  expect(result.packageStoreEntries).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies the failed turn reports it too, because a failed install is the turn most
// likely to leave a half-written store.
test("an error reviewer turn reports a package store change by name", async () => {
  const result = await turn("reviewer", async () => {
    await install();
    throw new Error("adapter failed");
  });
  expect(result.status).toBe("error");
  expect(result.packageStoreEntries).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies acceptance #1045 — a turn with no store change carries no field.
test("a reviewer turn that changed no package store entry carries no field", async () => {
  const result = await turn("reviewer", async () => "done");
  expect(result).not.toHaveProperty("packageStoreEntries");
});

// Usefulness: verifies the report is reviewer-only, because a worker legitimately installs.
test("a worker turn carries no field", async () => {
  const result = await turn("worker", async () => {
    await install();
    return "done";
  });
  expect(result).not.toHaveProperty("packageStoreEntries");
});

// Usefulness: verifies the list is bounded, because a large install adds thousands of names.
test("the report names at most 20 entries, sorted", async () => {
  const result = await turn("reviewer", async () => {
    for (let i = 0; i < 30; i++) {
      await mkdir(join(store, "v11", "links", `pkg-${String(i).padStart(2, "0")}`));
    }
    return "done";
  });
  expect(result.packageStoreEntries).toHaveLength(20);
  expect(result.packageStoreEntries[0]).toBe("v11/links/pkg-00");
  expect(result.packageStoreEntries).toEqual([...result.packageStoreEntries].sort());
});

// Usefulness: verifies the read is bounded in size, because the store grows without limit. A
// directory over the scan limit is not read, so the snapshot is null and no turn fails on it.
test("a directory over the scan limit is left unread", async () => {
  for (let i = 0; i < 8; i++) await mkdir(join(store, "v11", "links", `pkg-${i}`));
  expect(await snapshotPackageStore({ cwd: repo, scanLimit: 5 })).toBeNull();
  expect(await snapshotPackageStore({ cwd: repo, scanLimit: 50 })).not.toBeNull();
});

// Usefulness: verifies a host with no package store reports nothing and fails nothing.
test("a missing package store carries no field", async () => {
  await recordStore(join(store, "absent", "v11"));
  const result = await turn("reviewer", async () => "done");
  expect(result.status).toBe("ok");
  expect(result).not.toHaveProperty("packageStoreEntries");
});

// Usefulness: verifies requirement "a fatal reviewer error carries the entries": a mutation ends
// the turn by a throw, and the entries must still reach the dispatcher.
test("a reviewer mutation error carries the package store entries", async () => {
  const error = await turn("reviewer", async () => {
    await install();
    await writeFile(join(repo, "leak.txt"), "leak\n");
    return "done";
  }).catch((err) => err);
  expect(error).toBeInstanceOf(MutationError);
  expect(failedPackageStoreEntries(error)).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies the same for a cancel, which ends the turn by a different throw.
test("a canceled reviewer turn carries the package store entries", async () => {
  const error = await turn("reviewer", async () => {
    await install();
    throw new ExecError("canceled", { isCanceled: true });
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedPackageStoreEntries(error)).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies a fatal error that cannot take a property still carries the entries.
test("a frozen fatal error still carries the package store entries", async () => {
  const fatal = Object.freeze(Object.assign(new Error("fatal"), { name: "MutationError" }));
  const error = await turn("reviewer", async () => {
    await install();
    throw fatal;
  }).catch((err) => err);
  expect(error).toBe(fatal);
  expect(failedPackageStoreEntries(error)).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies requirement "a cancel ends the turn as a cancel on every path" (issue #1045):
// a reviewer turn that fails while its signal is aborted must propagate the cancel, because a
// handled-error result would record a canceled turn as a failed one.
test("a reviewer turn that fails after a cancel ends as a cancel", async () => {
  const controller = new AbortController();
  const error = await runChild({
    agents: {
      fake: scripted([
        async () => {
          await install();
          controller.abort();
          throw new Error("adapter failed");
        },
      ]),
    },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "go",
    cwd: repo,
    signal: controller.signal,
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  // The reads ran before the cancel check, so the cancel error carries what they found, as the
  // fatal path does, because the dispatcher builds its envelope and `lastResult` from the error.
  expect(failedPackageStoreEntries(error)).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies the sibling evidence on the same path (issue #1024): the entries that the
// turn left in the inherited temporary directory ride on the cancel error as well.
test("a reviewer turn that fails after a cancel carries the temporary directory entries", async () => {
  const temp = await mkdtemp(join(tmpdir(), "package-store-inherited-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temp);
  try {
    const controller = new AbortController();
    const error = await runChild({
      agents: {
        fake: scripted([
          async () => {
            await mkdir(join(temp, "m54-3db54ca8"));
            controller.abort();
            throw new Error("adapter failed");
          },
        ]),
      },
      role: { kind: "fake", sessionId: null },
      roleName: "reviewer",
      prompt: "go",
      cwd: repo,
      signal: controller.signal,
    }).catch((err) => err);
    expect(error).toMatchObject({ isCanceled: true });
    expect(failedInheritedTmpdirEntries(error)).toEqual(["m54-3db54ca8"]);
  } finally {
    await removePath(temp);
  }
});

// Usefulness: verifies the narrowed contract (issue #1045): the field names changes in the store
// that the `node_modules/.modules.yaml` of the work tree records as `storeDir`, and any other
// case gives no field. It never claims that the reviewer's install used that store.
describe("the store that the work tree recorded", () => {
  const installed = async () => {
    await install();
    return "done";
  };

  test("is read when the file names it", async () => {
    await recordStore(join(store, "v11"));
    const result = await turn("reviewer", installed);
    expect(result.packageStoreEntries).toEqual(INSTALL_NAMES);
  });

  // Usefulness: verifies the field does not predict the store of a later install: an environment
  // variable that selects another store changes nothing, because the field only reports changes
  // in the recorded store, whoever made them.
  test("is read whatever the environment selects for a later install", async () => {
    vi.stubEnv("pnpm_config_store_dir", join(store, "elsewhere"));
    vi.stubEnv("PNPM_HOME", join(store, "elsewhere"));
    vi.stubEnv("XDG_DATA_HOME", join(store, "elsewhere"));
    vi.stubEnv("XDG_CONFIG_HOME", join(store, "elsewhere"));
    const result = await turn("reviewer", installed);
    expect(result.packageStoreEntries).toEqual(INSTALL_NAMES);
  });

  test.each([
    ["is absent", () => removePath(join(repo, "node_modules"))],
    ["names no store", () => record('{ "layoutVersion": 5 }')],
    // pnpm 12.11.2 writes JSON. Metadata that does not parse as JSON gives no field.
    [
      "is malformed JSON",
      () =>
        record(`{
  "storeDir": ${JSON.stringify(join(store, "v11"))},
  "list": [
`),
    ],
    [
      "is plain YAML",
      () =>
        record(`layoutVersion: 5
storeDir: ${join(store, "v11")}
`),
    ],
    ["names a relative store", () => record('{ "storeDir": "relative/store" }')],
    [
      "is a directory",
      async () => {
        await removePath(modulesFile());
        await mkdir(modulesFile());
      },
    ],
    [
      "is over the byte cap",
      () => record(`{ "storeDir": ${JSON.stringify(join(store, "v11"))} }${" ".repeat(2 << 20)}`),
    ],
  ])("gives no field when the file %s", async (_name, arrange) => {
    await arrange();
    const result = await turn("reviewer", installed);
    expect(result.status).toBe("ok");
    expect(result).not.toHaveProperty("packageStoreEntries");
  });

  // Usefulness: verifies the reported case: an unused default store that changes during the turn
  // gives no field when the work tree recorded another store.
  test("gives no field for a change in an unused default store", async () => {
    const home = await mkdtemp(join(tmpdir(), "package-store-home-"));
    try {
      for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, home);
      vi.stubEnv("LOCALAPPDATA", join(home, "AppData", "Local"));
      vi.stubEnv("XDG_DATA_HOME", undefined);
      const unused = [
        join(home, "AppData", "Local", "pnpm", "store"),
        join(home, "Library", "pnpm", "store"),
        join(home, ".local", "share", "pnpm", "store"),
      ];
      for (const root of unused) await mkdir(join(root, "v11", "projects"), { recursive: true });
      await recordStore(join(store, "v11"));
      const result = await turn("reviewer", async () => {
        for (const root of unused) await mkdir(join(root, "v11", "projects", "hash9"));
        return "done";
      });
      expect(result).not.toHaveProperty("packageStoreEntries");
    } finally {
      await removePath(home);
    }
  });
});

// Usefulness: verifies requirement "the after-read runs on a cancel too, under its own bound"
// (issue #1045): a canceled reviewer turn keeps the field, as `inheritedTmpdirEntries` does, even
// though the turn signal is aborted.
test("a canceled reviewer turn with an aborted signal still carries the entries", async () => {
  const controller = new AbortController();
  const error = await runChild({
    agents: {
      fake: scripted([
        async () => {
          await install();
          controller.abort();
          throw new ExecError("canceled", { isCanceled: true });
        },
      ]),
    },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "go",
    cwd: repo,
    signal: controller.signal,
  }).catch((err) => err);
  expect(error).toMatchObject({ isCanceled: true });
  expect(failedPackageStoreEntries(error)).toEqual(INSTALL_NAMES);
});

// Usefulness: verifies the size bound covers the root directory too, because the root listing is
// a directory read like any other.
test("a store root over the scan limit is left unread", async () => {
  for (let i = 0; i < 8; i++) await mkdir(join(store, `entry-${i}`));
  expect(await snapshotPackageStore({ cwd: repo, scanLimit: 5 })).toBeNull();
});

// Usefulness: verifies requirement "a snapshot keeps its root" (issue #1045): a recorded store that
// changes between the two reads must give no field, because the two reads saw different stores
// and every entry would read as added or removed.
test("a recorded store that changes between the reads gives no field", async () => {
  const other = await mkdtemp(join(tmpdir(), "package-store-other-"));
  try {
    await mkdir(join(other, "v11", "projects", "unrelated"), { recursive: true });
    const before = await snapshotPackageStore({ cwd: repo });
    await recordStore(join(other, "v11"));
    expect(await changedInPackageStore(before, { cwd: repo })).toEqual([]);
    await recordStore(join(store, "v11"));
    await mkdir(join(store, "v11", "projects", "hash1"));
    expect(await changedInPackageStore(before, { cwd: repo })).toEqual(["v11/projects/hash1"]);
  } finally {
    await removePath(other);
  }
});
