import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { executeRoleCommand } from "../src/role/index.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newCleanRunRepo,
  newRunRepo,
  readRepoState,
  repos,
  setup,
  withRepo,
} from "./role-helpers.mjs";
import { exists } from "./fs-helpers.mjs";
import { cleanRepoGit, createLinkedWithEnv, createLinkedWorkTree } from "./git-helpers.mjs";

// Answers `git` from memory for the reads that no case here asserts (see `cutRoleReads`). The copy's
// own reads reach the real `execa`, and so does every other command.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      const answer =
        gitDouble.answer && command === "git" ? gitDouble.answer(command, args, options) : null;
      return answer ?? real.execa(command, args, options);
    },
  };
});

// The Git reads that no case here asserts: the shared Git, lockfile, snapshot, and branch reads.
// Every other command, the copy's own reads included, passes through to the real `execa`.
const ROLE_READS = new Set([
  '["rev-parse","--is-inside-work-tree"]',
  '["rev-parse","--verify","-q","HEAD"]',
  '["symbolic-ref","--short","-q","HEAD"]',
  '["status","--porcelain=v1","-z","--untracked-files=all"]',
  '["ls-files","--stage","-z"]',
  '["ls-files","-z","--cached","--others","--exclude-standard"]',
  '["config","-z","--list","--show-scope"]',
  '["config","--get","branch.main.remote"]',
  '["remote","get-url","origin"]',
]);

/**
 * Answers the role-level reads from memory and passes every other command to real `git`. Each case
 * still copies from its own real linked work tree, so the copy's reads stay real.
 */
function cutRoleReads(command, args, options) {
  if (!ROLE_READS.has(JSON.stringify(args))) return undefined;
  return cleanRepoGit(command, args, options);
}

beforeEach(() => {
  gitDouble.answer = cutRoleReads;
});

afterEach(async () => {
  gitDouble.answer = null;
  await cleanup();
});

const SECRET = "TOKEN-VALUE-MUST-NOT-APPEAR";

const linkedWithEnv = () => createLinkedWithEnv(SECRET, repos);

// Usefulness: verifies acceptance 1 — an init on a linked work tree copies the
// file before the first child turn, and names it, with no content, in the
// envelope. The adapter reads the file inside the turn to prove the order.
// Not redundant: it runs the interactive init and reads the file inside the first child turn. The lib tests call the copy directly.
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
// Not redundant: it passes the opt-out flag on the interactive path and reads the state file. The CLI tests use the headless path.
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
// Not redundant: it is the refusal of a later call. The next test is the accepted repeat.
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
// Not redundant: it is the accepted repeat. The refusal test above would still pass if every later call that carries the flag were refused.
test("a later call may repeat the opt-out of an opted-out run", async () => {
  const linked = await newCleanRunRepo(gitDouble);
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
// Not redundant: it runs the init in the main work tree through the role path. The lib test calls the copy directly.
test("init in the main work tree copies nothing and reports nothing", async () => {
  const repo = await newRunRepo();
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
// Not redundant: it reads the transcript file. The envelope test does not.
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
// Not redundant: it runs an init that is refused. The other role tests run accepted inits.
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

const dispatchAgain = (linked) =>
  executeRoleCommand(withRepo(dispatchArgv([]), linked), basicDeps());

// Usefulness: verifies acceptance 2 — a local file that changed in the main work tree after init
// is named in the next dispatch envelope, with no content.
// Not redundant: no other test dispatches a second time after the main copy changed.
test("a later dispatch names a local file that changed in the main work tree", async () => {
  await setup();
  const { main, linked } = await linkedWithEnv();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), basicDeps());
  await writeFile(join(main, ".env"), "KEY=CHANGED-VALUE-MUST-NOT-APPEAR\n");

  const result = await dispatchAgain(linked);

  expect(result.exitCode).toBe(0);
  expect(result.payload.localFilesDiffer).toEqual([{ path: ".env", changed: "source" }]);
  expect(JSON.stringify(result.payload).includes("CHANGED-VALUE-MUST-NOT-APPEAR")).toBe(false);
});

// Usefulness: verifies the report names the copy when only a turn changed the copy.
// Not redundant: the other side tests change the main work tree, never the copy alone.
test("a later dispatch names a local file that a turn changed in the run work tree", async () => {
  await setup();
  const { main, linked } = await linkedWithEnv();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), basicDeps());
  await writeFile(join(linked, ".env"), "KEY=TURN-EDIT-MUST-NOT-APPEAR\n");

  const result = await dispatchAgain(linked);

  expect(result.exitCode).toBe(0);
  expect(result.payload.localFilesDiffer).toEqual([{ path: ".env", changed: "copy" }]);
  expect(JSON.stringify(result.payload).includes("TURN-EDIT-MUST-NOT-APPEAR")).toBe(false);
  expect((await readFile(join(main, ".env"), "utf8")) === `KEY=${SECRET}\n`).toBe(true);
});

