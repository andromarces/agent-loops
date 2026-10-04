import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { executeRoleCommand } from "../src/role.mjs";
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
import { createLinkedWorkTree, createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

const SECRET = "TOKEN-VALUE-MUST-NOT-APPEAR";

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function linkedWithEnv() {
  const tree = await createLinkedWorkTree({ ignore: [".env"] });
  repos.push(tree.base);
  await writeFile(join(tree.main, ".env"), `KEY=${SECRET}\n`);
  return tree;
}

// Usefulness: verifies acceptance 1 — an init on a linked work tree copies the
// file before the first child turn, and names it, with no content, in the
// envelope. The adapter reads the file inside the turn to prove the order.
test("init copies a local file before the first child turn and names it in the envelope", async () => {
  await setup();
  const { linked } = await linkedWithEnv();
  let presentInTurn = null;
  const deps = basicDeps();
  deps.agents.fake1.run = async () => {
    presentInTurn = await exists(join(linked, ".env"));
    return "Conclusion: done\nWhy: ok\nBlockers: none";
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), deps);

  expect(result.exitCode).toBe(0);
  expect(presentInTurn).toBe(true);
  expect(result.payload.localFiles).toEqual({ copied: [".env"], skipped: [] });
  expect(JSON.stringify(result.payload)).not.toContain(SECRET);
  expect(JSON.stringify(await readRepoState(linked))).not.toContain(SECRET);
});

// Usefulness: verifies acceptance 4 — the opt-out copies nothing, adds no
// envelope key, and is recorded as the run's setting.
test("--no-copy-local-files copies nothing and records the setting", async () => {
  await setup();
  const { linked } = await linkedWithEnv();

  const result = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--no-copy-local-files"]), linked),
    basicDeps(),
  );

  expect(result.exitCode).toBe(0);
  expect(await exists(join(linked, ".env"))).toBe(false);
  expect(result.payload).not.toHaveProperty("localFiles");
  expect((await readRepoState(linked)).copyLocalFiles).toBe(false);
});

// Usefulness: verifies the opt-out is an init field — a later call that sets it
// on a run that copied is refused, like every other init field.
test("a later call cannot turn the copy off", async () => {
  await setup();
  const { linked } = await linkedWithEnv();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), basicDeps());

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--no-copy-local-files"]), linked),
    basicDeps(),
  );

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--no-copy-local-files cannot be changed after init");
});

// Usefulness: verifies a later call that repeats the opt-out of a run that
// opted out is accepted, the same as a repeated matching init field.
test("a later call may repeat the opt-out of an opted-out run", async () => {
  await setup();
  const { linked } = await linkedWithEnv();
  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--no-copy-local-files"]), linked),
    basicDeps(),
  );

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--no-copy-local-files"]), linked),
    basicDeps(),
  );

  expect(result.exitCode).toBe(0);
});

// Usefulness: verifies the main work tree as --cwd copies nothing, adds no
// envelope key, and changes no file.
test("init in the main work tree copies nothing and reports nothing", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await writeFile(join(repo, ".git", "info", "exclude"), ".env\n");
  await writeFile(join(repo, ".env"), "A=1\n");

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(INIT_OVERRIDES), repo),
    basicDeps(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.payload).not.toHaveProperty("localFiles");
  expect(await readFile(join(repo, ".env"), "utf8")).toBe("A=1\n");
});

// Usefulness: verifies the transcript records the copied and skipped names and
// never a file's content.
test("the transcript records names only", async () => {
  await setup();
  const { base, linked } = await linkedWithEnv();
  const transcript = join(base, "transcript.jsonl");

  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--transcript", transcript]), linked),
    basicDeps(),
  );

  const text = await readFile(transcript, "utf8");
  expect(text).toContain('"type":"local-files"');
  expect(text).toContain(".env");
  expect(text).not.toContain(SECRET);
});

// Usefulness: verifies a refused init (missing worker) copies nothing, so a
// rejected init leaves the work tree as it was.
test("a refused init copies nothing", async () => {
  await setup();
  const { linked } = await linkedWithEnv();

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--task", "x", "--parent-session", "p"]), linked),
    basicDeps(),
  );

  expect(result.exitCode).toBe(1);
  expect(await exists(join(linked, ".env"))).toBe(false);
});
