import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { SPAWNED_RUN_ENV } from "../src/lib/exec.mjs";
import { cwdHash } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role/index.mjs";
import { createLinkedWorkTree } from "./git-helpers.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  repos,
  setup,
  withRepo,
} from "./role-helpers.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});

const SECRET = "REFRESH-CONTENT-MUST-NOT-APPEAR";
const CONTENT = `KEY=${SECRET}\n`;

/** A linked work tree whose main checkout holds ignored files, then an initialized run. */
async function linkedRun(files = { ".env": CONTENT }, ignore = [".env"]) {
  await setup();
  const tree = await createLinkedWorkTree({
    ignore,
    seed: async (main) => {
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(dirname(join(main, rel)), { recursive: true });
        await writeFile(join(main, rel), content);
      }
    },
  });
  repos.push(tree.base);
  const init = await executeRoleCommand(
    withRepo(dispatchArgv(INIT_OVERRIDES), tree.linked),
    basicDeps(),
  );
  expect(init.exitCode).toBe(0);
  return tree;
}

const refreshArgv = (path, ...flags) => [
  "refresh-local",
  "--cwd",
  "<repo>",
  "--parent-session",
  "parent-sess-1",
  "--path",
  path,
  ...flags,
];

const refresh = (repo, path, ...flags) =>
  executeRoleCommand(withRepo(refreshArgv(path, ...flags), repo));

const dispatchAgain = (linked) =>
  executeRoleCommand(withRepo(dispatchArgv([]), linked), basicDeps());

const hashesOf = async (linked) => (await readRepoState(linked)).localFilesCopiedSha256;

// Usefulness: verifies acceptance — after a refresh, a later envelope does not report the path.
// Not redundant: it is the end-to-end behavior that the issue records.
test("a recorded refresh stops a later envelope from reporting the path", async () => {
  const { main, linked } = await linkedRun();
  await writeFile(join(main, ".env"), "KEY=CHANGED\n");
  expect((await dispatchAgain(linked)).payload.localFilesDiffer).toEqual([
    { path: ".env", changed: "source" },
  ]);

  const refreshed = await refresh(linked, ".env");

  expect(refreshed.exitCode).toBe(0);
  expect(refreshed.payload).toEqual({ status: "ok", lifecycle: "active", path: ".env" });
  expect((await dispatchAgain(linked)).payload).not.toHaveProperty("localFilesDiffer");
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("KEY=CHANGED\n");
});

// Usefulness: verifies the refresh stores the new hash only for the named path.
// Not redundant: the other tests use one copied file.
test("a refresh changes the stored hash only for the named path", async () => {
  const { main, linked } = await linkedRun({ ".env": CONTENT, ".envrc": "export A=1\n" }, [
    ".env",
    ".envrc",
  ]);
  const before = await hashesOf(linked);
  await writeFile(join(main, ".env"), "KEY=CHANGED\n");

  const refreshed = await refresh(linked, ".env");
  const after = await hashesOf(linked);

  expect(refreshed.exitCode).toBe(0);
  expect(after[".env"] !== before[".env"]).toBe(true);
  expect(after[".envrc"] === before[".envrc"]).toBe(true);
});

// Usefulness: verifies the command prints and returns neither content nor a hash.
// Not redundant: it captures both streams around the refresh.
test("the refresh reports no content and no hash", async () => {
  const { main, linked } = await linkedRun();
  const before = (await hashesOf(linked))[".env"];
  await writeFile(join(main, ".env"), "KEY=CHANGED\n");
  const lines = [];
  const capture = (...args) => lines.push(args.map(String).join(" "));
  const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);
  let refreshed;
  try {
    refreshed = await refresh(linked, ".env");
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  const after = (await hashesOf(linked))[".env"];
  const envelope = JSON.stringify(refreshed.payload);

  expect(refreshed.exitCode).toBe(0);
  expect(envelope.includes(SECRET) || envelope.includes(before) || envelope.includes(after)).toBe(
    false,
  );
  expect(
    lines.some((line) => line.includes(SECRET) || line.includes(before) || line.includes(after)),
  ).toBe(false);
});