// Usefulness: verifies the envelope stays unchanged while every copy still equals its source.
// Not redundant: it is the no-difference case of the test above.
test("a later dispatch reports nothing while the copies equal their sources", async () => {
  await setup();
  const { linked } = await linkedWithEnv();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), basicDeps());

  const result = await dispatchAgain(linked);

  expect(result.payload).not.toHaveProperty("localFilesDiffer");
});

// Usefulness: verifies acceptance 3 — the init hash stays in the state file and no hash or
// content reaches an envelope or a log line.
// Not redundant: it reads the stored hash and captures both console streams around the dispatch.
test("the init hash and the copied content never reach an envelope or a log line", async () => {
  await setup();
  const { main, linked } = await linkedWithEnv();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), basicDeps());
  const state = await readRepoState(linked);
  const hashes = Object.values(state.localFilesCopiedSha256 ?? {});
  expect(hashes.length === 1).toBe(true);
  expect(hashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))).toBe(
    true,
  );
  await writeFile(join(main, ".env"), "KEY=CHANGED-VALUE-MUST-NOT-APPEAR\n");
  const lines = [];
  const capture = (...args) => lines.push(args.map(String).join(" "));
  const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);
  let result;
  try {
    result = await dispatchAgain(linked);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const envelope = JSON.stringify(result.payload);
  expect(envelope.includes(hashes[0])).toBe(false);
  expect(envelope.includes("CHANGED-VALUE-MUST-NOT-APPEAR")).toBe(false);
  for (const line of lines) {
    expect(line.includes(hashes[0])).toBe(false);
    expect(line.includes("CHANGED-VALUE-MUST-NOT-APPEAR")).toBe(false);
  }
});

// Usefulness: verifies acceptance 3 — a copy that a turn changed is never overwritten, even when
// the main work tree changed too.
// Not redundant: it reads the copy after the dispatch that reported the difference.
test("a later dispatch never overwrites a copied file that a turn changed", async () => {
  await setup();
  const { main, linked } = await linkedWithEnv();
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), linked), basicDeps());
  await writeFile(join(linked, ".env"), "KEY=TURN-EDIT\n");
  await writeFile(join(main, ".env"), "KEY=MAIN-EDIT\n");

  const result = await dispatchAgain(linked);

  expect(result.payload.localFilesDiffer).toEqual([{ path: ".env", changed: "both" }]);
  expect((await readFile(join(linked, ".env"), "utf8")) === "KEY=TURN-EDIT\n").toBe(true);
});

// Usefulness: verifies a run that opted out of the copy never compares or reports files.
// Not redundant: it guards the opt-out path of the later-dispatch check.
test("a later dispatch of an opted-out run reports nothing", async () => {
  await setup();
  const { main, linked } = await linkedWithEnv();
  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--no-copy-local-files"]), linked),
    basicDeps(),
  );
  await writeFile(join(main, ".env"), "KEY=CHANGED\n");

  const result = await dispatchAgain(linked);

  expect(result.payload).not.toHaveProperty("localFilesDiffer");
});

// Usefulness: verifies acceptance 1 of issue #980 through the role init — the flag copies the
// ignored directory before the first turn, lists it in `localFiles.copied`, and stores the path
// so a later dispatch reports a changed copy in `localFilesDiffer`.
// Not redundant: the lib tests call the copy directly; this one runs the flag, the state, and the later dispatch.
test("--copy-local-path copies an ignored directory and later dispatches compare it", async () => {
  await setup();
  const { base, main, linked } = await createLinkedWorkTree({ ignore: ["specs/"] });
  repos.push(base);
  await mkdir(join(main, "specs"), { recursive: true });
  await writeFile(join(main, "specs", "api.json"), "{}\n");

  const init = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--copy-local-path", "specs"]), linked),
    basicDeps(),
  );

  expect(init.exitCode).toBe(0);
  expect(init.payload.localFiles.copied).toEqual(["specs/api.json"]);
  expect((await readRepoState(linked)).copyLocalPaths).toEqual(["specs"]);

  await writeFile(join(main, "specs", "api.json"), '{"v":2}\n');
  const later = await executeRoleCommand(
    withRepo(dispatchArgv(["--copy-local-path", "specs"]), linked),
    basicDeps(),
  );

  expect(later.exitCode).toBe(0);
  expect(later.payload.localFilesDiffer).toEqual([{ path: "specs/api.json", changed: "source" }]);
});

// Usefulness: verifies acceptance 2 of issue #980 — a tracked, absolute, or outside path is
// refused at init and no run state is written.
// Not redundant: it covers the refusal on the role path, including the error envelope.
test.each([["init.txt"], ["../outside"]])(
  "--copy-local-path %s is refused at init and leaves no run",
  async (path) => {
    await setup();
    const { linked } = await linkedWithEnv();

    const result = await executeRoleCommand(
      withRepo(dispatchArgv([...INIT_OVERRIDES, "--copy-local-path", path]), linked),
      basicDeps(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("--copy-local-path");
    await expect(readRepoState(linked)).rejects.toThrow();
  },
);

// Usefulness: verifies the extra paths are an init field — a later call that names other paths
// is refused, and the flag cannot join the opt-out.
// Not redundant: it covers the change refusal and the conflict, which the copy test does not.
test("--copy-local-path is fixed at init and conflicts with --no-copy-local-files", async () => {
  await setup();
  const { base, main, linked } = await createLinkedWorkTree({ ignore: ["specs/"] });
  repos.push(base);
  await mkdir(join(main, "specs"), { recursive: true });
  await writeFile(join(main, "specs", "api.json"), "{}\n");
  const conflict = await executeRoleCommand(
    withRepo(
      dispatchArgv([...INIT_OVERRIDES, "--copy-local-path", "specs", "--no-copy-local-files"]),
      linked,
    ),
    basicDeps(),
  );
  expect(conflict.exitCode).toBe(1);
  expect(conflict.payload.error).toContain("--no-copy-local-files");

  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--copy-local-path", "specs"]), linked),
    basicDeps(),
  );
  const changed = await executeRoleCommand(
    withRepo(dispatchArgv(["--copy-local-path", "other"]), linked),
    basicDeps(),
  );

  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--copy-local-path cannot be changed after init");
});

// Usefulness: verifies every init refusal of `--copy-local-path` happens before a state file is
// written or a child spawns: an untracked unignored path, a link out of the tree, and a tracked path
// with `--cwd` as the main work tree.
// Not redundant: the lib tests call the copy directly; this one proves the role init order.
test.each([
  ["an unignored path", "notes", "linked", "not ignored"],
  ["a link out of the tree", "escape", "linked", "link"],
  ["a tracked path in the main work tree", "init.txt", "main", "tracked"],
])("--copy-local-path %s is refused before any state or child", async (_n, path, cwdIs, text) => {
  await setup();
  const { base, main, linked } = await createLinkedWorkTree({ ignore: ["escape/"] });
  repos.push(base);
  await mkdir(join(main, "notes"), { recursive: true });
  await writeFile(join(main, "notes", "a.md"), "x\n");
  await mkdir(join(base, "outside"), { recursive: true });
  await symlink(
    join(base, "outside"),
    join(main, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const deps = basicDeps();
  let spawned = false;
  deps.agents.fake1.run = async () => {
    spawned = true;
    return "Conclusion: done\nWhy: ok\nBlockers: none";
  };
  const cwd = cwdIs === "main" ? main : linked;

  const result = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--copy-local-path", path]), cwd),
    deps,
  );

  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--copy-local-path");
  expect(result.payload.error).toContain(text);
  expect(spawned).toBe(false);
  await expect(readRepoState(cwd)).rejects.toThrow();
});