// Usefulness: verifies a later edit or delete on either side is still reported after a refresh.
// Not redundant: it applies every side combination to the refreshed hash.
test("a later change on either side is still reported after a refresh", async () => {
  const { main, linked } = await linkedRun();
  const source = join(main, ".env");
  const copy = join(linked, ".env");
  const restore = async () => {
    await rm(source, { force: true });
    await rm(copy, { force: true });
    await writeFile(source, "KEY=CHANGED\n");
    await writeFile(copy, "KEY=CHANGED\n");
  };
  await writeFile(source, "KEY=CHANGED\n");
  expect((await refresh(linked, ".env")).exitCode).toBe(0);
  const cases = [
    ["source edit", async () => writeFile(source, "KEY=S\n"), "source"],
    ["source delete", async () => rm(source), "source"],
    ["copy edit", async () => writeFile(copy, "KEY=C\n"), "copy"],
    ["copy delete", async () => rm(copy), "copy"],
    [
      "both edit",
      async () => {
        await writeFile(source, "KEY=S\n");
        await writeFile(copy, "KEY=C\n");
      },
      "both",
    ],
    [
      "both delete",
      async () => {
        await rm(source);
        await rm(copy);
      },
      "both",
    ],
    [
      "source delete and copy edit",
      async () => {
        await rm(source);
        await writeFile(copy, "KEY=C\n");
      },
      "both",
    ],
    [
      "source edit and copy delete",
      async () => {
        await writeFile(source, "KEY=S\n");
        await rm(copy);
      },
      "both",
    ],
  ];
  for (const [name, change, changed] of cases) {
    await restore();
    await change();
    const result = await dispatchAgain(linked);
    expect(result.payload.localFilesDiffer, name).toEqual([{ path: ".env", changed }]);
  }
});

// Usefulness: verifies a path that init did not copy, an absolute path, and an escaping path.
// Each is refused with no state change.
// Not redundant: the accepted path tests never exercise the guards.
test("a refresh refuses an unknown, absolute, or escaping path and writes nothing", async () => {
  const { main, linked } = await linkedRun();
  const before = await readRepoState(linked);
  const cases = ["notes.txt", join(main, ".env"), "../main/.env"];
  for (const path of cases) {
    const result = await refresh(linked, path);
    expect(result.exitCode, path).toBe(1);
    expect(result.payload.error, path).toContain("refresh-local");
  }
  const after = await readRepoState(linked);
  expect(after.lifecycle).toBe(before.lifecycle);
  expect(after.localFilesCopiedSha256[".env"] === before.localFilesCopiedSha256[".env"]).toBe(true);
});

// Usefulness: verifies a source or copy that is missing is refused, and the copy stays missing.
// Not redundant: it checks each missing side before the copy runs.
test("a refresh refuses a missing source and a missing copy", async () => {
  const { main, linked } = await linkedRun();
  const before = await readRepoState(linked);
  await rm(join(main, ".env"));
  const noSource = await refresh(linked, ".env");
  expect(noSource.exitCode).toBe(1);
  expect(noSource.payload.error).toContain("source is missing");
  const afterSource = await readRepoState(linked);
  expect(afterSource.localFilesCopiedSha256[".env"] === before.localFilesCopiedSha256[".env"]).toBe(
    true,
  );
  expect((await dispatchAgain(linked)).payload.localFilesDiffer).toEqual([
    { path: ".env", changed: "source" },
  ]);

  await writeFile(join(main, ".env"), "KEY=S\n");
  await rm(join(linked, ".env"));
  const noCopy = await refresh(linked, ".env");
  expect(noCopy.exitCode).toBe(1);
  expect(noCopy.payload.error).toContain("copy is missing");
  const afterCopy = await readRepoState(linked);
  expect(afterCopy.localFilesCopiedSha256[".env"] === before.localFilesCopiedSha256[".env"]).toBe(
    true,
  );
});

// Usefulness: verifies an unreadable source is refused before the copy changes.
// Not redundant: the missing-source test removes the file instead.
test("a refresh refuses an unreadable source", async () => {
  const { main, linked } = await linkedRun();
  await rm(join(main, ".env"));
  await mkdir(join(main, ".env"));

  const result = await refresh(linked, ".env");

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("source is missing or unreadable");
});

// Usefulness: verifies a copy that a turn changed after init is refused, so the refresh cannot
// hide a breach.
// Not redundant: the documented action allows a refresh only when the copy holds no turn edit.
test("a refresh refuses a copy that changed after init", async () => {
  const { main, linked } = await linkedRun();
  const before = await readRepoState(linked);
  await writeFile(join(linked, ".env"), "KEY=TURN-EDIT\n");
  await writeFile(join(main, ".env"), "KEY=CHANGED\n");

  const result = await refresh(linked, ".env");

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("copy changed after init");
  const after = await readRepoState(linked);
  expect(after.localFilesCopiedSha256[".env"] === before.localFilesCopiedSha256[".env"]).toBe(true);
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("KEY=TURN-EDIT\n");
});

// Usefulness: verifies a link at the source file, the copy file, and a parent component.
// Each is refused without reading or writing through it.
// Not redundant: each level and side has its own guard in the copy path.
test("a refresh refuses a link at either file or at a parent component", async () => {
  const { main, linked, base } = await linkedRun(
    { ".env": CONTENT, ".vscode/settings.json": "{}\n" },
    [".env", ".vscode/settings.json"],
  );
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "settings.json"), "OUTSIDE\n");
  const dirLink = process.platform === "win32" ? "junction" : "dir";
  const before = await readRepoState(linked);

  await rename(join(main, ".env"), join(main, ".env-real"));
  await symlink(join(outside, "settings.json"), join(main, ".env"));
  expect((await refresh(linked, ".env")).payload.error).toContain(
    "source is missing or unreadable",
  );
  expect(await readFile(join(linked, ".env"), "utf8")).toBe(CONTENT);
  await rm(join(main, ".env"));
  await rename(join(main, ".env-real"), join(main, ".env"));

  await rename(join(linked, ".env"), join(linked, ".env-real"));
  await symlink(join(outside, "settings.json"), join(linked, ".env"));
  expect((await refresh(linked, ".env")).payload.error).toContain("copy is missing or unreadable");
  expect(await readFile(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE\n");
  await rm(join(linked, ".env"));
  await rename(join(linked, ".env-real"), join(linked, ".env"));

  await rename(join(main, ".vscode"), join(main, ".vscode-real"));
  await symlink(outside, join(main, ".vscode"), dirLink);
  expect((await refresh(linked, ".vscode/settings.json")).exitCode).toBe(1);
  expect(await readFile(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE\n");
  await rm(join(main, ".vscode"));
  await rename(join(main, ".vscode-real"), join(main, ".vscode"));

  await rename(join(linked, ".vscode"), join(linked, ".vscode-real"));
  await symlink(outside, join(linked, ".vscode"), dirLink);
  expect((await refresh(linked, ".vscode/settings.json")).exitCode).toBe(1);
  expect(await readFile(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE\n");
  const after = await readRepoState(linked);
  expect(after.localFilesCopiedSha256[".env"] === before.localFilesCopiedSha256[".env"]).toBe(true);
  expect(
    after.localFilesCopiedSha256[".vscode/settings.json"] ===
      before.localFilesCopiedSha256[".vscode/settings.json"],
  ).toBe(true);
});

// Usefulness: verifies the guards that extend and declare-pr share: terminal run, missing run,
// wrong parent session, missing parent flag, and a spawned child run.
// Not redundant: the refresh tests above use an active run and the stored id.
test("a refresh applies the parent and lifecycle guards", async () => {
  const { linked } = await linkedRun();
  const other = await createLinkedWorkTree({ ignore: [".env"] });
  repos.push(other.base);

  const missing = await refresh(other.linked, ".env");
  expect(missing.payload.error).toContain("No run state");

  const wrong = await refresh(linked, ".env", "--parent-session", "other-sess");
  expect(wrong.payload.error).toBe("--parent-session does not match the run's parent session.");
  expect(JSON.stringify(wrong.payload)).not.toContain("parent-sess-1");

  const noFlag = await executeRoleCommand(
    withRepo(["refresh-local", "--cwd", "<repo>", "--path", ".env"], linked),
  );
  expect(noFlag.payload.error).toContain("refresh-local requires --parent-session");

  vi.stubEnv(SPAWNED_RUN_ENV, cwdHash(linked));
  const child = await refresh(linked, ".env");
  expect(child.payload.error).toContain("child role");
  vi.stubEnv(SPAWNED_RUN_ENV, "");

  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], linked));
  const ended = await refresh(linked, ".env");
  expect(ended.payload.error).toBe("Run is already aborted.");
});
